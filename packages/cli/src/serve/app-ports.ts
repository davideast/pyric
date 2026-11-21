/**
 * The ports a page of this app may name in its `Origin` when it opens the
 * bridge socket or calls a control route.
 *
 * A page this server serves names the server's own port. Under a dev server
 * that proxies `/__pyric/*` to this one, such as `withPyric`'s rewrite under
 * `pyric sandbox -- next dev`, the page loads from the dev server, so its
 * Origin names the dev server's port instead. The proxy says which port that
 * is: it forwards each request with `x-forwarded-host` set to the host the
 * browser asked it for. A socket the proxy forwards (the Node host's page)
 * carries that header itself. A socket that comes straight to this server
 * (the SharedWorker sandbox) does not, but the page's `/__pyric/init.json`
 * went through the proxy before the page learned the bridge URL, so the
 * port was learned from that request.
 *
 * Only a same-origin request teaches a port: one whose `sec-fetch-site` is
 * `same-origin`, which the browser sets and a page cannot change. A page on
 * another port sends `same-site` at most and teaches nothing. Non-loopback
 * `allowedHosts` entries are learned ONLY when `trustProxy` trusts the
 * immediate TCP peer, so untrusted clients cannot poison learned ports.
 */
import type { IncomingMessage } from 'node:http';
import {
  effectiveRequestScheme,
  isTrustedProxyPeer,
  parseTrustProxySetting,
  type TrustProxyPolicy,
} from './guard-policy.js';
import { getHeader, isAllowedHost } from './loopback-guard.js';

/** A dev server proxies from one port; a handful covers restarts on new ports. */
const MAX_LEARNED_PORTS = 8;

export interface AppPortsOptions {
  /** Explicit non-loopback hosts eligible for port learning when behind a trusted proxy. */
  readonly allowedHosts?: readonly string[];
  /** Reverse-proxy trust policy controlling non-loopback `x-forwarded-host` port learning. */
  readonly trustProxy?: false | 'loopback' | readonly string[];
}

export interface AppPorts {
  /** Records the proxy port a same-origin forwarded request names. */
  learn(req: IncomingMessage): void;
  /** The ports a page's Origin may name on this request's connection. */
  forRequest(req: IncomingMessage): number[];
  /**
   * The same, plus the proxy's port when a proxy forwarded this WebSocket
   * upgrade from the page it serves: the Origin names the host the proxy
   * names in `x-forwarded-host`.
   */
  forUpgrade(req: IncomingMessage): number[];
}

export function createAppPorts(boundHost: string, options?: AppPortsOptions): AppPorts {
  const learned = new Set<number>();
  const trustProxy: TrustProxyPolicy = parseTrustProxySetting(options?.trustProxy);
  const allowedExtraHosts = options?.allowedHosts ?? [];
  const forRequest = (req: IncomingMessage): number[] => {
    const ports = [...learned];
    const localPort = req.socket?.localPort;
    const hasLocalPort = typeof localPort === 'number';
    if (hasLocalPort) ports.unshift(localPort);
    return ports;
  };
  return {
    learn(req) {
      const isSameOrigin = getHeader(req, 'sec-fetch-site') === 'same-origin';
      if (!isSameOrigin) return;
      const trustedProxy = isTrustedProxyPeer(req, trustProxy);
      const extraHosts = trustedProxy ? allowedExtraHosts : [];
      const scheme = effectiveRequestScheme(req, trustProxy);
      const port = forwardedHostPort(getHeader(req, 'x-forwarded-host'), boundHost, extraHosts, scheme);
      if (port === undefined) return;
      learned.delete(port);
      learned.add(port);
      if (learned.size > MAX_LEARNED_PORTS) {
        const oldest = learned.values().next().value;
        if (typeof oldest === 'number') learned.delete(oldest);
      }
    },
    forRequest,
    forUpgrade(req) {
      const ports = forRequest(req);
      const trustedProxy = isTrustedProxyPeer(req, trustProxy);
      const extraHosts = trustedProxy ? allowedExtraHosts : [];
      const scheme = effectiveRequestScheme(req, trustProxy);
      const proxyPort = proxiedPagePort(req, boundHost, extraHosts, scheme);
      if (proxyPort !== undefined) ports.push(proxyPort);
      return ports;
    },
  };
}

/** The proxy's port when the Origin names the host `x-forwarded-host` names, else `undefined`. */
function proxiedPagePort(
  req: IncomingMessage,
  boundHost: string,
  extraHosts: readonly string[],
  scheme: 'http:' | 'https:' | undefined,
): number | undefined {
  const forwardedHost = getHeader(req, 'x-forwarded-host');
  const originHeader = getHeader(req, 'origin');
  if (forwardedHost === undefined || originHeader === undefined) return undefined;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return undefined;
  }
  const namesTheProxy = origin.host.toLowerCase() === forwardedHost.trim().toLowerCase();
  if (!namesTheProxy) return undefined;
  return forwardedHostPort(forwardedHost, boundHost, extraHosts, scheme);
}

/** The port in a single allowed `x-forwarded-host`, else `undefined`. */
function forwardedHostPort(
  forwardedHost: string | undefined,
  boundHost: string,
  extraHosts: readonly string[],
  scheme: 'http:' | 'https:' | undefined,
): number | undefined {
  if (forwardedHost === undefined || forwardedHost.trim() === '') return undefined;
  if (forwardedHost.includes(',')) return undefined;
  const trimmed = forwardedHost.trim();
  let forwarded: URL;
  try {
    forwarded = new URL(`http://${trimmed}`);
  } catch {
    return undefined;
  }
  if (!isAllowedHost(forwarded.host, boundHost, extraHosts)) return undefined;
  if (forwarded.port === '') {
    return scheme === 'https:' ? 443 : 80;
  }
  const port = Number(forwarded.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return port;
}
