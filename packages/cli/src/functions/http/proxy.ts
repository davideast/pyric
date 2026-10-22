/**
 * Forwards one request from a plane (the sandbox server or Vite) to the
 * child's HTTP listener and streams the answer back unchanged, cutting it at
 * the function's timeout.
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
  /** Header values to set (a string) or remove (undefined) before forwarding. */
  headerOverrides?: Record<string, string | undefined>;
  /** Cut the request after this long. */
  timeoutMs: number;
}

/** How a forwarded request ended. */
export interface ProxyOutcome {
  /** The status the client received, or null when it received no complete response. */
  status: number | null;
  timedOut: boolean;
}

/** Headers minus hop-by-hop ones, including any the message's own Connection header names. */
function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const listed = String(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  const dropped = new Set([...HOP_BY_HOP, ...listed]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name)));
}

/**
 * What the child receives: the client's end-to-end headers, the client
 * appended to X-Forwarded-For, and forwarding headers this hop owns rather
 * than ones the client sent.
 */
function forwardedHeaders(req: IncomingMessage, target: ProxyTarget): IncomingHttpHeaders {
  const headers = endToEnd(req.headers);
  const client = req.socket.remoteAddress ?? '';
  const prior = headers['x-forwarded-for'];
  headers['x-forwarded-for'] = prior ? `${String(prior)}, ${client}` : client;
  headers['x-forwarded-proto'] = 'http';
  delete headers['x-forwarded-host'];
  for (const [name, value] of Object.entries(target.headerOverrides ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  headers[FUNCTION_TARGET_HEADER] = target.exportName;
  return headers;
}

export function proxyToChild(req: IncomingMessage, res: ServerResponse, target: ProxyTarget): Promise<ProxyOutcome> {
  return new Promise((resolveOutcome) => {
    let status: number | null = null;
    let timedOut = false;
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: target.forwardUrl,
      headers: forwardedHeaders(req, target),
    });
    let answer: IncomingMessage | null = null;
    let cutMidResponse = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (res.headersSent) {
        // Part of the response is out: close the connection so the client sees it end short.
        cutMidResponse = true;
        answer?.unpipe(res);
        res.destroy();
        upstream.destroy();
        return;
      }
      upstream.destroy();
      status = 504;
      res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`pyric: ${target.exportName} did not respond within its timeout (${target.timeoutMs / 1000} s).`);
    }, target.timeoutMs);
    timer.unref();
    upstream.on('response', (response) => {
      answer = response;
      status = response.statusCode ?? 502;
      res.writeHead(status, response.statusMessage, endToEnd(response.headers));
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (timedOut) return;
      if (!res.headersSent) {
        status = 502;
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('pyric: the Functions child closed the connection before answering.');
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      clearTimeout(timer);
      if (!upstream.destroyed && !res.writableFinished) upstream.destroy();
      const complete = res.writableFinished && !cutMidResponse;
      resolveOutcome({ status: complete ? status : null, timedOut });
    });
    req.pipe(upstream);
  });
}
