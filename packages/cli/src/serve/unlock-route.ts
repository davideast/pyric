import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerAndClose } from '../bridge/server/peer.js';
import {
  isAdmittedPeer,
  parseAllowPeersSetting,
  parseTrustProxySetting,
  type RemoteAccessOptions,
} from './guard-policy.js';
import {
  resolveRequestHostContext,
  type ForwardedProxyPolicy,
} from './forwarded-proxy.js';
import {
  appendSetCookieHeader,
  formatSessionCookie,
  getHeader,
  isSameOrigin,
  sessionCookieNameForPort,
  timingSafeTokenMatch,
} from './loopback-guard.js';
import { renderUnlockHtml } from './unlock-page.js';

export const UNLOCK_PATH = '/__pyric/unlock';
export const LOGOUT_PATH = '/__pyric/logout';

const MAX_UNLOCK_BODY_BYTES = 1024;
const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 60_000;
const MAX_TRACKED_PEERS = 1024;
const UNLOCK_QUERY_TOKEN_KEYS = new Set(['token', 'code', 'sessiontoken', 'session_token']);
const UNSAFE_NEXT_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const UNLOCK_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; " +
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

export interface UnlockRouteOptions {
  boundHost: string;
  allowedHosts: readonly string[];
  remoteAccess: RemoteAccessOptions;
  sessionToken: string;
  rateLimit?: {
    maxFailures?: number;
    windowMs?: number;
    now?: () => number;
  };
}

interface FailureWindow {
  count: number;
  resetAt: number;
}

class UnlockBodyTooLargeError extends Error {}

/**
 * Validate a relative `?next=` redirect target for `/__pyric/unlock`.
 * Accepts only a single-leading-slash relative path without protocol-relative
 * prefixes (`//`), backslashes, control characters, or scheme escapes.
 * Returns `null` when an explicit value is unsafe.
 */
