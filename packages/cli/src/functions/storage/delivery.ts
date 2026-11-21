/**
 * Storage mutation delivery seam for Cloud Functions v2 Storage triggers:
 * deterministic in-memory adapter for unit tests and remote worker-subscription
 * adapter for isolated child processes.
 */
import type { WorkerSubPayload } from '../../bridge/protocol.js';
import type { RemoteSandboxChannel } from '../../remote/index.js';
import type { StorageSubscriptionSnapWire } from '../../serve/worker/host/storage-subscriptions.js';
import type { StorageObjectSnapshot } from './event.js';

export interface StorageMutationNotification {
  op: 'object_put' | 'metadata_update' | 'object_delete';
  storeBucket: string;
  bucketName: string;
  path: string;
  at: number;
  rollback?: boolean;
  before?: StorageObjectSnapshot;
  after?: StorageObjectSnapshot;
}

export interface StorageDeliveryReadyInfo {
  defaultBucket?: string;
}

export interface StorageTriggerDelivery {
  subscribe(
    listener: (notification: StorageMutationNotification) => void,
    onReady?: (info: StorageDeliveryReadyInfo) => void,
    onError?: (error: unknown) => void,
  ): () => void;
}

/** Deterministic in-memory Storage trigger delivery adapter for unit tests. */
export class InMemoryStorageTriggerDelivery implements StorageTriggerDelivery {
  readonly #listeners = new Set<(notification: StorageMutationNotification) => void>();
  readonly #defaultBucket: string | undefined;

  constructor(options: { defaultBucket?: string } = {}) {
    this.#defaultBucket = options.defaultBucket;
  }

  emit(notification: StorageMutationNotification): void {
    const cloned = structuredClone(notification);
    for (const listener of this.#listeners) {
      listener(structuredClone(cloned));
    }
  }

  subscribe(
    listener: (notification: StorageMutationNotification) => void,
    onReady?: (info: StorageDeliveryReadyInfo) => void,
  ): () => void {
    this.#listeners.add(listener);
    const readyInfo: StorageDeliveryReadyInfo = {};
    if (this.#defaultBucket !== undefined) {
      readyInfo.defaultBucket = this.#defaultBucket;
    }
    onReady?.(readyInfo);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function isStorageSubscriptionSnap(value: unknown): value is StorageSubscriptionSnapWire {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'ready' || kind === 'mutation';
}

/** Remote sandbox channel adapter backed by `{ target: { service: 'storage' } }`. */
export class RemoteStorageTriggerDelivery implements StorageTriggerDelivery {
  readonly #channel: Pick<RemoteSandboxChannel, 'subscribe'>;
  readonly #defaultBucket: string | undefined;

  constructor(
    channel: Pick<RemoteSandboxChannel, 'subscribe'>,
    options: { defaultBucket?: string } = {},
  ) {
    this.#channel = channel;
    this.#defaultBucket = options.defaultBucket;
  }

  subscribe(
    listener: (notification: StorageMutationNotification) => void,
    onReady?: (info: StorageDeliveryReadyInfo) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    const target: { service: 'storage'; defaultBucket?: string } = { service: 'storage' };
    if (this.#defaultBucket !== undefined) {
      target.defaultBucket = this.#defaultBucket;
    }
    const subPayload: WorkerSubPayload = {
      target,
      actAs: { mode: 'admin' },
    };
    let readyReported = false;

    return this.#channel.subscribe(
      subPayload,
      (rawSnap) => {
        if (!isStorageSubscriptionSnap(rawSnap)) return;
        if (rawSnap.kind === 'ready') {
          if (!readyReported) {
            readyReported = true;
            onReady?.({ defaultBucket: rawSnap.defaultBucket });
          }
          return;
        }
        const notification: StorageMutationNotification = {
          op: rawSnap.op,
          storeBucket: rawSnap.storeBucket,
          bucketName: rawSnap.bucketName,
          path: rawSnap.path,
          at: rawSnap.at,
          rollback: rawSnap.rollback,
        };
        if (rawSnap.before !== undefined) {
          notification.before = rawSnap.before;
        }
        if (rawSnap.after !== undefined) {
          notification.after = rawSnap.after;
        }
        listener(notification);
      },
      (err) => {
        onError?.(err);
      },
    );
  }
}
