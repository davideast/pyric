/**
 * Sends one probe request and records the response the same way for
 * production (the capture harness) and for pyric (the conformance suite), so
 * the two sides of a row differ only in what answered.
 */
import {
  RECORDED_RESPONSE_HEADERS,
  type ProbeRequest,
  type ProbeResponse,
} from './probe-types.ts';

const DEFAULT_CLIENT_TIMEOUT_MS = 30_000;

/** The production regions and project a request URL is built from. */
export interface ProbeTargets {
  /** The base a `cloudfunctions` request's function name is appended to, per region. */
  functionBase(region: string): string;
  /** The base a `run` request's path is appended to, per function name. */
  runBase(functionName: string, region: string): string;
  /** The base a `hosting` request's path is appended to. */
  hostingBase(): string;
}

export function probeUrl(request: ProbeRequest, targets: ProbeTargets): string {
  const region = request.region ?? 'us-central1';
  const path = request.path ?? '';
  if (request.via === 'hosting') return `${targets.hostingBase()}${path}`;
  if (request.via === 'run') return `${targets.runBase(request.function, region)}${path}`;
  return `${targets.functionBase(region)}/${request.function}${path}`;
}

/** A base64 body goes as a Blob with no type, so fetch adds no content-type the probe did not set. */
function requestBody(request: ProbeRequest): Blob | string | undefined {
  if (request.bodyBase64 !== undefined) return new Blob([Buffer.from(request.bodyBase64, 'base64')]);
  return request.body;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function recordHeaders(headers: Headers): Pick<ProbeResponse, 'headerNames' | 'headers'> {
  const names = new Set<string>();
  headers.forEach((_value, name) => names.add(name.toLowerCase()));
  const headerNames = [...names].sort();
  const recorded: Record<string, string> = {};
  for (const name of RECORDED_RESPONSE_HEADERS) {
    const value = name === 'set-cookie' ? headers.getSetCookie().join('\n') : headers.get(name);
    if (value) recorded[name] = value;
  }
  return { headerNames, headers: recorded };
}

function failure(error: unknown, startedAt: number, timedOut: boolean): ProbeResponse {
  const name = timedOut ? 'timeout' : error instanceof Error ? error.name : 'Error';
  return {
    status: null,
    headerNames: [],
    headers: {},
    body: '',
    json: null,
    elapsedMs: Date.now() - startedAt,
    error: name === 'TypeError' ? 'socket' : name,
  };
}

export async function sendProbeRequest(url: string, request: ProbeRequest): Promise<ProbeResponse> {
  if (request.delayBeforeMs) await new Promise((resolve) => setTimeout(resolve, request.delayBeforeMs));
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: request.method ?? 'GET',
      headers: request.headers ?? {},
      body: requestBody(request),
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      ...recordHeaders(response.headers),
      body,
      json: parseJson(body),
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return failure(error, startedAt, timedOut);
  } finally {
    clearTimeout(timer);
  }
}

/** Every request of one probe, in order, keyed by request id. */
export async function sendProbe(
  requests: readonly ProbeRequest[],
  targets: ProbeTargets,
): Promise<Record<string, ProbeResponse>> {
  const responses: Record<string, ProbeResponse> = {};
  for (const request of requests) {
    responses[request.id] = await sendProbeRequest(probeUrl(request, targets), request);
  }
  return responses;
}
