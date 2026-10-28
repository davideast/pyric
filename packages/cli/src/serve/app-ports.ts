/**
 * The ports a page of this app may name in its `Origin` when it opens the
 * bridge socket or calls a control route.
 *
 * A page this server serves names the server's own port. Under a dev server
 * that proxies `/__pyric/*` to this one, such as `withPyric`'s rewrite under
 * `pyric sandbox -- next dev`, the page loads from the dev server, so its
 * Origin names the dev server's port instead. The proxy says which port that
 * is: it forwards each request with `x-forwarded-host` set to the host the
 * browser asked it for. The page's first `/__pyric/init.json` goes through it
 * before the page learns the bridge URL, so the port is known by the time
 * the page connects, whether the socket goes through the proxy too (the Node
 * host) or straight to this server (the SharedWorker sandbox).
 *
 * A browser page cannot make this server learn a port of its own: a WebSocket
 * handshake takes no custom headers, a no-cors request refuses them, and a
 * CORS request with one needs a preflight these routes never grant. A proxy
 * names its own host, never the page's, so a page on another port that goes
 * through the proxy teaches nothing new and is still refused. Only loopback
 * names and the bound host are learned; a name allowed through
 * `--allowed-host` (a tunnel) is never port-checked in the first place.
 */
import type { IncomingMessage } from 'node:http';
import { getHeader, isAllowedHost } from './server.js';

/** A dev server proxies from one port; a handful covers restarts on new ports. */
const MAX_LEARNED_PORTS = 8;

export interface AppPorts {
  /** Records the proxy port a forwarded request names. */
  learn(req: IncomingMessage): void;
  /** The ports a page's Origin may name on this request's connection. */
  forRequest(req: IncomingMessage): number[];
}

export function createAppPorts(boundHost: string): AppPorts {
  const learned = new Set<number>();
  return {
    learn(req) {
      const port = forwardedLoopbackPort(getHeader(req, 'x-forwarded-host'), boundHost);
      const namesNoPort = port === undefined;
      if (namesNoPort) return;
      learned.delete(port);
      learned.add(port);
      const isOverCapacity = learned.size > MAX_LEARNED_PORTS;
      if (isOverCapacity) learned.delete(learned.values().next().value as number);
    },
    forRequest(req) {
      const ports = [...learned];
      const localPort = req.socket?.localPort;
      const hasLocalPort = typeof localPort === 'number';
      if (hasLocalPort) ports.unshift(localPort);
      return ports;
    },
  };
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
