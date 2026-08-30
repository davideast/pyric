import { cleanupPortWithDisconnect, type HostCtx, type PortLike } from './host.js';

/**
 * SharedWorker port lifecycle manager.
 *
 * Tracks ports that close before asynchronous worker context initialization
 * finishes, preventing dead-port leaks and ensuring that port cleanup / disconnect
 * operations are drained as soon as the context becomes available.
 */
export interface PortLifecycleManager {
  /** Record port closure. Cleans up immediately if context is ready, or defers until resolution. */
  onPortClosed(port: PortLike, currentCtx: HostCtx | null): void;
  /** Drain all deferred closed ports against the newly resolved context. */
  drainClosedPorts(ctx: HostCtx): void;
  /** Check whether a port has already closed before processing queued messages. */
  isPortClosed(port: PortLike): boolean;
}

export function createPortLifecycleManager(): PortLifecycleManager {
  const closedPorts = new WeakSet<PortLike>();
  const pendingClosedPorts = new Set<PortLike>();

  return {
    onPortClosed(port: PortLike, currentCtx: HostCtx | null): void {
      closedPorts.add(port);
      if (currentCtx !== null) {
        void cleanupPortWithDisconnect(currentCtx, port).catch(() => undefined);
      } else {
        pendingClosedPorts.add(port);
      }
    },

    drainClosedPorts(ctx: HostCtx): void {
      if (pendingClosedPorts.size === 0) return;
      for (const port of pendingClosedPorts) {
        void cleanupPortWithDisconnect(ctx, port).catch(() => undefined);
      }
      pendingClosedPorts.clear();
    },

    isPortClosed(port: PortLike): boolean {
      return closedPorts.has(port);
    },
  };
}
