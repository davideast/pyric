/**
 * Non-streaming callable invocation (`callAtURL`), matching
 * `@firebase/functions` 0.14.0.
 */
import { errorForResponse, FunctionsError } from './errors.js';
import { decode, encode } from './serializer.js';
import type { HttpsCallableOptions, HttpsCallableResult } from './types.js';
import type { ResolvedCallableTarget } from './url.js';

const DEFAULT_TIMEOUT_MS = 70_000;

export type FunctionsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CallableExecutionContext {
  resolveTarget(): Promise<ResolvedCallableTarget>;
  buildHeaders(limitedUseAppCheckTokens: boolean | undefined): Promise<Record<string, string>>;
  fetchImpl: FunctionsFetch;
  cancelAllRequests: Promise<void>;
}

interface PostJsonResult {
  status: number;
  json: Record<string, unknown> | null;
}

function failAfter(millis: number): { promise: Promise<never>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new FunctionsError('deadline-exceeded', 'deadline-exceeded'));
    }, millis);
  });
  return {
    promise,
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
      }
    },
  };
}

async function postJSON(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  fetchImpl: FunctionsFetch,
): Promise<PostJsonResult> {
  const requestHeaders: Record<string, string> = {
    ...headers,
    'Content-Type': 'application/json',
  };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: requestHeaders,
    });
  } catch {
    return { status: 0, json: null };
  }

  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/**
 * Executes a single JSON callable POST, racing `options.timeout` (default 70 s)
 * and service deletion.
 */
export async function executeCallable<RequestData, ResponseData>(
  context: CallableExecutionContext,
  rawData: RequestData | null | undefined,
  options: HttpsCallableOptions,
): Promise<HttpsCallableResult<ResponseData>> {
  const encodedData = encode(rawData);
  const body = { data: encodedData };
  const target = await context.resolveTarget();
  const headers = await context.buildHeaders(options.limitedUseAppCheckTokens);

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof options.timeout === 'number' && options.timeout > 0) {
    timeoutMs = options.timeout;
  }
  const timer = failAfter(timeoutMs);
  let response: PostJsonResult | void;
  try {
    response = await Promise.race([
      postJSON(target.fetchUrl, body, headers, context.fetchImpl),
      timer.promise,
      context.cancelAllRequests,
    ]);
  } finally {
    timer.cancel();
  }

  if (!response) {
    throw new FunctionsError('cancelled', 'Firebase Functions instance was deleted.');
  }

  const responseError = errorForResponse(response.status, response.json, target.reportedUrl);
  if (responseError !== null) {
    throw responseError;
  }
  if (!response.json) {
    throw new FunctionsError(
      'internal',
      'Response is not valid JSON object.',
      undefined,
      target.reportedUrl,
    );
  }

  let responseData: unknown = response.json.data;
  if (responseData === undefined) {
    responseData = response.json.result;
  }
  if (responseData === undefined) {
    throw new FunctionsError(
      'internal',
      'Response is missing data field.',
      undefined,
      target.reportedUrl,
    );
  }

  return { data: decode(responseData) as ResponseData };
}
