/**
 * Whether a request's client runs on this machine.
 *
 * The socket peer decides, because a client cannot choose it. A dev server or
 * proxy in front of the host connects from loopback whoever its client is, so a
 * Node server started under `pyric sandbox` carries the answer forward: it marks
 * a request from a non-loopback peer with `REMOTE_PEER_HEADER`
 * (`../register/remote-peer-mark.ts`).
 *
 * The header can only take access away. Its presence means remote whatever its
 * value, and there is no value that means local, so a client gains nothing by
 * sending it. A client of a marking server cannot remove it either: the server
 * sets it from the real socket before any handler reads the request.
 */

export const REMOTE_PEER_HEADER = 'x-pyric-remote-peer';

/** `::ffff:127.0.0.1`, an IPv4 loopback peer on a dual-stack socket. */
const MAPPED_IPV4_PREFIX = '::ffff:';

function isIpv4Loopback(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

function isIpv6Loopback(address: string): boolean {
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  if (!address.includes(':')) return false;
  try {
    return new URL(`http://[${address}]`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * True when a socket's peer address is loopback, so the client runs on this
 * machine. Unlike the Host header, the client cannot choose it. An unknown
 * address (a destroyed socket, a request with no socket) is not loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const lower = address.toLowerCase();
  if (lower.startsWith(MAPPED_IPV4_PREFIX)) {
    return isIpv4Loopback(lower.slice(MAPPED_IPV4_PREFIX.length));
  }
  return isIpv6Loopback(lower) || isIpv4Loopback(lower);
}

/** The parts of a request that say where it came from. */
export interface PeerRequest {
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
  headersDistinct?: Record<string, string[] | undefined>;
  /** Alternating names and values as the client sent them, in the client's casing. */
  rawHeaders?: string[];
}

/** True when the socket peer is on this machine and no server in front of it marked the client as remote. */
export function isLocalPeer(req: PeerRequest): boolean {
  const markedRemote = req.headers?.[REMOTE_PEER_HEADER] !== undefined;
  return !markedRemote && isLoopbackAddress(req.socket?.remoteAddress);
}
