/**
 * The hosted connection's realm in a Node process (#1082).
 *
 * The production SDKs in Node keep a process alive the way their own
 * connections do. `@firebase/database` (1.1.x, `index.node.esm.js`) holds a
 * referenced `faye-websocket` and a 45 s keepalive `setInterval` from the
 * first use until `goOffline()` or `deleteApp()`, so a script that wrote with
 * it does not exit on its own. `@firebase/firestore` (4.x, Node build) runs
 * over gRPC, whose HTTP/2 session is referenced only while a call is open;
 * a listener keeps the process up, a finished write's stream closes after 60 s
 * idle and the process then exits. Auth and Storage hold nothing between
 * calls.
 *
 * Here one socket carries every service, so the socket and the connection's
 * timers never hold the process themselves (`ws`, whose socket can be
 * unreferenced; the global `WebSocket` cannot). This realm holds it instead:
 *
 * - while a request waits for its reply, or a Firestore, RTDB or AI
 *   subscription is open;
 * - for RTDB, from its first call on an instance until `goOffline()` on that
 *   instance or the app's deletion, as production does.
 *
 * A finished Firestore write releases at once, where production lingers for
 * its 60 s idle timeout.
 */
import { Socket } from 'node:net';
import { WebSocket as NodeWebSocket } from 'ws';
import { MAX_BRIDGE_FRAME_BYTES } from '../../bridge/protocol.js';
import { outstandingWorkOn } from '../../serve/worker/client/core.js';
import type { ClientPort } from '../../serve/worker/client/handles.js';
import type { HostedSocketRealm } from '../../serve/worker/client/websocket-connection.js';
import type { InboundMessage } from '../../serve/worker/protocol.js';

const KEEP_ALIVE_INTERVAL_MS = 2 ** 30;

interface PortState {
  /** RTDB instances in use since their first call, until goOffline. */
  readonly rtdbInstances: Set<string>;
  closed: boolean;
}

function rtdbInstanceOf(message: InboundMessage): string | null {
  const isOperation = message.t === 'op';
  if (!isOperation) return null;
  const method = (message as { method?: unknown }).method;
  const isRtdb = typeof method === 'string' && method.startsWith('rtdb.');
  if (!isRtdb) return null;
  const instance = (message as { instance?: unknown }).instance;
  return typeof instance === 'string' ? instance : '(default)';
}

function isGoOffline(message: InboundMessage): boolean {
  return message.t === 'op' && (message as { method?: unknown }).method === 'rtdb.goOffline';
}

/** Whether this port keeps the process alive right now. */
function holdsProcess(port: ClientPort, state: PortState): boolean {
  if (state.closed) return false;
  const usesRtdb = state.rtdbInstances.size > 0;
  return usesRtdb || outstandingWorkOn(port) > 0;
}

let warnedUnreleasable = false;

/**
 * Keeps an open `ws` socket from holding the process by itself. The public
 * seam is `ws`'s `'upgrade'` event, whose HTTP response carries the upgraded
 * `net.Socket`; the private `_socket` field is the fallback at `'open'`. If a
 * `ws` release exposes neither, the process warns once and keeps working: it
 * then stays up while the connection is open, rather than exiting early.
 */
export function releaseUpgradedSocket(
  socket: NodeWebSocket,
  warn: (message: string) => void = (message) => process.stderr.write(message),
): void {
  let released = false;
  const release = (candidate: unknown): void => {
    const isNetworkSocket = candidate instanceof Socket;
    if (released || !isNetworkSocket) return;
    candidate.unref();
    released = true;
  };
  socket.on('upgrade', (response: { socket?: unknown }) => release(response.socket));
  socket.on('open', () => {
    release((socket as unknown as { _socket?: unknown })._socket);
    if (released || warnedUnreleasable) return;
    warnedUnreleasable = true;
    warn('pyric: this version of `ws` exposes no socket to unreference, so a Node process using the client Firebase SDKs stays up while its connection to the Node host is open.\n');
  });
}

export interface NodeSocketRealm extends HostedSocketRealm {
  /** Whether the realm is holding the process (for tests). */
  holdsProcess(): boolean;
}

export function createNodeSocketRealm(options: { onAttached?: (ack: { serveVersion?: unknown }) => void } = {}): NodeSocketRealm {
  const ports = new Map<ClientPort, PortState>();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let recomputeQueued = false;

  const anyPortHolds = (): boolean => {
    for (const [port, state] of ports) {
      if (holdsProcess(port, state)) return true;
    }
    return false;
  };

  const recompute = (): void => {
    recomputeQueued = false;
    const shouldHold = anyPortHolds();
    const isHolding = keepAlive !== undefined;
    if (shouldHold && !isHolding) keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);
    if (!shouldHold && isHolding) {
      clearInterval(keepAlive);
      keepAlive = undefined;
    }
  };

  // A reply settles its request in the same task; read the maps after it has.
  const scheduleRecompute = (): void => {
    if (recomputeQueued) return;
    recomputeQueued = true;
    queueMicrotask(recompute);
  };

  const stateOf = (port: ClientPort): PortState => {
    let state = ports.get(port);
    if (state === undefined) {
      state = { rtdbInstances: new Set(), closed: false };
      ports.set(port, state);
    }
    return state;
  };

  return {
    platform: 'node',
    createSocket(url) {
      const socket = new NodeWebSocket(url, { maxPayload: MAX_BRIDGE_FRAME_BYTES });
      releaseUpgradedSocket(socket);
      return socket as unknown as WebSocket;
    },
    releaseTimer(timer) {
      const canRelease = typeof timer === 'object' && timer !== null && 'unref' in timer;
      if (canRelease) timer.unref();
    },
    traffic(port, event) {
      const state = stateOf(port);
      if (event.closed === true) {
        state.closed = true;
        ports.delete(port);
      }
      const sent = event.sent;
      if (sent !== undefined) {
        const instance = rtdbInstanceOf(sent);
        const releasesInstance = instance !== null && isGoOffline(sent);
        if (releasesInstance) state.rtdbInstances.delete(instance);
        else if (instance !== null) state.rtdbInstances.add(instance);
      }
      scheduleRecompute();
    },
    attached(ack) {
      options.onAttached?.(ack);
    },
    holdsProcess() {
      return keepAlive !== undefined;
    },
  };
}
