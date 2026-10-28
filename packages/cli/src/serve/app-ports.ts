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
 * `same-origin`, which the browser sets and a page cannot change. The page
 * Next serves fetches `/__pyric/*` from Next's own origin, and the proxy
 * passes the header through. A page on another port that sends the request
 * itself, even with an `x-forwarded-host` it chose, is `same-site` at most,
 * so it teaches nothing. A proxy names its own host, never the page's, so a
 * page on another port that goes through the proxy is still refused. Only
 * loopback names and the bound host are learned; a name allowed through
 * `--allowed-host` (a tunnel) is never port-checked in the first place.
 *
 * Only the standalone server learns (`learnsProxyPorts`). A mount inside a
 * dev server, such as the Vite plugin's, serves the page on the connection's
 * own port, and that dev server may answer cross-origin preflights for
 * `/__pyric/*` paths it does not handle.
 */
import type { IncomingMessage } from 'node:http';
import { getHeader, isAllowedHost } from './server.js';

/** A dev server proxies from one port; a handful covers restarts on new ports. */
const MAX_LEARNED_PORTS = 8;

export interface AppPorts {
  /** Records the proxy port a same-origin forwarded request names. */
  learn(req: IncomingMessage): void;
  /** The ports a page's Origin may name on this request's connection. */
  forRequest(req: IncomingMessage): number[];
  /**
   * The same, plus the proxy's port when a proxy forwarded this WebSocket
   * upgrade from the page it serves: the Origin names the host the proxy
   * names in `x-forwarded-host`. A browser cannot put a header on a
   * WebSocket handshake, so only a proxy can name that host, and it names
   * its own. The page may open its socket before any same-origin request
   * has gone through the proxy, as the Node host's page under Next does.
   */
  forUpgrade(req: IncomingMessage): number[];
}

export function createAppPorts(boundHost: string): AppPorts {
  const learned = new Set<number>();
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
      const port = forwardedLoopbackPort(getHeader(req, 'x-forwarded-host'), boundHost);
      const namesNoPort = port === undefined;
      if (namesNoPort) return;
      learned.delete(port);
      learned.add(port);
      const isOverCapacity = learned.size > MAX_LEARNED_PORTS;
      if (isOverCapacity) learned.delete(learned.values().next().value as number);
    },
    forRequest,
    forUpgrade(req) {
      const ports = forRequest(req);
      const proxyPort = proxiedPagePort(req, boundHost);
      const isProxiedFromItsPage = proxyPort !== undefined;
      if (isProxiedFromItsPage) ports.push(proxyPort);
      return ports;
    },
  };
}

/** The proxy's port when the Origin names the host `x-forwarded-host` names, else `undefined`. */
function proxiedPagePort(req: IncomingMessage, boundHost: string): number | undefined {
  const forwardedHost = getHeader(req, 'x-forwarded-host');
  const originHeader = getHeader(req, 'origin');
  const lacksEither = forwardedHost === undefined || originHeader === undefined;
  if (lacksEither) return undefined;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return undefined;
  }
  const namesTheProxy = origin.host.toLowerCase() === forwardedHost.trim().toLowerCase();
  if (!namesTheProxy) return undefined;
  return forwardedLoopbackPort(forwardedHost, boundHost);
}

/** The port in a single loopback `x-forwarded-host`, else `undefined`. */
function forwardedLoopbackPort(forwardedHost: string | undefined, boundHost: string): number | undefined {
  const hasNoForwardedHost = forwardedHost === undefined || forwardedHost.trim() === '';
  if (hasNoForwardedHost) return undefined;
  const namesSeveralHosts = forwardedHost.includes(',');
  if (namesSeveralHosts) return undefined;
  let forwarded: URL;
  try {
    forwarded = new URL(`http://${forwardedHost.trim()}`);
  } catch {
    return undefined;
  }
  const isLoopback = isAllowedHost(forwarded.hostname, boundHost);
  if (!isLoopback) return undefined;
  const namesNoPort = forwarded.port === '';
  if (namesNoPort) return 80;
  return Number(forwarded.port);
}
