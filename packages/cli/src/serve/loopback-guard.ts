import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  hasExplicitAllowedHostPort,
  isWildcardHostname,
  matchesAnyAllowedHost,
  parseHostHeader,
  type ParsedHost,
} from './host-pattern.js';
import { isLocalPeer, isLoopbackAddress } from './peer.js';

export { isLocalPeer, isLoopbackAddress };

/**
 * DNS-rebinding guard. A dev server bound to localhost is reachable by any
 * webpage whose hostname resolves to 127.0.0.1 (`attacker.com` -> A
 * 127.0.0.1): the victim's browser then treats `http://attacker.com:PORT`
 * as same-origin to the attacker's page and can read/write our endpoints --
 * including `/__pyric/state` (auth users + plaintext passwords, and writes).
 * Vite addresses the same class with `server.allowedHosts`.
 *
 * Accepts strictly well-formed `host` or `host:port` values matching loopback
 * hostnames, a non-wildcard bound host, or `--allowed-host` (including strict
 * Vite-aligned leading-dot subdomain suffixes with >= 2 DNS labels). Wildcard
 * bind addresses (`0.0.0.0`, `::`, `::ffff:0.0.0.0`) are never accepted even
 * when the listener is wildcard-bound. A request with NO `Host` header
 * (`undefined`) is allowed for non-browser callers.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  boundHost: string,
  extra: readonly string[] = [],
): boolean {
  if (hostHeader === undefined) return true;
  const parsed = parseHostHeader(hostHeader);
  if (parsed === null || isWildcardHostname(parsed.hostname)) return false;
  const parsedBound = parseHostHeader(boundHost);
  let boundHostname: string | null = null;
  if (parsedBound !== null && !isWildcardHostname(parsedBound.hostname)) {
    boundHostname = parsedBound.hostname;
  }
  if (
    parsed.hostname === 'localhost' ||
    isLoopbackAddress(parsed.hostname) ||
    (boundHostname !== null && parsed.hostname === boundHostname)
  ) {
    return true;
  }
  return matchesAnyAllowedHost(parsed, extra);
}

export const PYRIC_SESSION_COOKIE_NAME = '__pyric_session';

export function sessionCookieNameForPort(port?: number): string {
  if (port !== undefined && Number.isInteger(port) && port > 0) {
    return `${PYRIC_SESSION_COOKIE_NAME}_${port}`;
  }
  return PYRIC_SESSION_COOKIE_NAME;
}

export function formatSessionCookie(
  sessionToken: string,
  options?: { port?: number; secure?: boolean },
): string {
  const cookieName = sessionCookieNameForPort(options?.port);
  const secureAttr = options?.secure === true ? '; Secure' : '';
  return `${cookieName}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/__pyric${secureAttr}`;
}

export function appendSetCookieHeader(
  res: ServerResponse,
  cookie: string,
  options?: { effectiveScheme?: 'http:' | 'https:'; secure?: boolean },
): void {
  let effectiveCookie = cookie;
  const socket = res.socket as (Socket & { encrypted?: boolean }) | null | undefined;
  if (effectiveCookie.startsWith(`${PYRIC_SESSION_COOKIE_NAME}=`)) {
    const localPort = socket?.localPort;
    if (localPort !== undefined && Number.isInteger(localPort) && localPort > 0) {
      effectiveCookie = `${sessionCookieNameForPort(localPort)}=${effectiveCookie.slice(PYRIC_SESSION_COOKIE_NAME.length + 1)}`;
    }
  }
  const isSecureTransport =
    socket?.encrypted === true ||
    options?.secure === true ||
    options?.effectiveScheme === 'https:';
  if (
    isSecureTransport &&
    effectiveCookie.startsWith(PYRIC_SESSION_COOKIE_NAME) &&
    !/;\s*secure\b/i.test(effectiveCookie)
  ) {
    effectiveCookie = `${effectiveCookie}; Secure`;
  }
  const existing = res.getHeader('set-cookie');
  if (existing === undefined) {
    res.setHeader('set-cookie', effectiveCookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('set-cookie', [...existing.map(String), effectiveCookie]);
  } else {
    res.setHeader('set-cookie', [String(existing), effectiveCookie]);
  }
}

export function requestSocketScheme(
  req: { socket?: object | null } | undefined,
): 'http:' | 'https:' | undefined {
  const socket = req?.socket as { encrypted?: boolean } | null | undefined;
  if (!socket) return undefined;
  if (socket.encrypted === true) return 'https:';
  if (socket.encrypted === false) return 'http:';
  if (socket instanceof Socket) return 'http:';
  return undefined;
}

function parseSerializedOrigin(rawOrigin: string): {
  url: URL;
  authority: string;
  parsedAuthority: ParsedHost;
} | null {
  const trimmed = rawOrigin.trim();
  const schemeMatch = /^(https?):\/\/(.*)$/i.exec(trimmed);
  if (schemeMatch === null) return null;
  const authority = schemeMatch[2];
  if (authority === undefined || authority === '' || /[\s/\\?#@]/.test(authority)) return null;
  const parsedAuthority = parseHostHeader(authority);
  if (parsedAuthority === null) return null;
  try {
    const url = new URL(trimmed);
    if (url.username !== '' || url.password !== '') return null;
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
    return { url, authority, parsedAuthority };
  } catch {
    return null;
  }
}

/**
 * Origin allowlist for WebSocket `upgrade` handshakes and local endpoint requests.
 * Requires a strictly serialized `http:` or `https:` origin (`scheme://host[:port]`
 * with no userinfo, path, query, or fragment) matching an allowed host and port.
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  boundHost: string,
  extra: readonly string[] = [],
  boundPort?: number,
  expectedScheme?: 'http:' | 'https:',
): boolean {
  if (originHeader === undefined) return true;
  const parsedOrigin = parseSerializedOrigin(originHeader);
  if (parsedOrigin === null) return false;
  const { url: originUrl, authority, parsedAuthority } = parsedOrigin;
  if (!isAllowedHost(authority, boundHost, extra)) return false;

  const allowedByName = !isAllowedHost(authority, boundHost);
  const expectedPort = boundPort ?? parseHostHeader(boundHost)?.port;
  const defaultPort = originUrl.protocol === 'https:' ? 443 : 80;
  const effectiveOriginPort = parsedAuthority.port ?? defaultPort;

  if (allowedByName) {
    if (expectedScheme === 'https:' && originUrl.protocol !== 'https:') {
      return false;
    }
    if (hasExplicitAllowedHostPort(parsedAuthority.hostname, effectiveOriginPort, extra)) {
      return true;
    }
    if (originUrl.port === '') return true;
    if (expectedScheme !== undefined && originUrl.protocol !== expectedScheme) {
      return false;
    }
    if (expectedPort === undefined) return true;
    return effectiveOriginPort === expectedPort;
  }

  if (expectedScheme !== undefined && originUrl.protocol !== expectedScheme) {
    return false;
  }
  if (expectedPort === undefined) return true;
  return effectiveOriginPort === expectedPort;
}

/**
 * Same-origin check for wildcard-allowed hosts (`allowedHosts: true`):
 * requires a strictly serialized `http:` or `https:` origin matching `Host`
 * (no userinfo, path, query, fragment, or wildcard address) and enforces the
 * listener scheme on loopback/bound hosts and explicit-port origins while
 * allowing default-port HTTPS tunnels over a plain HTTP listener.
 */
