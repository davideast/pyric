/** Same-origin relay between a real Service Worker and the SharedWorker host. */
import type { InboundMessage, OutboundMessage } from './protocol.js';

export const SERVICE_WORKER_CHANNEL = 'pyric-shared-worker:service-worker';

export type ServiceWorkerChannelMessage =
  | {
    readonly direction: 'host';
    readonly phase: 'attach';
    readonly clientId: string;
    readonly sessionId: string;
  }
  | {
    readonly direction: 'host';
    readonly phase: 'message';
    readonly clientId: string;
    readonly sessionId: string;
    readonly message: InboundMessage;
  }
  | {
    readonly direction: 'client';
    readonly clientId: string;
    readonly sessionId: string;
    readonly message: OutboundMessage;
  };

/** `SharedWorker` is deliberately absent in ServiceWorkerGlobalScope. */
export function isServiceWorkerRealm(): boolean {
  const scope = globalThis as { registration?: unknown; clients?: unknown };
  return typeof window === 'undefined'
    && scope.registration !== undefined
    && scope.clients !== undefined;
}