export function validateUnlockNextPath(raw: string): string | null {
  if (raw.length === 0) return '/';
  if (UNSAFE_NEXT_CONTROL_RE.test(raw)) return null;
  if (raw !== raw.trim()) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.includes('\\')) return null;
  if (raw.startsWith('/__pyric/unlock') || raw.startsWith('/__pyric/logout')) return null;
  const beforeQuery = raw.split(/[?#]/, 1)[0] ?? '';
  if (beforeQuery.includes(':')) return null;
  if (beforeQuery.split('/').includes('..')) return null;
  try {
    const base = 'http://pyric.invalid';
    const parsed = new URL(raw, base);
    if (parsed.origin !== base) return null;
    if (parsed.pathname.startsWith('//')) return null;
    const segments = parsed.pathname.split('/');
    for (const seg of segments) {
      if (seg === '..') return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function peerRateLimitKey(req: IncomingMessage): string {
  const raw = req.socket?.remoteAddress;
  if (raw === undefined || raw.trim().length === 0) return 'unknown';
  let addr = raw.trim().toLowerCase();
  const zoneIndex = addr.indexOf('%');
  if (zoneIndex !== -1) addr = addr.slice(0, zoneIndex);
  if (addr.startsWith('::ffff:')) {
    const mapped = addr.slice('::ffff:'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return mapped;
  }
  return addr;
}

function hasForbiddenQueryToken(url: URL): string | null {
  for (const key of url.searchParams.keys()) {
    if (UNLOCK_QUERY_TOKEN_KEYS.has(key.toLowerCase())) {
      return key;
    }
  }
  return null;
}

function setUnlockSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): void {
  setUnlockSecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readBoundedJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UNLOCK_BODY_BYTES) {
    req.resume();
    throw new UnlockBodyTooLargeError('unlock payload exceeds 1024 byte limit');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_UNLOCK_BODY_BYTES) {
      req.resume();
      throw new UnlockBodyTooLargeError('unlock payload exceeds 1024 byte limit');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw) as unknown;
}

function checkSameOriginPost(
  req: IncomingMessage,
  policy: ForwardedProxyPolicy,
): { ok: true; scheme: 'http:' | 'https:' } | { ok: false; message: string } {
  const secFetchSite = getHeader(req, 'sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== 'same-origin') {
    return {
      ok: false,
      message: `Refused cross-site unlock request (Sec-Fetch-Site: ${secFetchSite}).`,
    };
  }
  const origin = getHeader(req, 'origin');
  if (origin === undefined || origin.trim() === '' || origin.trim().toLowerCase() === 'null') {
    return { ok: false, message: 'Missing or null Origin header on POST request.' };
  }
  const hostCtx = resolveRequestHostContext(req, policy);
  if (!hostCtx.ok) {
    return { ok: false, message: 'Cross-origin or mismatched-scheme POST request refused.' };
  }
  const effectiveScheme = hostCtx.effectiveScheme ?? 'http:';
  if (!isSameOrigin(origin, hostCtx.effectiveHost, policy.boundHost, effectiveScheme)) {
    return { ok: false, message: 'Cross-origin or mismatched-scheme POST request refused.' };
  }
  return { ok: true, scheme: effectiveScheme };
}

function appendClearedCookieHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  scheme: 'http:' | 'https:',
): void {
  const localPort = req.socket?.localPort;
  const expired = 'HttpOnly; SameSite=Strict; Path=/__pyric; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const secure = scheme === 'https:' || (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  const secureSuffix = secure ? '; Secure' : '';
  const cookies: string[] = [];
  if (localPort !== undefined && Number.isInteger(localPort) && localPort > 0) {
    cookies.push(`${sessionCookieNameForPort(localPort)}=; ${expired}${secureSuffix}`);
  }
  cookies.push(`${sessionCookieNameForPort()}=; ${expired}${secureSuffix}`);
  res.setHeader('Set-Cookie', cookies);
}

/**
 * Create the `/__pyric/unlock` and `/__pyric/logout` request handler for explicit
 * `remoteAccess` browser session pairing. Mount only when `remoteAccess` is active
 * and `browserUnlock !== false`.
 */
export function createUnlockHandler(
  options: UnlockRouteOptions,
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const allowPeers = parseAllowPeersSetting(options.remoteAccess.allowPeers);
  const trustProxy = parseTrustProxySetting(options.remoteAccess.trustProxy);
  const proxyPolicy: ForwardedProxyPolicy = {
    boundHost: options.boundHost,
    allowedHosts: options.allowedHosts,
    allowPeers,
    trustProxy,
    remoteAccessEnabled: true,
  };
  const maxFailures = options.rateLimit?.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = options.rateLimit?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.rateLimit?.now ?? Date.now;
  const failures = new Map<string, FailureWindow>();

  const pruneExpired = (timestamp: number): void => {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= timestamp) {
        failures.delete(key);
      }
    }
  };

  const checkRateLimit = (peerKey: string, timestamp: number): number | null => {
    const entry = failures.get(peerKey);
    if (entry === undefined) return null;
    if (entry.resetAt <= timestamp) {
      failures.delete(peerKey);
      return null;
    }
    if (entry.count >= maxFailures) {
      return Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000));
    }
    return null;
  };

  const recordFailure = (peerKey: string, timestamp: number): number | null => {
    pruneExpired(timestamp);
    const existing = failures.get(peerKey);
    if (existing !== undefined && existing.resetAt > timestamp) {
      existing.count += 1;
      if (existing.count >= maxFailures) {
        return Math.max(1, Math.ceil((existing.resetAt - timestamp) / 1000));
      }
      return null;
    }
    if (failures.size >= MAX_TRACKED_PEERS) {
      const oldestKey = failures.keys().next().value;
      if (oldestKey !== undefined) failures.delete(oldestKey);
    }
    const nextEntry: FailureWindow = { count: 1, resetAt: timestamp + windowMs };
    failures.set(peerKey, nextEntry);
    if (nextEntry.count >= maxFailures) {
      return Math.max(1, Math.ceil(windowMs / 1000));
    }
    return null;
  };

  const checkHostAndPeer = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!isAdmittedPeer(req, { allowPeers })) {
      writeJson(res, 403, {
        error: 'remote_peer_refused',
        message: 'Refused unlock request from a non-admitted peer address.',
      });
      return false;
    }
    const hostCtx = resolveRequestHostContext(req, proxyPolicy);
    if (!hostCtx.ok) {
      writeJson(res, 403, {
        error: 'disallowed_host',
        message: 'Refused unlock request for an unconfigured Host header.',
      });
      return false;
    }
    return true;
  };

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname === UNLOCK_PATH) {
      if (!checkHostAndPeer(req, res)) return true;

      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        const forbiddenKey = hasForbiddenQueryToken(url);
        if (forbiddenKey !== null) {
          setUnlockSecurityHeaders(res);
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(
            `pyric: refused query parameter '${forbiddenKey}' on ${UNLOCK_PATH}. ` +
              'Capability tokens must not appear in URL query strings (they leak to logs and Referer). ' +
              'Pass the token via URL fragment (#code=...) or paste it into the unlock form.',
          );
          return true;
        }
        const rawNext = url.searchParams.get('next');
        let nextPath = '/';
        if (rawNext !== null && rawNext.length > 0) {
          const validated = validateUnlockNextPath(rawNext);
          if (validated === null) {
            setUnlockSecurityHeaders(res);
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('pyric: invalid next redirect target; only relative paths starting with / are allowed.');
            return true;
          }
          nextPath = validated;
        }
        setUnlockSecurityHeaders(res);
        res.setHeader('Content-Security-Policy', UNLOCK_CSP);
        const html = renderUnlockHtml(nextPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : html);
        return true;
      }

      if (method !== 'POST') {
        setUnlockSecurityHeaders(res);
        res.writeHead(405, { Allow: 'GET, HEAD, POST', 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return true;
      }

      const originCheck = checkSameOriginPost(req, proxyPolicy);
      if (!originCheck.ok) {
        writeJson(res, 403, { error: 'cross_origin_refused', message: originCheck.message });
        return true;
      }

      const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        writeJson(res, 415, {
          error: 'unsupported_media_type',
          message: 'Content-Type must be application/json.',
        });
        return true;
      }

      const peerKey = peerRateLimitKey(req);
      const timestamp = now();
      const lockedSeconds = checkRateLimit(peerKey, timestamp);
      if (lockedSeconds !== null) {
        writeJson(
          res,
          429,
          {
            error: 'rate_limited',
            retryAfter: lockedSeconds,
            message: `Too many failed unlock attempts. Retry after ${lockedSeconds}s.`,
          },
          { 'Retry-After': String(lockedSeconds) },
        );
        return true;
      }

      let body: unknown;
      try {
        body = await readBoundedJsonBody(req);
      } catch (error) {
        if (error instanceof UnlockBodyTooLargeError) {
          answerAndClose(
            req,
            res,
            413,
            { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
            JSON.stringify({ error: 'payload_too_large', message: error.message }),
          );
          return true;
        }
        writeJson(res, 400, { error: 'invalid_json', message: 'Expected JSON object { token, next? }.' });
        return true;
      }

      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        writeJson(res, 400, { error: 'invalid_payload', message: 'Expected JSON object { token, next? }.' });
        return true;
      }
      const record = body as Record<string, unknown>;
      const rawToken = record.token;
      if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
        const retryAfter = recordFailure(peerKey, timestamp);
        if (retryAfter !== null) {
          writeJson(
            res,
            429,
            { error: 'rate_limited', retryAfter, message: `Too many failed unlock attempts. Retry after ${retryAfter}s.` },
            { 'Retry-After': String(retryAfter) },
          );
          return true;
        }
        writeJson(res, 400, { error: 'missing_token', message: 'Field "token" must be a non-empty string.' });
        return true;
      }

      let nextPath = '/';
      if (record.next !== undefined) {
        if (typeof record.next !== 'string') {
          writeJson(res, 400, { error: 'invalid_next', message: 'Redirect target "next" must be a relative path.' });
          return true;
        }
        const validated = validateUnlockNextPath(record.next);
        if (validated === null) {
          writeJson(res, 400, {
            error: 'invalid_next',
            message: 'Refused unsafe redirect target; only relative paths starting with / are allowed.',
          });
          return true;
        }
        nextPath = validated;
      }

      if (!timingSafeTokenMatch(rawToken.trim(), options.sessionToken)) {
        const retryAfter = recordFailure(peerKey, timestamp);
        if (retryAfter !== null) {
          writeJson(
            res,
            429,
            {
              error: 'rate_limited',
              retryAfter,
              message: `Too many failed unlock attempts. Retry after ${retryAfter}s.`,
            },
            { 'Retry-After': String(retryAfter) },
          );
          return true;
        }
        writeJson(res, 401, {
          error: 'invalid_token',
          message: 'Invalid session capability token.',
        });
        return true;
      }

      failures.delete(peerKey);
      setUnlockSecurityHeaders(res);
      appendSetCookieHeader(res, formatSessionCookie(options.sessionToken), {
        effectiveScheme: originCheck.scheme,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, next: nextPath }));
      return true;
    }

    if (url.pathname === LOGOUT_PATH) {
      if (!checkHostAndPeer(req, res)) return true;
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') {
        setUnlockSecurityHeaders(res);
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return true;
      }
      const originCheck = checkSameOriginPost(req, proxyPolicy);
      if (!originCheck.ok) {
        writeJson(res, 403, { error: 'cross_origin_refused', message: originCheck.message });
        return true;
      }
      setUnlockSecurityHeaders(res);
      appendClearedCookieHeaders(req, res, originCheck.scheme);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    return false;
  };
}
