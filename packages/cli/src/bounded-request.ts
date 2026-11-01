/**
 * An HTTP request whose whole life, connect included, ends at a deadline.
 *
 * `fetch` with `AbortSignal.timeout` is not that: the abort settles the
 * promise, but undici keeps a pending TCP connect until its own 10 s connect
 * timeout, and a pending connect holds the event loop open. Where a closed
 * port drops SYNs instead of refusing (WSL mirrored networking), every
 * discovery probe kept its process alive about 10 s after it gave up (#1162).
 * A `node:http` request can be destroyed at the deadline, which closes the
 * socket in any state. `req.setTimeout()` is no substitute: it does not arm
 * until the `connect` event.
 *
 * Discovery's health probes and the register beacon go through
 * {@link boundedRequest}; the CLI's other local probes (snapshot, serve
 * diagnostics, the sandbox peer wait, the collision probe) go through its
 * fetch-shaped {@link boundedFetch} (#1167). The http modules load on first use, so a runtime
 * without them loses the request only, never the importing module.
 */
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, request as httpRequestFn } from 'node:http';
import { createRequire } from 'node:module';

/** The most response body a bounded request reads. Past it, the request gives up. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface BoundedRequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: string;
  /** Milliseconds from the call until the request is destroyed, connect included. */
  readonly deadlineMs: number;
  /**
   * Unref the socket and the deadline timer, so the request never holds the
   * process open. For fire-and-forget sends such as the beacon. A pending
   * connect holds the loop regardless of `socket.unref()`; the unref'd
   * deadline still ends it.
   */
  readonly unref?: boolean;
  /** The most response body to read. Past it, the request gives up. Defaults to {@link MAX_RESPONSE_BYTES}. */
  readonly maxBytes?: number;
  /** Ends the request early, as the deadline would. */
  readonly signal?: AbortSignal;
}

export interface BoundedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

type RequestFn = typeof httpRequestFn;

function requestFnFor(url: string): RequestFn {
  const require = createRequire(import.meta.url);
  const isHttps = url.startsWith('https:');
  const http = require(isHttps ? 'node:https' : 'node:http') as { request: RequestFn };
  return http.request;
}

/**
 * Collect a response body, or `null` past `maxBytes`. Resolves on `end`; the
 * caller's deadline and destroy cover a body that never ends or errors.
 */
function readBody(res: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      const isOverCap = total > maxBytes;
      if (isOverCap) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Send one request to `url` and read its response, all within
 * `options.deadlineMs` of the call. `null` for a refused or dropped connect,
 * an error, a body past `options.maxBytes`, a url the http module rejects, an
 * aborted `options.signal`, or the deadline passing. Never rejects. Redirects are not followed:
 * a 3xx is returned as its own status. No agent is used, and the socket is
 * destroyed when the result settles, so nothing outlives the call.
 */
export function boundedRequest(url: string, options: BoundedRequestOptions): Promise<BoundedResponse | null> {
  return new Promise((resolve) => {
    const signal = options.signal;
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    let req: ReturnType<RequestFn>;
    try {
      // No agent: a pooled keep-alive socket would outlive the call.
      req = requestFnFor(url)(url, { method: options.method ?? 'GET', headers: options.headers, agent: false });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (result: BoundedResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      req.destroy();
      resolve(result);
    };
    const deadline = setTimeout(() => finish(null), options.deadlineMs);
    const onAbort = (): void => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (options.unref) {
      deadline.unref();
      req.on('socket', (socket) => socket.unref());
    }
    req.on('error', () => finish(null));
    req.on('response', (res: IncomingMessage) => {
      res.on('error', () => finish(null));
      void readBody(res, options.maxBytes ?? MAX_RESPONSE_BYTES).then((body) => {
        const hasBody = body !== null;
        finish(hasBody ? { status: res.statusCode ?? 0, headers: res.headers, body } : null);
      });
    });
    req.end(options.body);
  });
}

/** A 200 response's parsed JSON body. */
export interface JsonResponse {
  readonly body: unknown;
}

/**
 * GET `url` and parse a 200 response's body as JSON, within `deadlineMs`.
 * `null` for any other outcome, a redirect included: discovery probes
 * loopback hosts that answer directly. See {@link boundedRequest}.
 */
export async function getJsonWithin(url: string, deadlineMs: number): Promise<JsonResponse | null> {
  const response = await boundedRequest(url, { headers: { accept: 'application/json' }, deadlineMs });
  const isOk = response !== null && response.status === 200;
  if (!isOk) return null;
  try {
    return { body: JSON.parse(response.body.toString('utf8')) as unknown };
  } catch {
    return null;
  }
}

/** Options for {@link boundedFetch}: a bounded request plus fetch's redirect mode. */
export interface BoundedFetchOptions extends BoundedRequestOptions {
  /**
   * Redirects are never followed. `'error'` rejects on a 3xx, as fetch does;
   * `'manual'`, the default, returns it.
   */
  readonly redirect?: 'error' | 'manual';
}

/** Statuses whose `Response` must have a null body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function headersOf(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const values = Array.isArray(value) ? value : [value];
    for (const one of values) {
      const isPresent = one !== undefined;
      if (isPresent) headers.append(name, one);
    }
  }
  return headers;
}

/**
 * {@link boundedRequest} in fetch's shape, for code written against `fetch`
 * and its injectable `fetchImpl` seams. Resolves a `Response` whose body is
 * already read, and rejects with a `TypeError` where `boundedRequest` gives
 * `null`, as `fetch` rejects on a network error or an abort.
 */
export async function boundedFetch(input: string | URL, options: BoundedFetchOptions): Promise<Response> {
  const url = String(input);
  const response = await boundedRequest(url, options);
  if (response === null) throw new TypeError(`fetch failed: ${url}`);
  const { status } = response;
  const isRedirect = status >= 300 && status < 400;
  const refusesRedirect = isRedirect && options.redirect === 'error';
  if (refusesRedirect) throw new TypeError(`fetch failed: ${url} redirected`);
  const isConstructible = status >= 200 && status <= 599;
  if (!isConstructible) throw new TypeError(`fetch failed: ${url} answered ${status}`);
  const body = NULL_BODY_STATUSES.has(status) ? null : new Uint8Array(response.body);
  return new Response(body, { status, headers: headersOf(response.headers) });
}
