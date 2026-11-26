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
import { getHeader } from '../../serve/loopback-guard.js';
import type { HttpFunctionInfo } from './discovery.js';

/** Whether a request's Origin is absent or one of the app's own pages; the plane knows its ports. */
export type AppOriginCheck = (req: IncomingMessage) => boolean;

/** `Sec-Fetch-Site` values that name a page other than the app's own. */
const FOREIGN_FETCH_SITES = new Set(['cross-site', 'same-site']);

/** A browser request with an empty Origin or no Origin whose fetch metadata names another page. */
function isForeignFetchWithoutOrigin(req: IncomingMessage): boolean {
  const rawOrigin = getHeader(req, 'origin');
  if (rawOrigin !== undefined) {
    return rawOrigin.trim() === '';
  }
  const site = getHeader(req, 'sec-fetch-site')?.trim().toLowerCase();
  return site !== undefined && FOREIGN_FETCH_SITES.has(site);
}

function describeForeignCaller(rawOrigin: string | undefined, site: string | undefined): string {
  const trimmedOrigin = rawOrigin?.trim();
  if (trimmedOrigin !== undefined && trimmedOrigin !== '') return trimmedOrigin;
  if (site !== undefined && site !== '') return `a ${site} page`;
  if (rawOrigin !== undefined) return 'an empty Origin';
  return 'a foreign page';
}

export interface RefuseForeignOriginOptions {
  /**
   * True when the unified request guard (`evaluateGuard`) already verified
   * `Origin`, `Sec-Fetch-Site`, scheme, and trusted forwarding headers for a
   * remote request.
   */
  readonly guardVerifiedOrigin?: boolean;
}

/** Answers 403 and returns true when a private function's caller is a foreign page. */
export function refuseForeignOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  fn: HttpFunctionInfo,
  allowsAppOrigin: AppOriginCheck,
  options?: RefuseForeignOriginOptions,
): boolean {
  if (!fn.privateInvoker) return false;
  const originRejected = options?.guardVerifiedOrigin !== true && !allowsAppOrigin(req);
  const isForeignCaller = isForeignFetchWithoutOrigin(req) || originRejected;
  if (!isForeignCaller) return false;
  const caller = describeForeignCaller(getHeader(req, 'origin'), getHeader(req, 'sec-fetch-site')?.trim());
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
    `pyric: refused a request from ${caller} to ${fn.exportName}, which sets an invoker other than 'public', such as invoker: 'private' or a service account. ` +
      'pyric serves such functions only to the app\'s own pages and to callers that are not browser pages, such as curl or server code.',
  );
  return true;
}
