/**
 * Streaming callable invocation (`streamAtURL` and SSE frame reader), matching
 * `@firebase/functions` 0.14.0.
 */
import type { CallableExecutionContext } from './call.js';
import { errorForResponse, FunctionsError } from './errors.js';
import { decode, encode } from './serializer.js';
import type { HttpsCallableStreamOptions, HttpsCallableStreamResult } from './types.js';

const RESPONSE_LINE_RE = /^data: (.*?)(?:\n|$)/;

function rejectedStreamResult<ResponseData, StreamData>(
  error: FunctionsError,
): HttpsCallableStreamResult<ResponseData, StreamData> {
  const rejectedData = Promise.reject<ResponseData>(error);
  rejectedData.catch(() => undefined);
  return {
    data: rejectedData,
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(error);
          },
        };
      },
    },
  };
}

function createResponseStream<ResponseData, StreamData>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  resolveResult: (value: ResponseData) => void,
  rejectResult: (error: unknown) => void,
  signal: AbortSignal | undefined,
  reportedUrl: string,
): ReadableStream<StreamData> {
  const processLine = (
    line: string,
    controller: ReadableStreamDefaultController<StreamData>,
  ): void => {
    const match = RESPONSE_LINE_RE.exec(line);
    if (!match || match[1] === undefined) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }
      const jsonData = parsed as Record<string, unknown>;
      if ('result' in jsonData) {
        resolveResult(decode(jsonData.result) as ResponseData);
        return;
      }
      if ('message' in jsonData) {
        controller.enqueue(decode(jsonData.message) as StreamData);
        return;
      }
      if ('error' in jsonData) {
        const mapped = errorForResponse(0, jsonData, reportedUrl);
        let streamErr: FunctionsError;
        if (mapped !== null) {
          streamErr = mapped;
        } else {
          streamErr = new FunctionsError('internal', 'internal [0]', undefined, reportedUrl);
        }
        controller.error(streamErr);
        rejectResult(streamErr);
      }
    } catch (err: unknown) {
      if (err instanceof FunctionsError) {
        controller.error(err);
        rejectResult(err);
      }
    }
  };

  const decoder = new TextDecoder();
  return new ReadableStream<StreamData>({
    start(controller) {
      let currentText = '';
      const pump = async (): Promise<void> => {
        if (signal?.aborted) {
          const cancelled = new FunctionsError('cancelled', 'Request was cancelled');
          controller.error(cancelled);
          rejectResult(cancelled);
          return;
        }
        try {
          const { value, done } = await reader.read();
          if (done) {
            const trailing = currentText.trim();
            if (trailing.length > 0) {
              processLine(trailing, controller);
            }
            controller.close();
            return;
          }
          if (signal?.aborted) {
            const cancelled = new FunctionsError('cancelled', 'Request was cancelled');
            controller.error(cancelled);
            rejectResult(cancelled);
            await reader.cancel();
            return;
          }
          currentText += decoder.decode(value, { stream: true });
          const lines = currentText.split('\n');
          const remainder = lines.pop();
          if (remainder !== undefined) {
            currentText = remainder;
          } else {
            currentText = '';
          }
          for (const rawLine of lines) {
            const trimmed = rawLine.trim();
            if (trimmed.length > 0) {
              processLine(trimmed, controller);
            }
          }
          await pump();
        } catch (err: unknown) {
          let functionsErr: FunctionsError;
          if (err instanceof FunctionsError) {
            functionsErr = err;
          } else {
            const fallback = errorForResponse(0, null, reportedUrl);
            if (fallback !== null) {
              functionsErr = fallback;
            } else {
              functionsErr = new FunctionsError('internal', 'internal [0]', undefined, reportedUrl);
            }
          }
          controller.error(functionsErr);
          rejectResult(functionsErr);
        }
      };
      return pump();
    },
    cancel() {
      return reader.cancel();
    },
  });
}

/**
 * Executes a streaming callable POST (`Accept: text/event-stream`) with no
 * default deadline, yielding decoded `message` chunks and resolving `data`
 * from the terminal `result` frame.
 */
export async function executeCallableStream<RequestData, ResponseData, StreamData>(
  context: CallableExecutionContext,
  rawData: RequestData | null | undefined,
  options: HttpsCallableStreamOptions,
): Promise<HttpsCallableStreamResult<ResponseData, StreamData>> {
  const encodedData = encode(rawData);
  const body = { data: encodedData };
  const target = await context.resolveTarget();
  const authHeaders = await context.buildHeaders(options.limitedUseAppCheckTokens);
  const headers: Record<string, string> = {
    ...authHeaders,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  let response: Response;
  try {
    response = await context.fetchImpl(target.fetchUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
      signal: options.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return rejectedStreamResult(new FunctionsError('cancelled', 'Request was cancelled.'));
    }
    const networkErr = errorForResponse(0, null, target.reportedUrl);
    if (networkErr !== null) {
      return rejectedStreamResult(networkErr);
    }
    return rejectedStreamResult(
      new FunctionsError('internal', 'internal [0]', undefined, target.reportedUrl),
    );
  }

  if (response.status < 200 || response.status >= 300) {
    let errorBody: unknown = null;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = null;
    }
    const statusErr = errorForResponse(response.status, errorBody, target.reportedUrl);
    if (statusErr !== null) {
      return rejectedStreamResult(statusErr);
    }
  }

  if (!response.body) {
    return rejectedStreamResult(
      new FunctionsError('internal', 'Response body is missing.', undefined, target.reportedUrl),
    );
  }

  let resolveResult: (value: ResponseData) => void = () => {};
  let rejectResult: (reason: unknown) => void = () => {};
  const resultPromise = new Promise<ResponseData>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => undefined);

  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      rejectResult(new FunctionsError('cancelled', 'Request was cancelled.'));
    });
  }

  const reader = response.body.getReader();
  const responseStream = createResponseStream<ResponseData, StreamData>(
    reader,
    resolveResult,
    rejectResult,
    options.signal,
    target.reportedUrl,
  );

  return {
    stream: {
      [Symbol.asyncIterator]() {
        const streamReader = responseStream.getReader();
        return {
          async next() {
            const { value, done } = await streamReader.read();
            if (done) {
              return { value: undefined as unknown as StreamData, done: true };
            }
            return { value, done: false };
          },
          async return() {
            await streamReader.cancel();
            return { done: true, value: undefined as unknown as StreamData };
          },
        };
      },
    },
    data: resultPromise,
  };
}
