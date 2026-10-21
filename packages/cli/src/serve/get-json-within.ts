/**
 * A GET whose whole life, connect included, ends at a deadline.
 *
 * `fetch` with `AbortSignal.timeout` is not that: the abort settles the
 * promise, but undici keeps a pending TCP connect until its own 10 s connect
 * timeout, and a pending connect holds the event loop open. Where a closed
 * port drops SYNs instead of refusing (WSL mirrored networking), every
 * discovery probe kept its process alive about 10 s after it gave up (#1162).
 * A `node:http` request can be destroyed at the deadline, which closes the
 * socket in any state.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** A 200 response's parsed JSON body. */
export interface JsonResponse {
  readonly body: unknown;
}

/**
 * GET `url` and parse a 200 response's body as JSON, within `deadlineMs` from
 * the call. `null` for anything else: a refused or dropped connect, a non-200
 * status, an unparseable body, or the deadline passing. The socket is
 * destroyed when the result settles, so nothing outlives the call.
 */
export function getJsonWithin(url: string, deadlineMs: number): Promise<JsonResponse | null> {
  return new Promise((resolve) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    let req: ClientRequest;
    try {
      // No agent: a pooled keep-alive socket would outlive the call.
      req = send(url, { method: 'GET', agent: false, headers: { accept: 'application/json' } });
    } catch {
      resolve(null);
      return;
    }
    const finish = (result: JsonResponse | null): void => {
      clearTimeout(deadline);
      req.destroy();
      resolve(result);
    };
    const deadline = setTimeout(() => finish(null), deadlineMs);
    req.on('error', () => finish(null));
    req.on('response', (res: IncomingMessage) => {
      const isOk = res.statusCode === 200;
      if (!isOk) {
        finish(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', () => finish(null));
      res.on('end', () => {
        try {
          finish({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
        } catch {
          finish(null);
        }
      });
    });
    req.end();
  });
}
