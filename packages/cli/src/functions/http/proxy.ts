/**
 * Forwards one request from a plane (the sandbox server or Vite) to the
 * child's HTTP listener and streams the answer back unchanged, cutting it at
 * the function's timeout and enforcing uncompressed HTTP body quotas.
 */
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { effectiveRequestScheme, type TrustProxyPolicy } from '../../serve/guard-policy.js';
import { FUNCTION_TARGET_HEADER, answerPayloadTooLarge } from './child-server.js';
import { CHILD_TOKEN_HEADER } from './child-token.js';
import {
  captureInboundRequestBody,
  type BodyByteLimit,
  type BodyStreamHandle,
  type InboundRequestBody,
} from './request-body-buffer.js';

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
  /**
   * Upstream HTTP client implementation. Defaults to `'auto'`, selecting Bun's
   * native `fetch` stream under Bun and `node:http` `request` under Node.js.
   */
  upstreamTransport?: 'auto' | 'node-http' | 'bun-fetch';
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
function droppedHopByHopNames(connectionHeader: string | string[] | null | undefined): Set<string> {
  let raw = '';
  if (Array.isArray(connectionHeader)) {
    raw = connectionHeader.join(',');
  } else if (typeof connectionHeader === 'string') {
    raw = connectionHeader;
  }
  const listed = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...HOP_BY_HOP, ...listed]);
}

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const dropped = droppedHopByHopNames(headers.connection);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name)));
}

function endToEndFetchHeaders(headers: Headers, closeDownstream: boolean): OutgoingHttpHeaders {
  const dropped = droppedHopByHopNames(headers.get('connection'));
  const out: OutgoingHttpHeaders = {};
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (dropped.has(name) || name === 'set-cookie') return;
    out[name] = value;
  });
  if (!dropped.has('set-cookie')) {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) {
      out['set-cookie'] = cookies;
    }
  }
  if (closeDownstream) {
    out.connection = 'close';
  }
  return out;
}

function isConnectRefusedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ECONNREFUSED' || code === 'ConnectionRefused';
}

function selectUpstreamTransport(
  configured: ProxyTarget['upstreamTransport'],
): 'node-http' | 'bun-fetch' {
  if (configured === 'node-http' || configured === 'bun-fetch') {
    return configured;
  }
  if ('Bun' in globalThis) {
    return 'bun-fetch';
  }
  return 'node-http';
}

function shouldAttachRequestBodyStream(req: IncomingMessage, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const declaredLength = parseContentLength(req.headers['content-length']);
  return declaredLength !== null && declaredLength > 0;
}

