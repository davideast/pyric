/**
 * Forwards one request from a plane (the sandbox server or Vite) to the
 * child's HTTP listener and streams the answer back unchanged, cutting it at
 * the function's timeout and enforcing uncompressed HTTP body quotas.
 */
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { effectiveRequestScheme, type TrustProxyPolicy } from '../../serve/guard-policy.js';
import { FUNCTION_TARGET_HEADER, answerPayloadTooLarge } from './child-server.js';
import { CHILD_TOKEN_HEADER } from './child-token.js';

/** Connection-scoped headers a proxy must not forward (RFC 9110 section 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

export interface ProxyTarget {
  port: number;
  /** The spawn's token, which the child requires on every request. */
  token: string;
  exportName: string;
  /** The path and query the function sees. */
  forwardUrl: string;
  /** Header values to set (a string) or remove (undefined) before forwarding. */
  headerOverrides?: Record<string, string | undefined>;
  /** Cut the request after this long. */
  timeoutMs: number;
  /** The 504 body when the cut comes before any of the response. */
  timeoutMessage: string;
  /** Reverse-proxy trust rule used to derive `x-forwarded-proto` from trusted peers. */
  trustProxy?: TrustProxyPolicy;
  /** Maximum uncompressed HTTP request body size in bytes (413 past this limit). */
  maxBodyBytes?: number;
  /**
   * When true, a connection refusal before any bytes are sent leaves `req` and
   * `res` untouched and sets `connectRefused: true` so the caller may retry
   * after an in-flight child restart.
   */
  deferConnectRefused?: boolean;
}

/** How a forwarded request ended. */
export interface ProxyOutcome {
  /** The status the client received, or null when it received no complete response. */
  status: number | null;
  timedOut: boolean;
  /** True when `deferConnectRefused` was set and TCP connect to the child was refused. */
  connectRefused?: boolean;
}

function parseContentLength(header: string | string[] | undefined): number | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function isIdentityEncoding(req: IncomingMessage): boolean {
  const raw = req.headers['content-encoding'];
  if (typeof raw !== 'string') return true;
  const normalized = raw.trim().toLowerCase();
  return normalized.length === 0 || normalized === 'identity';
}

