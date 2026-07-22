import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type { Target } from './state.js';

interface PendingWrite<T = unknown> {
  readonly path?: string;
  readonly promise: Promise<T>;
  localDone: boolean;
  value?: T;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Per-Firestore-service client lifecycle layered over the shared sandbox store. */
export class FirestoreClientState {
  private started = false;
  private networkEnabled = true;
  private persistenceMode: 'single' | 'multiple' | undefined;
  private readonly pending = new Set<PendingWrite>();
  private readonly cachedPaths = new Set<string>();
  private readonly cachedQueries = new WeakSet<object>();
  private readonly syncObservers = new Set<() => void>();
  private syncScheduled = false;

  markStarted(): void {
    this.started = true;
  }

  enablePersistence(mode: 'single' | 'multiple'): void {
    if (this.started || this.persistenceMode !== undefined) {
      throw new FirebaseError(
        'failed-precondition',
        'Firestore has already been started and persistence can no longer be enabled.',
      );
    }
    this.persistenceMode = mode;
    this.started = true;
  }

  disableNetwork(): void {
    this.started = true;
    this.networkEnabled = false;
  }

  async enableNetwork(): Promise<void> {
    this.started = true;
    this.networkEnabled = true;
    for (const write of this.pending) {
      if (write.localDone) write.resolve(write.value);
    }
    await Promise.all([...this.pending].map((write) => write.promise));
  }

  runWrite<T>(operation: () => Promise<T>, path?: string): Promise<T> {
    this.started = true;
    if (path) this.cachedPaths.add(path);
    if (this.networkEnabled) return operation();

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: PendingWrite<T> = {
      path,
      promise,
      localDone: false,
      resolve,
      reject,
    };
    this.pending.add(pending as PendingWrite);
    void operation().then(
      (value) => {
        pending.localDone = true;
        pending.value = value;
        if (this.networkEnabled) pending.resolve(value);
      },
      (error) => pending.reject(error),
    );
    void promise.then(
      () => this.pending.delete(pending as PendingWrite),
      () => this.pending.delete(pending as PendingWrite),
    );
    return promise;
  }

  waitForPendingWrites(): Promise<void> {
    this.started = true;
    const snapshot = [...this.pending].map((write) => write.promise);
    return Promise.all(snapshot).then(() => undefined);
  }

  cachePath(path: string): void {
    this.started = true;
    this.cachedPaths.add(path);
  }

  assertPathCached(path: string): void {
    this.started = true;
    if (!this.cachedPaths.has(path)) {
      throw new FirebaseError(
        'unavailable',
        'Failed to get document from cache. (However, this document may exist on the server.)',
      );
    }
  }

  cacheQuery(query: object): void {
    this.started = true;
    this.cachedQueries.add(query);
  }

  hasCachedQuery(query: object): boolean {
    this.started = true;
    return this.cachedQueries.has(query) || this.cachedPaths.size > 0;
  }

  snapshotMetadata(path: string): {
    readonly fromCache: boolean;
    readonly hasPendingWrites: boolean;
  } {
    return Object.freeze({
      fromCache: !this.networkEnabled,
      hasPendingWrites: [...this.pending].some((write) => write.path === path),
    });
  }

  querySnapshotMetadata(): {
    readonly fromCache: boolean;
    readonly hasPendingWrites: boolean;
  } {
    return Object.freeze({
      fromCache: !this.networkEnabled,
      hasPendingWrites: this.pending.size > 0,
    });
  }

  addSnapshotsInSyncObserver(observer: () => void): () => void {
    this.syncObservers.add(observer);
    observer();
    return () => this.syncObservers.delete(observer);
  }

  notifySnapshotDelivered(): void {
    if (this.syncScheduled || this.syncObservers.size === 0) return;
    this.syncScheduled = true;
    queueMicrotask(() => {
      this.syncScheduled = false;
      for (const observer of [...this.syncObservers]) observer();
    });
  }
}

const clientStates = new WeakMap<object, FirestoreClientState>();

export function clientStateFor(target: Target): FirestoreClientState {
  let state = clientStates.get(target as object);
  if (!state) {
    state = new FirestoreClientState();
    clientStates.set(target as object, state);
  }
  return state;
}