function canDeferConnectRefusal(
  startedForwarding: boolean,
  target: ProxyTarget,
  error: unknown,
  res: ServerResponse,
): boolean {
  if (startedForwarding) return false;
  if (target.deferConnectRefused !== true) return false;
  if (res.headersSent) return false;
  return isConnectRefusedError(error);
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

function writeDownstreamChunk(res: ServerResponse, chunk: Uint8Array): Promise<boolean> {
  if (res.destroyed || res.writableEnded) {
    return Promise.resolve(false);
  }
  const canContinue = res.write(chunk);
  if (canContinue) {
    return Promise.resolve(true);
  }
  return new Promise((resolveWrite) => {
    const onDrain = (): void => {
      res.off('close', onClose);
      resolveWrite(!res.destroyed && !res.writableEnded);
    };
    const onClose = (): void => {
      res.off('drain', onDrain);
      resolveWrite(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

type BunFetchInit = RequestInit & {
  duplex?: 'half';
  decompress?: boolean;
};

function proxyViaBunFetch(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  inboundBody: InboundRequestBody,
  limit: BodyByteLimit,
): Promise<ProxyOutcome> {
  return new Promise((resolveOutcome) => {
    let status: number | null = null;
    let timedOut = false;
    let rejectedTooLarge = false;
    let resolvedEarly = false;
    let cutMidResponse = false;
    let bodyReadStarted = false;
    let bodyHandle: BodyStreamHandle | null = null;

    const upstreamAbort = new AbortController();

    const timer = setTimeout(() => {
      timedOut = true;
      bodyHandle?.detachConsumer();
      inboundBody.drainRemaining();
      if (res.headersSent) {
        cutMidResponse = true;
        upstreamAbort.abort();
        res.destroy();
        return;
      }
      upstreamAbort.abort();
      status = 504;
      res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(target.timeoutMessage);
    }, target.timeoutMs);
    timer.unref();

    const onResClose = (): void => {
      if (resolvedEarly) return;
      clearTimeout(timer);
      bodyHandle?.detachConsumer();
      inboundBody.drainRemaining();
      if (!res.writableFinished) {
        upstreamAbort.abort();
      }
      const complete = res.writableFinished && !cutMidResponse;
      let reportedStatus: number | null = null;
      if (complete) {
        reportedStatus = status;
      }
      resolveOutcome({ status: reportedStatus, timedOut });
    };
    res.once('close', onResClose);

    const forwarded = forwardedHeaders(req, target);
    const requestHeaders: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(forwarded)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          requestHeaders.push([name, item]);
        }
      } else {
        requestHeaders.push([name, value]);
      }
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const fetchInit: BunFetchInit = {
      method,
      headers: requestHeaders,
      redirect: 'manual',
      decompress: false,
      keepalive: false,
      signal: upstreamAbort.signal,
    };

    if (shouldAttachRequestBodyStream(req, method)) {
      bodyHandle = inboundBody.createReadableStream({
        limit,
        onStarted: () => {
          bodyReadStarted = true;
        },
        onTooLarge: () => {
          rejectedTooLarge = true;
          status = 413;
          upstreamAbort.abort();
          answerPayloadTooLarge(req, res);
        },
      });
      fetchInit.body = bodyHandle.stream;
      fetchInit.duplex = 'half';
    }

    let forwardPath = target.forwardUrl;
    if (!forwardPath.startsWith('/')) {
      forwardPath = `/${forwardPath}`;
    }
    const url = `http://127.0.0.1:${target.port}${forwardPath}`;

    void (async () => {
      try {
        const response = await fetch(url, fetchInit);
        if (timedOut || rejectedTooLarge || res.destroyed) {
          return;
        }
        status = response.status;
        bodyHandle?.detachConsumer();
        const incompleteClientBody = inboundBody.hasIncompleteClientBody();
        inboundBody.drainRemaining();
        const outHeaders = endToEndFetchHeaders(response.headers, incompleteClientBody);
        if (response.statusText.length > 0) {
          res.writeHead(status, response.statusText, outHeaders);
        } else {
          res.writeHead(status, outHeaders);
        }

        if (response.body === null || method === 'HEAD') {
          if (!timedOut && !rejectedTooLarge && !res.destroyed && !res.writableEnded) {
            res.end();
          }
          return;
        }

        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (timedOut || rejectedTooLarge || res.destroyed) return;
            if (value !== undefined && value.byteLength > 0) {
              const ok = await writeDownstreamChunk(res, value);
              if (!ok) return;
            }
          }
          if (!timedOut && !rejectedTooLarge && !res.destroyed && !res.writableEnded) {
            res.end();
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        if (timedOut || rejectedTooLarge || res.destroyed) return;
        if (canDeferConnectRefusal(bodyReadStarted, target, err, res)) {
          resolvedEarly = true;
          clearTimeout(timer);
          res.off('close', onResClose);
          bodyHandle?.detachConsumer();
          resolveOutcome({ status: null, timedOut: false, connectRefused: true });
          return;
        }
        bodyHandle?.detachConsumer();
        inboundBody.drainRemaining();
        if (!res.headersSent) {
          status = 502;
          writeProxyBadGateway(res);
        } else {
          res.destroy();
        }
      }
    })();
  });
}

function proxyViaNodeHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  inboundBody: InboundRequestBody,
  limit: BodyByteLimit,
): Promise<ProxyOutcome> {
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
    let detachPipe: (() => void) | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      detachPipe?.();
      inboundBody.drainRemaining();
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
      detachPipe = inboundBody.pipeToClientRequest(upstream, {
        limit,
        onStarted: () => {
          socketConnected = true;
        },
        onTooLarge: () => {
          rejectedTooLarge = true;
          status = 413;
          upstream.destroy();
          answerPayloadTooLarge(req, res);
        },
        onClientError: () => {
          upstream.destroy();
        },
      });
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
        detachPipe?.();
        inboundBody.drainRemaining();
      }
      res.writeHead(status, response.statusMessage, endToEnd(response.headers));
      response.pipe(res);
      response.on('error', () => res.destroy());
    });

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (timedOut || rejectedTooLarge) return;
      if (canDeferConnectRefusal(socketConnected, target, err, res)) {
        resolvedEarly = true;
        clearTimeout(timer);
        res.off('close', onResClose);
        detachPipe?.();
        resolveOutcome({ status: null, timedOut: false, connectRefused: true });
        return;
      }
      detachPipe?.();
      inboundBody.drainRemaining();
      if (answer !== null) {
        return;
      }
      if (!res.headersSent) {
        status = 502;
        writeProxyBadGateway(res);
      } else {
        res.destroy();
      }
    });

    const onResClose = (): void => {
      if (resolvedEarly) return;
      clearTimeout(timer);
      detachPipe?.();
      inboundBody.drainRemaining();
      if (!upstream.destroyed && !res.writableFinished) {
        upstream.destroy();
      }
      const complete = res.writableFinished && !cutMidResponse;
      let reportedStatus: number | null = null;
      if (complete) {
        reportedStatus = status;
      }
      resolveOutcome({ status: reportedStatus, timedOut });
    };
    res.once('close', onResClose);
  });
}

export function proxyToChild(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
): Promise<ProxyOutcome> {
  const inboundBody = captureInboundRequestBody(req);
  const maxBodyBytes = target.maxBodyBytes;
  const enforcesIdentityLimit = maxBodyBytes !== undefined && isIdentityEncoding(req);
  const limit: BodyByteLimit = { enforcesIdentityLimit, maxBodyBytes };
  if (enforcesIdentityLimit && maxBodyBytes !== undefined) {
    const declaredLength = parseContentLength(req.headers['content-length']);
    if (declaredLength !== null && declaredLength > maxBodyBytes) {
      return new Promise((resolveOutcome) => {
        res.once('close', () => {
          resolveOutcome({ status: 413, timedOut: false });
        });
        inboundBody.drainRemaining();
        answerPayloadTooLarge(req, res);
      });
    }
  }

  if (selectUpstreamTransport(target.upstreamTransport) === 'bun-fetch') {
    return proxyViaBunFetch(req, res, target, inboundBody, limit);
  }
  return proxyViaNodeHttp(req, res, target, inboundBody, limit);
}
