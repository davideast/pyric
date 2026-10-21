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
 * Discovery's health probes and the register beacon both go through
 * {@link boundedRequest}. The http modules load on first use, so a runtime
 * without them loses the request only, never the importing module.
 */
import type { IncomingMessage, OutgoingHttpHeaders, request as httpRequestFn } from 'node:http';
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
}

export interface BoundedResponse {
  readonly status: number;
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
 * an error, a body past {@link MAX_RESPONSE_BYTES}, a url the http module
 * rejects, or the deadline passing. Never rejects. Redirects are not followed:
 * a 3xx is returned as its own status. No agent is used, and the socket is
 * destroyed when the result settles, so nothing outlives the call.
 */
export function boundedRequest(url: string, options: BoundedRequestOptions): Promise<BoundedResponse | null> {
  return new Promise((resolve) => {
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
      req.destroy();
      resolve(result);
    };
    const deadline = setTimeout(() => finish(null), options.deadlineMs);
    if (options.unref) {
      deadline.unref();
      req.on('socket', (socket) => socket.unref());
    }
    req.on('error', () => finish(null));
    req.on('response', (res: IncomingMessage) => {
      res.on('error', () => finish(null));
      void readBody(res, MAX_RESPONSE_BYTES).then((body) => {
        const hasBody = body !== null;
        finish(hasBody ? { status: res.statusCode ?? 0, body } : null);
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
