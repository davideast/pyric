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
const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;
const IPV6_LOOPBACK = new Set(['::1', '0:0:0:0:0:0:0:1']);

/**
 * True when a socket's peer address is loopback, so the client runs on this
 * machine. Unlike the Host header, the client cannot choose it. An unknown
 * address (a destroyed socket, a request with no socket) is not loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const lower = address.toLowerCase();
  const isMapped = lower.startsWith(MAPPED_IPV4_PREFIX);
  const ipv4 = isMapped ? lower.slice(MAPPED_IPV4_PREFIX.length) : lower;
  return IPV6_LOOPBACK.has(lower) || IPV4_LOOPBACK.test(ipv4);
}

/** The parts of a request that say where it came from. */
export interface PeerRequest {
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}

/** True when the socket peer is on this machine and no server in front of it marked the client as remote. */
export function isLocalPeer(req: PeerRequest): boolean {
  const markedRemote = req.headers?.[REMOTE_PEER_HEADER] !== undefined;
  return !markedRemote && isLoopbackAddress(req.socket?.remoteAddress);
}