export function isSameOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  boundHost = 'localhost',
  expectedScheme?: 'http:' | 'https:',
): boolean {
  if (originHeader === undefined) return true;
  if (hostHeader === undefined) return false;
  const parsedOrigin = parseSerializedOrigin(originHeader);
  const parsedHost = parseHostHeader(hostHeader);
  if (parsedOrigin === null || parsedHost === null) return false;
  if (isWildcardHostname(parsedHost.hostname)) return false;
  const { url: originUrl, authority, parsedAuthority } = parsedOrigin;
  if (parsedAuthority.hostname !== parsedHost.hostname) return false;

  const defaultPort = originUrl.protocol === 'https:' ? 443 : 80;
  const effectiveOriginPort = parsedAuthority.port ?? defaultPort;
  const expectedHostPort = parsedHost.port ?? defaultPort;
  if (effectiveOriginPort !== expectedHostPort) return false;

  if (expectedScheme === 'https:' && originUrl.protocol !== 'https:') {
    return false;
  }
  const isLocalOrBound = isAllowedHost(authority, boundHost);
  if (isLocalOrBound) {
    if (expectedScheme !== undefined && originUrl.protocol !== expectedScheme) {
      return false;
    }
    return true;
  }
  if (originUrl.port === '') return true;
  if (expectedScheme !== undefined && originUrl.protocol !== expectedScheme) {
    return false;
  }
  return true;
}

