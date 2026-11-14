import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
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
 * We accept only loopback hostnames + the host the server was bound to +
 * any `--allowed-host`. A request with NO Host header is allowed (curl /
 * same-origin fetches omit nothing in practice, but non-browser clients may;
 * the attack requires a browser sending the attacker's Host).
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  boundHost: string,
  extra: string[] = [],
): boolean {
  if (!hostHeader) return true; // no Host -> not a browser rebinding attack
  const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const boundHostname = boundHost.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || isLoopbackAddress(hostname) || hostname === boundHostname) {
    return true;
  }
  const allowed = new Set(
    extra.map((h) => h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()),
  );
  return allowed.has(hostname);
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

export function appendSetCookieHeader(res: ServerResponse, cookie: string): void {
  let effectiveCookie = cookie;
  const socket = res.socket as (Socket & { encrypted?: boolean }) | null | undefined;
  if (effectiveCookie.startsWith(`${PYRIC_SESSION_COOKIE_NAME}=`)) {
    const localPort = socket?.localPort;
    if (localPort !== undefined && Number.isInteger(localPort) && localPort > 0) {
      effectiveCookie = `${sessionCookieNameForPort(localPort)}=${effectiveCookie.slice(PYRIC_SESSION_COOKIE_NAME.length + 1)}`;
    }
  }
  if (
    socket?.encrypted === true &&
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

/**
 * Origin allowlist for WebSocket `upgrade` handshakes and local endpoint requests.
 * A browser sends an `Origin` header carrying the page's origin; a hostile page
 * that connects to our loopback server sends ITS OWN cross-origin Origin,
 * which we reject.
 *
 * Enforces that the Origin's hostname is an allowed host, and when the bound
 * port is known (from `boundPort`, or as `:port` on `boundHost`), that the
 * Origin's port, or its scheme's default, is that port: another app on another
 * local port is a different origin. A hostname allowed only through `extra`
 * (a tunnel, say) reaches the server on its default public port (`originUrl.port === ''`),
 * while an explicit non-default port on that hostname must match `boundPort` or an
 * explicit `host:port` entry in `extra`.
 *
 * A missing `Origin` is allowed: non-browser clients (curl, CLI peers, tests)
 * are not the cross-origin hijack vector.
 */
export function isAllowedOrigin(
  originHeader: string | undefined,
  boundHost: string,
  extra: string[] = [],
  boundPort?: number,
  expectedScheme?: 'http:' | 'https:',
): boolean {
  if (!originHeader) return true; // no Origin -> non-browser client, not a hijack
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false; // malformed Origin -> reject
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return false;
  }
  const hostname = originUrl.hostname; // may be `[::1]` -- isAllowedHost strips brackets
  const allowedHost = isAllowedHost(hostname, boundHost, extra);
  if (!allowedHost) return false;
  const normalizedHost = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowedByName = !isAllowedHost(hostname, boundHost) && isAllowedHost(hostname, boundHost, extra);
  const portOnHost = /:(\d+)$/.exec(boundHost)?.[1];
  let expectedPort = boundPort;
  if (expectedPort === undefined && portOnHost !== undefined) {
    expectedPort = Number(portOnHost);
  }
  if (allowedByName) {
    if (originUrl.port === '' || expectedPort === undefined) return true;
    const explicitHostPort = `${normalizedHost}:${originUrl.port}`;
    const hasExplicitExtraPort = extra.some(
      (entry) => entry.replace(/^\[|\]$/g, '').toLowerCase() === explicitHostPort,
    );
    return hasExplicitExtraPort || Number(originUrl.port) === expectedPort;
  }
  if (expectedScheme !== undefined && originUrl.protocol !== expectedScheme) {
    return false;
  }
  const portUnknown = expectedPort === undefined;
  if (portUnknown) return true;
  const defaultPort = originUrl.protocol === 'https:' ? 443 : 80;
  const originPort = originUrl.port === '' ? defaultPort : Number(originUrl.port);
  return originPort === expectedPort;
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
  extra: string[],
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
  const scheme = requestSocketScheme(req);
  return !learnedSecondaryPorts.some((port) =>
    isAllowedOrigin(originHeader, boundHost, [], port, scheme),
  );
}

/**
 * The combined guard for a WS `upgrade` request: BOTH the `Host` header
 * (DNS-rebinding) AND the `Origin` header (cross-origin hijack) must pass.
 * `upgrade` is a separate listener from the HTTP `request` event, so the
 * static server's request-time `isAllowedHost` never runs on it -- every
 * upgrade mount point must call this before `wss.handleUpgrade`.
 *
 * Pass `appPorts` (the socket's `localPort`, plus any port `createAppPorts`
 * learned) so a page on another local port is refused; without it only the
 * Origin's hostname is compared.
 */
export function isAllowedUpgrade(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  boundHost: string,
  extra: string[] = [],
  appPorts?: readonly number[],
  expectedScheme?: 'http:' | 'https:',
): boolean {
  const req = { headers };
  return (
    isAllowedHost(getHeader(req, 'host'), boundHost, extra) &&
    isAllowedOriginOnPorts(getHeader(req, 'origin'), boundHost, extra, appPorts, expectedScheme) &&
    !isForeignFetchSite(req, boundHost, appPorts)
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
 * Validates that an incoming HTTP request complies with loopback Host
 * (DNS-rebinding), Origin (cross-origin hijacking), and Sec-Fetch-Site restrictions.
 *
 * Pass `appPorts` (the socket's `localPort`, plus any port `createAppPorts`
 * learned) so a page on another local port is refused; without it only the
 * Origin's hostname is compared.
 */
export function isAllowedLoopbackRequest(
  req: {
    headers?: IncomingHttpHeaders | Record<string, string | string[] | undefined> | Headers;
    socket?: object | null;
  },
  boundHost: string,
  extra: string[] = [],
  appPorts?: readonly number[],
): boolean {
  const hostHeader = getHeader(req, 'host');
  const originHeader = getHeader(req, 'origin');
  const scheme = requestSocketScheme(req);
  return (
    isAllowedHost(hostHeader, boundHost, extra) &&
    isAllowedOriginOnPorts(originHeader, boundHost, extra, appPorts, scheme) &&
    !isForeignFetchSite(req, boundHost, appPorts)
  );
}

/**
 * Determines whether an HTML response may stamp `sessionToken` into inline init
 * scripts and emit `Set-Cookie: __pyric_session_<port>`.
 *
 * Requires a loopback socket peer AND a loopback/bound `Host` header (ignoring
 * `--allowed-host` / Vite `allowedHosts: true` and rejecting wildcard `0.0.0.0` / `::`,
 * so tunnel/rebound hosts never receive session capabilities), refuses foreign
 * `Origin` headers (port-aware), and refuses cross-site / cross-port Fetch Metadata
 * unless the request is a top-level document navigation
 * (`Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`).
 */
export function canBootstrapHtmlSession(
  req: IncomingMessage,
  boundHost = 'localhost',
  appPorts?: readonly number[],
): boolean {
  if (!isLocalPeer(req)) return false;
  const hostHeader = getHeader(req, 'host');
  const hostname = hostHeader?.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === '0.0.0.0' || hostname === '::') return false;
  if (!isAllowedHost(hostHeader, boundHost)) return false;
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
