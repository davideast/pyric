/**
 * Where the served entries find their host.
 *
 * A page finds it from its own location: `/__pyric/init.json` on its origin,
 * the `<meta name="pyric-sandbox-host">` declaration, and the payload the
 * served HTML stamps into `__PYRIC_WORKER_INIT__`. A Node process that
 * `@pyric/cli/register` activated against the Node host (#1082) has none of
 * these, so its bootstrap installs a Node origin before any entry loads: the
 * host's base url, resolved like `remoteSandbox()` resolves it, and the
 * socket realm the hosted connection uses in Node. The entries never set or
 * read `location`, `window` or `document` for a Node origin.
 */
import type { HostedSocketRealm } from '../worker/client/websocket-connection.js';

/** A host location the hosted client can turn into its `init.json` and socket urls. */
export interface HostLocation {
  href: string;
  protocol: string;
  host: string;
}

export interface NodeRuntimeOrigin {
  readonly realm: 'node';
  /**
   * The Node host's base url (`http://127.0.0.1:5173`), once discovery
   * settles. Discovery starts at the first call, so importing an SDK opens nothing.
   */
  readonly host: () => Promise<string>;
  /**
   * The connection to the host was lost: the next `host()` resolves it again,
   * as `pyric-admin`'s remote sandbox does at each connect, so a host that
   * came back on another port is found there.
   */
  readonly forgetHost?: () => void;
  /** The socket and event-loop behavior of a hosted connection in Node. */
  readonly socketRealm: HostedSocketRealm;
  /** Raised for every call when the host is not a Node host. */
  readonly offHostError: (detail: string) => Error;
}

let nodeOrigin: NodeRuntimeOrigin | undefined;

/** Installed once by the Node bootstrap, before the first served entry evaluates. */
export function installNodeRuntimeOrigin(origin: NodeRuntimeOrigin): void {
  const isInstalled = nodeOrigin !== undefined;
  if (isInstalled) throw new Error('pyric: the Node runtime origin is already installed');
  nodeOrigin = origin;
}

/** The Node origin, or undefined on a page. */
export function nodeRuntimeOrigin(): NodeRuntimeOrigin | undefined {
  return nodeOrigin;
}

/** The url `init.json` is fetched from: page-relative, or on the Node host. */
export async function initPayloadUrl(): Promise<string> {
  const origin = nodeOrigin;
  if (origin === undefined) return '/__pyric/init.json';
  return `${(await origin.host()).replace(/\/$/, '')}/__pyric/init.json`;
}

/** The location a hosted socket url is resolved against. */
export function hostLocation(nodeHost: string | undefined): HostLocation {
  const isNode = nodeHost !== undefined;
  if (isNode) {
    const url = new URL(nodeHost);
    return { href: url.href, protocol: url.protocol, host: url.host };
  }
  return location;
}