/**
 * The Origin check once the app's ports are known: the Origin must name one of
 * them. Both a page this app serves and a page on another local port are
 * loopback, so only the port tells them apart. `undefined` means the ports
 * are not known, and only the Origin's hostname is compared.
 */
export function isAllowedOriginOnPorts(
  originHeader: string | undefined,
  boundHost: string,
  extra: readonly string[],
  appPorts: readonly number[] | undefined,
  expectedScheme?: 'http:' | 'https:',
): boolean {
  const portsUnknown = appPorts === undefined || appPorts.length === 0;
  if (portsUnknown) return isAllowedOrigin(originHeader, boundHost, extra, undefined, expectedScheme);
  return appPorts.some((port) => isAllowedOrigin(originHeader, boundHost, extra, port, expectedScheme));
}

/**
 * Rejects browser fetches marked `Sec-Fetch-Site: cross-site | same-site`, whether
 * `Origin` is omitted or present, unless `Origin` names a learned secondary local
 * proxy port in `appPorts` (such as Next.js `3000` connecting to `3473`).
 */
export function isForeignFetchSite(
  req: {
    headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
    socket?: object | null;
  },
  boundHost = 'localhost',
  appPorts?: readonly number[],
  expectedScheme?: 'http:' | 'https:',
  extra: readonly string[] = [],
): boolean {
  const secFetchSite = getHeader(req, 'sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite !== 'cross-site' && secFetchSite !== 'same-site') {
    return false;
  }
  const originHeader = getHeader(req, 'origin');
  if (!originHeader) return true;
  let learnedSecondaryPorts: readonly number[] = [];
  if (appPorts !== undefined && appPorts.length > 1) {
    learnedSecondaryPorts = appPorts.slice(1);
  }
  if (learnedSecondaryPorts.length === 0) return true;
  const scheme = expectedScheme ?? requestSocketScheme(req);
  return !learnedSecondaryPorts.some((port) =>
    isAllowedOrigin(originHeader, boundHost, extra, port, scheme),
  );
}

/**
 * The combined guard for a WS `upgrade` request: BOTH the `Host` header
 * (DNS-rebinding) AND the `Origin` header (cross-origin hijack) must pass.
 */
export function isAllowedUpgrade(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  boundHost: string,
  extra: readonly string[] = [],
  appPorts?: readonly number[],
  expectedScheme?: 'http:' | 'https:',
): boolean {
  const req = { headers };
  return (
    isAllowedHost(getHeader(req, 'host'), boundHost, extra) &&
    isAllowedOriginOnPorts(getHeader(req, 'origin'), boundHost, extra, appPorts, expectedScheme) &&
    !isForeignFetchSite(req, boundHost, appPorts, expectedScheme, extra)
  );
}

/**
 * Extract a header value case-insensitively from either Node's IncomingMessage headers
 * or Fetch API Headers object.
 */
export function getHeader(
  req: { headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers },
  name: string,
): string | undefined {
  const headers = req?.headers;
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const val = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  if (Array.isArray(val)) return val.join(', ');
  return val;
}

/**
 * Rejects browser fetches when Fetch Metadata marks the initiator as
 * `cross-site` or `same-site` (including another local port). Non-browser CLI/MCP/SDK
 * requests carry neither `Origin` nor `Sec-Fetch-Site` and return false here.
 */
export function isForeignFetchWithoutOrigin(
  req: { headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers },
): boolean {
  return isForeignFetchSite(req);
}

/**
 * Constant-time comparison for capability tokens.
 * Fails closed if either token is missing or empty.
 */
