/**
 * Marks requests from other machines on every HTTP server in this process.
 *
 * A server started under `pyric sandbox` may forward requests to the sandbox
 * host: `withPyric`'s rewrite, a Vite `server.proxy`, a proxy the app wrote. The
 * host then sees that server's loopback connection for each of them. Wrapping
 * `emit` sets the mark before any listener runs, whichever server it is, on every
 * path, so no route or rewrite rule can skip it, and it replaces whatever value
 * the client sent. See `../serve/peer.ts` for why the host can trust the mark.
 */
import http from 'node:http';
import https from 'node:https';
import { REMOTE_PEER_HEADER, isLoopbackAddress, type PeerRequest } from '../serve/peer.js';

const INSTALLED = Symbol.for('pyric.register.remotePeerMark');
/** Each of these events hands a listener an incoming request as its first argument. */
const REQUEST_EVENTS = new Set<string | symbol>(['request', 'upgrade', 'connect', 'checkContinue', 'checkExpectation']);

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

function markIfRemote(req: PeerRequest): void {
  const isRemote = !isLoopbackAddress(req.socket?.remoteAddress);
  if (isRemote && req.headers !== undefined) req.headers[REMOTE_PEER_HEADER] = '1';
}

function wrapEmit(prototype: { emit: Emit }): void {
  const original = prototype.emit;
  prototype.emit = function emit(this: unknown, event, ...args) {
    if (REQUEST_EVENTS.has(event)) markIfRemote(args[0] as PeerRequest);
    return original.call(this, event, ...args);
  };
}

/** Safe to call more than once: the preload and `withPyric` both call it. */
export function installRemotePeerMark(): void {
  const state = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (state[INSTALLED] === true) return;
  state[INSTALLED] = true;
  wrapEmit(http.Server.prototype as unknown as { emit: Emit });
  wrapEmit(https.Server.prototype as unknown as { emit: Emit });
}
