/**
 * SharedWorker host — remote client virtual port adapter.
 *
 * Multiplexes isolated remote consumer sessions (Flutter, Swift, Kotlin, Node)
 * over a browser tab's physical MessagePort. Each remote client has a dedicated
 * `RemoteClientPort` keyed by `clientSessionId`.
 *
 * State isolation:
 *   - `portSessions`: remote auth sessions never touch the physical tab session.
 *   - `authSubs`: onAuthStateChanged / onIdTokenChanged fan-out is client-scoped.
 *   - `subs` / `sessionSubs`: Firestore listeners re-authorize only on that client's
 *     auth transitions.
 *   - Outbound messages (`res`, `snap`) are stamped with `clientSessionId`.
 */

import type { OutboundMessage } from './protocol.js';
import type { HostCtx, PortLike } from './host-context.js';
import { teardownPortSubscriptions } from './host/subscriptions.js';
import { authSubsFor } from './host-auth.js';

export class RemoteClientPort implements PortLike {
  constructor(
    public physicalPort: PortLike,
    public readonly clientSessionId: string,
  ) {}

  postMessage(msg: OutboundMessage): void {
    this.physicalPort.postMessage({
      ...msg,
      clientSessionId: this.clientSessionId,
    });
  }
}

/**
 * Retrieve or create a virtual `RemoteClientPort` for a remote client session.
 * If the physical browser tab changed (e.g. tab reload or bridge peer failover),
 * updates the virtual port's downstream physical port reference and tears down
 * stale subscriptions so re-issued subscriptions establish fresh listeners.
 */
export function getOrCreateRemoteClientPort(
  ctx: HostCtx,
  physicalPort: PortLike,
  clientSessionId: string,
): RemoteClientPort {
  const ports = (ctx.remoteClientPorts ??= new Map());
  let port = ports.get(clientSessionId) as RemoteClientPort | undefined;
  if (!port) {
    port = new RemoteClientPort(physicalPort, clientSessionId);
    ports.set(clientSessionId, port);
  } else if (port.physicalPort !== physicalPort) {
    teardownPortSubscriptions(ctx, port);
    authSubsFor(ctx).delete(port);
    port.physicalPort = physicalPort;
  }
  return port;
}
