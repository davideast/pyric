/**
 * Forwards one request from a plane (the sandbox server or Vite) to the
 * child's HTTP listener and streams the answer back unchanged.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { FUNCTION_TARGET_HEADER } from './child-server.js';

/** Connection-scoped headers a proxy must not forward (RFC 9110 section 7.6.1). */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export interface ProxyTarget {
  port: number;
  exportName: string;
  /** The path and query the function sees. */
  forwardUrl: string;
}

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));
}

/** Resolves with the status the function answered, or null when no response reached the client. */
export function proxyToChild(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): Promise<number | null> {
  return new Promise((resolveStatus) => {
    let status: number | null = null;
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: target.forwardUrl,
      headers: { ...endToEnd(req.headers), [FUNCTION_TARGET_HEADER]: target.exportName },
    });
    upstream.on('response', (answer) => {
      status = answer.statusCode ?? 502;
      res.writeHead(status, answer.statusMessage, endToEnd(answer.headers));
      answer.pipe(res);
      answer.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('pyric: the Functions child closed the connection before answering.');
        status = 502;
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!upstream.destroyed && !res.writableFinished) upstream.destroy();
      resolveStatus(res.writableFinished ? status : null);
    });
    req.pipe(upstream);
  });
}
