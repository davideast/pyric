/**
 * Production refuses a function whose invoker is not 'public', such as
 * `invoker: 'private'` or a service account, to any caller without an IAM
 * identity that it names. pyric serves it without one (functions-http#15), so
 * it keeps to the next best line: a browser page may call it only from the
 * app's own origin. A cross-origin page could otherwise POST to it with no
 * preflight and run whatever it trusts its caller to run. A browser leaves
 * the Origin off some requests, such as a cross-site GET from a link or an
 * image, but it always sets `Sec-Fetch-Site`, which a page cannot change; a
 * request with no Origin from another site, or from another port on
 * localhost (`same-site`), is refused too. curl and server code send neither
 * header, and they are how private functions are called in production, so
 * they keep working. Public functions answer any origin, as
 * production does; CORS decides who reads the response.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpFunctionInfo } from './discovery.js';

/** Whether a request's Origin is absent or one of the app's own pages; the plane knows its ports. */
export type AppOriginCheck = (req: IncomingMessage) => boolean;

/** `Sec-Fetch-Site` values that name a page other than the app's own. */
const FOREIGN_FETCH_SITES = new Set(['cross-site', 'same-site']);

/** A browser request with no Origin that its fetch metadata says came from another page. */
function isForeignFetchWithoutOrigin(req: IncomingMessage): boolean {
  const hasOrigin = req.headers.origin !== undefined;
  if (hasOrigin) return false;
  const site = req.headers['sec-fetch-site'];
  return typeof site === 'string' && FOREIGN_FETCH_SITES.has(site.toLowerCase());
}

/** Answers 403 and returns true when a private function's caller is a foreign page. */
export function refuseForeignOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  fn: HttpFunctionInfo,
  allowsAppOrigin: AppOriginCheck,
): boolean {
  const isForeignCaller = fn.privateInvoker && (isForeignFetchWithoutOrigin(req) || !allowsAppOrigin(req));
  if (!isForeignCaller) return false;
  const caller = req.headers.origin ?? `a ${String(req.headers['sec-fetch-site'])} page`;
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
    `pyric: refused a request from ${caller} to ${fn.exportName}, which sets an invoker other than 'public', such as invoker: 'private' or a service account. ` +
      'pyric serves such functions only to the app\'s own pages and to callers that are not browser pages, such as curl or server code.',
  );
  return true;
}