export function timingSafeTokenMatch(
  presented: string | undefined,
  expected: string | undefined,
): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractSessionCookies(cookieHeader: string | undefined, expectedPort?: number): string[] {
  if (!cookieHeader) return [];
  let portCookieName: string | undefined;
  if (expectedPort !== undefined && Number.isInteger(expectedPort) && expectedPort > 0) {
    portCookieName = sessionCookieNameForPort(expectedPort);
  }
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    let matchesCookieName = name === PYRIC_SESSION_COOKIE_NAME;
    if (!matchesCookieName) {
      if (portCookieName !== undefined) {
        matchesCookieName = name === portCookieName;
      } else {
        matchesCookieName = /^__pyric_session_\d+$/.test(name);
      }
    }
    if (!matchesCookieName) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

/**
 * Validates a session capability token from the `x-pyric-session-token` header
 * or the `__pyric_session` / `__pyric_session_<port>` HttpOnly cookie using constant-time comparison.
 * Query-string `?token=` parameters are ignored. Fails closed if `expectedToken`
 * is omitted or empty.
 */
export function isAllowedSessionToken(
  req: {
    headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
    socket?: { localPort?: number } | null;
  },
  url: URL | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return false;
  const headerToken = getHeader(req, 'x-pyric-session-token');
  if (headerToken !== undefined && timingSafeTokenMatch(headerToken, expectedToken)) {
    return true;
  }
  const socketPort = req?.socket?.localPort;
  let urlPort: number | undefined;
  if (url?.port) {
    urlPort = Number(url.port);
  }
  let expectedPort = urlPort;
  if (socketPort !== undefined && socketPort > 0) {
    expectedPort = socketPort;
  }
  const cookies = extractSessionCookies(getHeader(req, 'cookie'), expectedPort);
  return cookies.some((cookie) => timingSafeTokenMatch(cookie, expectedToken));
}

/**
 * Distinguish how an unauthenticated request attempted to present a session
 * capability token: via explicit `x-pyric-session-token` header, via a
 * matching `__pyric_session` / `__pyric_session_<port>` cookie, or neither.
 *
 * Explicit headers always take precedence so a client presenting a wrong
 * `x-pyric-session-token` header is rejected without triggering browser unlock
 * prompts, whereas a browser carrying only a stale cookie from an earlier
 * server boot can still be guided back to `/__pyric/unlock`.
 */
export function presentedSessionTokenKind(
  req: {
    headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
    socket?: { localPort?: number } | null;
  },
  url?: URL,
): 'none' | 'header' | 'cookie' {
  const headerToken = getHeader(req, 'x-pyric-session-token');
  if (headerToken !== undefined && headerToken.length > 0) {
    return 'header';
  }
  const socketPort = req?.socket?.localPort;
  let urlPort: number | undefined;
  if (url?.port) {
    urlPort = Number(url.port);
  }
  let expectedPort = urlPort;
  if (socketPort !== undefined && socketPort > 0) {
    expectedPort = socketPort;
  }
  const cookies = extractSessionCookies(getHeader(req, 'cookie'), expectedPort);
  if (cookies.length > 0) {
    return 'cookie';
  }
  return 'none';
}

/**
 * Validates that an incoming HTTP request complies with loopback Host
 * (DNS-rebinding), Origin (cross-origin hijacking), and Sec-Fetch-Site restrictions.
 */
export function isAllowedLoopbackRequest(
  req: {
    headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
    socket?: object | null;
  },
  boundHost: string,
  extra: readonly string[] = [],
  appPorts?: readonly number[],
  expectedScheme?: 'http:' | 'https:',
): boolean {
  const hostHeader = getHeader(req, 'host');
  const originHeader = getHeader(req, 'origin');
  const scheme = expectedScheme ?? requestSocketScheme(req);
  return (
    isAllowedHost(hostHeader, boundHost, extra) &&
    isAllowedOriginOnPorts(originHeader, boundHost, extra, appPorts, scheme) &&
    !isForeignFetchSite(req, boundHost, appPorts, scheme, extra)
  );
}

/**
 * Determines whether an HTML response may stamp `sessionToken` into inline init
 * scripts and emit `Set-Cookie: __pyric_session_<port>`.
 */
export function canBootstrapHtmlSession(
  req: IncomingMessage,
  boundHost = 'localhost',
  appPorts?: readonly number[],
): boolean {
  if (!isLocalPeer(req)) return false;
  if (!isAllowedHost(getHeader(req, 'host'), boundHost)) return false;
  let ports = appPorts;
  if (ports === undefined && req.socket?.localPort) {
    ports = [req.socket.localPort];
  }
  const scheme = requestSocketScheme(req);
  if (!isAllowedOriginOnPorts(getHeader(req, 'origin'), boundHost, [], ports, scheme)) return false;
  const secFetchSite = getHeader(req, 'sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'cross-site' || secFetchSite === 'same-site') {
    const secFetchMode = getHeader(req, 'sec-fetch-mode')?.trim().toLowerCase();
    const secFetchDest = getHeader(req, 'sec-fetch-dest')?.trim().toLowerCase();
    if (secFetchMode !== 'navigate' || secFetchDest !== 'document') {
      return false;
    }
  }
  return true;
}
