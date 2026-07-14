/** Session-aware Service Worker relay over the authoritative SharedWorker host. */
import {
  cleanupPort,
  handleMessage,
  type HostCtx,
  type PortLike,
} from './host.js';
import type { ServiceWorkerChannelMessage } from './service-worker-channel.js';

type HostEnvelope = Extract<ServiceWorkerChannelMessage, { direction: 'host' }>;

interface RelayState {
  readonly sessionId: string;
  readonly port: PortLike;
  queue: Promise<void>;
}

export interface ServiceWorkerRelay {
  handle(envelope: HostEnvelope): Promise<void>;
}

/**
 * Keep one virtual host port per logical app while treating each Service Worker
 * realm as a new session. An attach from a replacement realm first tears down
 * the previous port's subscriptions; frames from the superseded realm are then
 * ignored instead of being attributed to the replacement.
 */
export function createServiceWorkerRelay(options: {
  getCtx(): Promise<HostCtx>;
  send(message: ServiceWorkerChannelMessage): void;
  onError?(error: unknown, envelope: HostEnvelope): void;
}): ServiceWorkerRelay {
  const ports = new Map<string, RelayState>();

  const makePort = (clientId: string, sessionId: string): PortLike => ({
    postMessage(message) {
      options.send({ direction: 'client', clientId, sessionId, message });
    },
  });

  return {
    async handle(envelope) {
      if (envelope.phase === 'attach') {
        const previous = ports.get(envelope.clientId);
        if (previous?.sessionId === envelope.sessionId) {
          await previous.queue;
          return;
        }
        const state: RelayState = {
          sessionId: envelope.sessionId,
          port: makePort(envelope.clientId, envelope.sessionId),
          queue: (previous?.queue ?? Promise.resolve()).then(async () => {
            if (!previous) return;
            try {
              const ctx = await options.getCtx();
              cleanupPort(ctx, previous.port);
            } catch (error) {
              options.onError?.(error, envelope);
            }
          }),
        };
        ports.set(envelope.clientId, state);
        await state.queue;
        return;
      }

      const state = ports.get(envelope.clientId);
      if (!state || state.sessionId !== envelope.sessionId) return;
      state.queue = state.queue.then(async () => {
        try {
          const ctx = await options.getCtx();
          await handleMessage(ctx, state.port, envelope.message);
          if (
            envelope.message.t === 'disconnect'
            && ports.get(envelope.clientId) === state
          ) {
            ports.delete(envelope.clientId);
          }
        } catch (error) {
          options.onError?.(error, envelope);
        }
      });
      await state.queue;
    },
  };
}