/** Headers minus hop-by-hop ones, including any the message's own Connection header names. */
function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const listed = String(headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
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
  if (prior) {
    headers['x-forwarded-for'] = `${String(prior)}, ${client}`;
  } else {
    headers['x-forwarded-for'] = client;
  }
  const scheme = effectiveRequestScheme(req, target.trustProxy ?? false);
  if (scheme === 'https:') {
    headers['x-forwarded-proto'] = 'https';
  } else {
    headers['x-forwarded-proto'] = 'http';
  }
  delete headers['x-forwarded-host'];
  for (const [name, value] of Object.entries(target.headerOverrides ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  headers[FUNCTION_TARGET_HEADER] = target.exportName;
  headers[CHILD_TOKEN_HEADER] = target.token;
  return headers;
}

export function writeProxyBadGateway(res: ServerResponse): void {
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('pyric: the Functions child closed the connection before answering.');
  } else {
    res.destroy();
  }
}

export function proxyToChild(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
): Promise<ProxyOutcome> {
  const maxBodyBytes = target.maxBodyBytes;
  const enforcesIdentityLimit = maxBodyBytes !== undefined && isIdentityEncoding(req);
  if (enforcesIdentityLimit) {
    const declaredLength = parseContentLength(req.headers['content-length']);
    if (declaredLength !== null && declaredLength > maxBodyBytes) {
      return new Promise((resolveOutcome) => {
        res.once('close', () => {
          resolveOutcome({ status: 413, timedOut: false });
        });
        answerPayloadTooLarge(req, res);
      });
    }
  }

  return new Promise((resolveOutcome) => {
    let status: number | null = null;
    let timedOut = false;
    let rejectedTooLarge = false;
    let resolvedEarly = false;
    let socketConnected = false;

    const upstream = httpRequest({
      host: '127.0.0.1',
      port: target.port,
      method: req.method,
      path: target.forwardUrl,
      headers: forwardedHeaders(req, target),
      // Never pool loopback sockets across requests: an upstream handler that
      // ends early without draining its request body would leave unread bytes
      // ahead of the next request on a reused keep-alive connection.
      agent: false,
    });

    let answer: IncomingMessage | null = null;
    let cutMidResponse = false;
    let stopForwardingBody: (() => void) | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      stopForwardingBody?.();
      if (res.headersSent) {
        cutMidResponse = true;
        answer?.unpipe(res);
        res.destroy();
        upstream.destroy();
        return;
      }
      upstream.destroy();
      status = 504;
      res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(target.timeoutMessage);
    }, target.timeoutMs);
    timer.unref();

    const startBodyForwarding = (): void => {
      let forwardedBytes = 0;
      let stopped = false;

      const onReqData = (chunk: Buffer): void => {
        if (stopped) return;
        if (enforcesIdentityLimit && maxBodyBytes !== undefined) {
          forwardedBytes += chunk.byteLength;
          if (forwardedBytes > maxBodyBytes) {
            stopped = true;
            rejectedTooLarge = true;
            detachReqListeners();
            upstream.destroy();
            status = 413;
            answerPayloadTooLarge(req, res);
            return;
          }
        }
        const canContinue = upstream.write(chunk);
        if (!canContinue) {
          req.pause();
        }
      };

      const onUpstreamDrain = (): void => {
        if (!stopped) {
          req.resume();
        }
      };

      const onReqEnd = (): void => {
        if (stopped) return;
        stopped = true;
        detachReqListeners();
        upstream.end();
      };

      const onReqError = (): void => {
        if (stopped) return;
        stopped = true;
        detachReqListeners();
        upstream.destroy();
      };

      function detachReqListeners(): void {
        req.off('data', onReqData);
        req.off('end', onReqEnd);
        req.off('error', onReqError);
        upstream.off('drain', onUpstreamDrain);
      }

      stopForwardingBody = (): void => {
        if (stopped) return;
        stopped = true;
        detachReqListeners();
      };

      if (req.readableEnded) {
        stopped = true;
        upstream.end();
        return;
      }

      upstream.on('drain', onUpstreamDrain);
      req.on('data', onReqData);
      req.once('end', onReqEnd);
      req.once('error', onReqError);
      req.resume();
    };

    upstream.once('socket', (socket: Socket) => {
      if (!socket.connecting) {
        socketConnected = true;
        startBodyForwarding();
        return;
      }
      socket.once('connect', () => {
        socketConnected = true;
        startBodyForwarding();
      });
    });

    upstream.on('response', (response) => {
      answer = response;
      status = response.statusCode ?? 502;
      if (status === 413) {
        // Upstream rejected an oversized body early: stop writing chunks to
        // upstream and drain remaining client bytes so the 413 reaches caller.
        stopForwardingBody?.();
        if (!req.complete && !req.readableEnded) {
          req.resume();
        }
      }
      res.writeHead(status, response.statusMessage, endToEnd(response.headers));
      response.pipe(res);
      response.on('error', () => res.destroy());
    });

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (timedOut || rejectedTooLarge) return;
      if (
        !socketConnected &&
        target.deferConnectRefused === true &&
        err.code === 'ECONNREFUSED' &&
        !res.headersSent
      ) {
        resolvedEarly = true;
        clearTimeout(timer);
        stopForwardingBody?.();
        resolveOutcome({ status: null, timedOut: false, connectRefused: true });
        return;
      }
      stopForwardingBody?.();
      if (answer !== null) {
        // Upstream already sent response headers (e.g. early 200 or 413) and
        // closed its read side while client body bytes were still in flight.
        if (!req.complete && !req.readableEnded) {
          req.resume();
        }
        return;
      }
      if (!res.headersSent) {
        status = 502;
        writeProxyBadGateway(res);
      } else {
        res.destroy();
      }
    });

    res.on('close', () => {
      if (resolvedEarly) return;
      clearTimeout(timer);
      stopForwardingBody?.();
      if (!upstream.destroyed && !res.writableFinished) upstream.destroy();
      const complete = res.writableFinished && !cutMidResponse;
      let reportedStatus: number | null = null;
      if (complete) {
        reportedStatus = status;
      }
      resolveOutcome({ status: reportedStatus, timedOut });
    });
  });
}
