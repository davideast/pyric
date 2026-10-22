/**
 * The shapes every `probes/functions-http/` record shares with the capture
 * harness and the local conformance suite. A probe owns its requests and its
 * projection; the harness sends the requests to production and the suite sends
 * the same requests to pyric, and both freeze or compare what the projection
 * returns.
 */

/**
 * Where a request goes:
 * - `cloudfunctions`: `https://{region}-{project}.cloudfunctions.net/{function}{path}` in
 *   production, the emulator path `/{project}/{region}/{function}{path}` in pyric.
 * - `run`: the function's Cloud Run `*.a.run.app` URL plus `path` in production
 *   (v2 only), the same emulator path in pyric.
 * - `hosting`: `path` on the Hosting preview channel in production, `path` on the
 *   pyric server in pyric (a firebase.json rewrite).
 */
export type ProbeVia = 'cloudfunctions' | 'run' | 'hosting';

export interface ProbeRequest {
  /** Stable key the projection reads the response by. */
  id: string;
  /** The export name the request targets; unused for `hosting`. */
  function: string;
  /** The function's region; `us-central1` when omitted. */
  region?: string;
  via: ProbeVia;
  method?: string;
  /** The path after the function name (or the full path for `hosting`), with its query. */
  path?: string;
  headers?: Record<string, string>;
  /** A UTF-8 request body. */
  body?: string;
  /** A binary request body, base64-encoded. */
  bodyBase64?: string;
  /** Abort the request after this long; the response then records `error: 'timeout'`. */
  clientTimeoutMs?: number;
  /** Wait this long before sending, after the previous request finished. */
  delayBeforeMs?: number;
}

/** One response as the harness and the suite record it. */
export interface ProbeResponse {
  status: number | null;
  /** Lowercased response header names, sorted. */
  headerNames: string[];
  /** Values of the response headers a projection may read. */
  headers: Record<string, string>;
  body: string;
  /** `body` parsed as JSON when it parses. */
  json: unknown;
  elapsedMs: number;
  /** Set when no complete response arrived: `timeout`, `socket`, or the fetch error name. */
  error: string | null;
}

/** Response headers whose values are recorded; every other header is recorded by name only. */
export const RECORDED_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'location',
  'set-cookie',
  'vary',
  'x-powered-by',
  'x-pyric-custom',
  'transfer-encoding',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-max-age',
  'www-authenticate',
];

export interface FunctionsHttpProbe {
  name: string;
  matrixRow: string;
  rowIds: string[];
  description: string;
  requests: ProbeRequest[];
  behavior(responses: Record<string, ProbeResponse>): Record<string, unknown>;
}

/** The handler's own report of the request it saw (`echo` in the fixture). */
export interface EchoReport {
  instanceId: string;
  method: string;
  url: string;
  path: string;
  originalUrl: string;
  baseUrl: string;
  query: Record<string, unknown>;
  headerNames: string[];
  headerValues: Record<string, string>;
  bodyType: string;
  body: unknown;
  rawBody: string | null;
}

export function echoOf(response: ProbeResponse): EchoReport {
  return response.json as EchoReport;
}

/** The status, content type, and body text of a response, for rows that compare all three. */
export function statusShape(response: ProbeResponse): Record<string, unknown> {
  return {
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    body: response.body,
    error: response.error,
  };
}

/** The CORS answer a response carries, and the method the handler saw if it ran. */
export function corsShape(response: ProbeResponse): Record<string, unknown> {
  return {
    status: response.status,
    allowOrigin: response.headers['access-control-allow-origin'] ?? null,
    allowMethods: response.headers['access-control-allow-methods'] ?? null,
    allowHeaders: response.headers['access-control-allow-headers'] ?? null,
    vary: response.headers.vary ?? null,
    reachedHandlerAs: (response.json as EchoReport | null)?.method ?? null,
  };
}
