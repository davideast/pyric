/**
 * Auth user lifecycle delivery seam for Gen 1 Firebase Auth triggers:
 * deterministic in-memory adapter for unit tests and remote worker-subscription
 * adapter (`{ target: { service: 'auth.lifecycle' } }`) for isolated child
 * processes.
 */
import type { WorkerSubPayload } from '../../bridge/protocol.js';
import type { RemoteSandboxChannel } from '../../remote/index.js';
import type { AuthLifecycleSnapWire } from '../../serve/worker/host/auth-lifecycle-subscriptions.js';
import type { AuthLifecycleUserSnapshot } from './event.js';

export interface AuthLifecycleNotification {
  op: 'user_create' | 'user_delete';
  uid: string;
  at: number;
  user: AuthLifecycleUserSnapshot;
}

export interface AuthLifecycleTriggerDelivery {
  subscribe(
    listener: (notification: AuthLifecycleNotification) => void,
    onReady?: () => void,
    onError?: (error: unknown) => void,
  ): () => void;
}

/** Deterministic in-memory Auth lifecycle delivery adapter for unit tests. */
export class InMemoryAuthLifecycleTriggerDelivery implements AuthLifecycleTriggerDelivery {
  readonly #listeners = new Set<(notification: AuthLifecycleNotification) => void>();

  emit(notification: AuthLifecycleNotification): void {
    const cloned = structuredClone(notification);
    for (const listener of this.#listeners) {
      listener(structuredClone(cloned));
    }
  }

  subscribe(
    listener: (notification: AuthLifecycleNotification) => void,
    onReady?: () => void,
  ): () => void {
    this.#listeners.add(listener);
    onReady?.();
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function isAuthLifecycleSnap(value: unknown): value is AuthLifecycleSnapWire {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'ready' || kind === 'mutation';
}

/** Remote sandbox channel adapter backed by `{ target: { service: 'auth.lifecycle' } }`. */
export class RemoteAuthLifecycleTriggerDelivery implements AuthLifecycleTriggerDelivery {
  readonly #channel: Pick<RemoteSandboxChannel, 'subscribe'>;

  constructor(channel: Pick<RemoteSandboxChannel, 'subscribe'>) {
    this.#channel = channel;
  }

  subscribe(
    listener: (notification: AuthLifecycleNotification) => void,
    onReady?: () => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const subPayload: WorkerSubPayload = {
      target: { service: 'auth.lifecycle' },
      actAs: { mode: 'admin' },
    };
    let readyReported = false;
    let closed = false;

    const unsubscribe = this.#channel.subscribe(
      subPayload,
      (rawSnap) => {
        if (closed || !isAuthLifecycleSnap(rawSnap)) return;
        if (rawSnap.kind === 'ready') {
          if (!readyReported) {
            readyReported = true;
            onReady?.();
          }
          return;
        }
        listener({
          op: rawSnap.op,
          uid: rawSnap.uid,
          at: rawSnap.at,
          user: rawSnap.user,
        });
      },
      (err) => {
        if (!closed) {
          onError?.(err);
        }
      },
    );

    return () => {
      closed = true;
      unsubscribe();
    };
  }
}
