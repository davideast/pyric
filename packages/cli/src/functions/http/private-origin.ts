/**
 * Production refuses an `invoker: 'private'` function to any caller without
 * an IAM identity. pyric serves it without one (functions-http#15), so it
 * keeps to the next best line: a browser page may call it only from the app's
 * own origin. A cross-origin page could otherwise POST to it with no
 * preflight and run whatever it trusts its caller to run. curl and server
 * code send no Origin, and they are how private functions are called in
 * production, so they keep working. Public functions answer any origin, as
 * production does; CORS decides who reads the response.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpFunctionInfo } from './discovery.js';

/** Whether a request's Origin is absent or one of the app's own pages; the plane knows its ports. */
export type AppOriginCheck = (req: IncomingMessage) => boolean;

/** Answers 403 and returns true when a private function's caller is a foreign page. */
export function refuseForeignOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  fn: HttpFunctionInfo,
  allowsAppOrigin: AppOriginCheck,
): boolean {
  const isForeignCaller = fn.privateInvoker && !allowsAppOrigin(req);
  if (!isForeignCaller) return false;
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(
    `pyric: refused a request from Origin ${String(req.headers.origin)} to ${fn.exportName}, which sets invoker: 'private'. ` +
      'pyric serves private functions only to the app\'s own pages and to callers that send no Origin.',
  );
  return true;
}
