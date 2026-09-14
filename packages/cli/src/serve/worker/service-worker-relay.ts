/** Session-aware Service Worker relay over the authoritative SharedWorker host. */
import {
  cleanupPortWithDisconnect,
  handleMessage,
  type HostCtx,
  type PortLike,
} from './host.js';
import type { ServiceWorkerChannelMessage } from './service-worker-channel.js';
import { MAX_PENDING_OPERATIONS } from '../../bridge/protocol.js';

type HostEnvelope = Extract<ServiceWorkerChannelMessage, { direction: 'host' }>;

interface RelayState {
  readonly sessionId: string;
  readonly port: PortLike;
  queue: Promise<void>;
  readonly admission: { pendingOperations: number };
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
      const isAttach = envelope.phase === 'attach';
      if (isAttach) {
        const previous = ports.get(envelope.clientId);
        const isCurrentSession = previous?.sessionId === envelope.sessionId;
        if (isCurrentSession) {
          await previous.queue;
          return;
        }
        const state: RelayState = {
          sessionId: envelope.sessionId,
          // A replacement realm still shares the client's previously accepted work.
          admission: previous?.admission ?? { pendingOperations: 0 },
          port: makePort(envelope.clientId, envelope.sessionId),
          queue: (previous?.queue ?? Promise.resolve()).then(async () => {
            const hasNoPrevious = previous === undefined;
            if (hasNoPrevious) return;
            try {
              const ctx = await options.getCtx();
              await cleanupPortWithDisconnect(ctx, previous.port);
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
      const isStaleSession = state === undefined || state.sessionId !== envelope.sessionId;
      if (isStaleSession) return;
      const message = envelope.message;
      const isOperation = message.t === 'op' || message.t === 'tool';
      if (isOperation) {
        const hasReachedCapacity = state.admission.pendingOperations >= MAX_PENDING_OPERATIONS;
        if (hasReachedCapacity) {
          state.port.postMessage({
            t: 'res', id: message.id, clientSessionId: message.clientSessionId, ok: false,
            error: { code: 'resource-exhausted', message: 'This client already has 256 pending operations.' },
          });
          return;
        }
        state.admission.pendingOperations += 1;
      }
      state.queue = state.queue.then(async () => {
        try {
          const ctx = await options.getCtx();
          await handleMessage(ctx, state.port, message);
          const disconnectsCurrentSession = message.t === 'disconnect'
            && ports.get(envelope.clientId) === state;
          if (disconnectsCurrentSession) {
            ports.delete(envelope.clientId);
          }
        } catch (error) {
          options.onError?.(error, envelope);
        } finally {
          if (isOperation) state.admission.pendingOperations -= 1;
        }
      });
      await state.queue;
    },
  };
}
