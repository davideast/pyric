import { getAuthLens } from '../sandbox/internal/auth-lens.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import type { Target } from './state.js';
import { ClientOfflineOverlay, type OfflineMutation } from './sandbox/client-offline-overlay.js';

interface PendingWrite<T = unknown> {
  readonly paths: ReadonlySet<string>;
  readonly promise: Promise<T>;
  flush(): Promise<void>;
}

export interface ClientManagedListener {
  hasDelivered(): boolean;
  suspendBackend(): void;
  resumeBackend(): void;
  deliverOffline(changedPaths?: ReadonlySet<string>): void;
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
  private readonly managedListeners = new Set<ClientManagedListener>();
  private syncScheduled = false;
  private readonly overlaysByLens = new Map<string, ClientOfflineOverlay>();

  get overlay(): ClientOfflineOverlay {
    const lens = getAuthLens();
    let key = 'app-session';
    if (lens !== undefined) {
      key = JSON.stringify(lens);
    }
    let entry = this.overlaysByLens.get(key);
    if (entry === undefined) {
      entry = new ClientOfflineOverlay();
      this.overlaysByLens.set(key, entry);
    }
    return entry;
  }

  constructor(private readonly readAdminDoc?: (path: string) => Record<string, unknown> | null) {}

  markStarted(): void {
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  isNetworkEnabled(): boolean {
    return this.networkEnabled;
  }

  registerListener(listener: ClientManagedListener): () => void {
    this.managedListeners.add(listener);
    return () => {
      this.managedListeners.delete(listener);
    };
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
    if (!this.networkEnabled) return;
    this.networkEnabled = false;
    for (const listener of [...this.managedListeners]) {
      listener.suspendBackend();
      if (!listener.hasDelivered()) {
        queueMicrotask(() => {
          if (!this.networkEnabled && this.managedListeners.has(listener) && !listener.hasDelivered()) {
            listener.deliverOffline();
          }
        });
      }
    }
  }

  async enableNetwork(): Promise<void> {
    this.started = true;
    const wasOffline = !this.networkEnabled;
    this.networkEnabled = true;
    const queued = [...this.pending];
    for (const write of queued) {
      await write.flush();
    }
    if (wasOffline) {
      for (const listener of [...this.managedListeners]) {
        listener.resumeBackend();
      }
    }
  }

  runWrite<T>(
    operation: () => Promise<T>,
    pathOrPaths?: string | Iterable<string>,
    offlineMutations?: readonly OfflineMutation[],
  ): Promise<T> {
    this.started = true;
    const paths = new Set<string>();
    if (typeof pathOrPaths === 'string') {
      if (pathOrPaths.length > 0) paths.add(pathOrPaths);
    } else if (pathOrPaths !== undefined) {
      for (const entry of pathOrPaths) paths.add(entry);
    }

    const isLastMutationDelete = (targetPath: string): boolean => {
      if (offlineMutations === undefined) return false;
      let lastKind: OfflineMutation['kind'] | undefined;
      for (const m of offlineMutations) {
        if (m.path === targetPath) lastKind = m.kind;
      }
      return lastKind === 'delete';
    };

    const recordCommittedCache = (): void => {
      for (const p of paths) {
        if (isLastMutationDelete(p)) {
          this.cachedPaths.delete(p);
          this.overlay.markDeletedPath(p);
        } else {
          this.cachedPaths.add(p);
          this.overlay.markWarmPath(p, this.readAdminDoc);
        }
      }
    };

    if (this.networkEnabled) {
      return operation().then((value) => {
        recordCommittedCache();
        return value;
      });
    }

    for (const p of paths) {
      if (!isLastMutationDelete(p)) this.cachedPaths.add(p);
    }
    const overlayId = this.overlay.stageMutations(offlineMutations ?? []);
    if (paths.size > 0) {
      queueMicrotask(() => {
        if (this.networkEnabled) return;
        for (const listener of [...this.managedListeners]) {
          listener.deliverOffline(paths);
        }
      });
    }

    let resolvePromise: ((value: T) => void) | undefined;
    let rejectPromise: ((error: unknown) => void) | undefined;
    const promise = new Promise<T>((res, rej) => {
      resolvePromise = res;
      rejectPromise = rej;
    });
    let flushed = false;
    const pending: PendingWrite<T> = {
      paths,
      promise,
      flush: async () => {
        if (flushed) return;
        flushed = true;
        try {
          const value = await operation();
          this.overlay.clearMutations(overlayId);
          recordCommittedCache();
          this.pending.delete(pending as PendingWrite);
          resolvePromise?.(value);
        } catch (error) {
          this.overlay.clearMutations(overlayId);
          this.pending.delete(pending as PendingWrite);
          rejectPromise?.(error);
        }
      },
    };
    this.pending.add(pending as PendingWrite);
    return promise;
  }

  waitForPendingWrites(): Promise<void> {
    this.started = true;
    const snapshot = [...this.pending].map((write) => write.promise);
    return Promise.allSettled(snapshot).then(() => undefined);
  }

  cachePath(path: string): void {
    this.started = true;
    this.cachedPaths.add(path);
    if (this.networkEnabled) {
      this.overlay.markWarmPath(path, this.readAdminDoc);
    }
  }

  cacheBundledPath(path: string, exists: boolean): void {
    this.started = true;
    this.cachedPaths.add(path);
    if (exists) {
      this.overlay.markWarmPath(path, this.readAdminDoc);
    } else {
      this.overlay.markDeletedPath(path);
    }
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
      hasPendingWrites: [...this.pending].some((write) => write.paths.has(path)),
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
    try {
      observer();
    } catch (error) {
      this.syncObservers.delete(observer);
      throw error;
    }
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
    const readAdminDoc = (path: string): Record<string, unknown> | null => {
      const admin = (
        target.sandbox as { admin?: { getDocument?: (docPath: string) => Record<string, unknown> | null | undefined } }
      ).admin;
      if (admin && typeof admin.getDocument === 'function') {
        const doc = admin.getDocument(path);
        if (doc !== undefined && doc !== null) return doc;
      }
      return null;
    };
    state = new FirestoreClientState(readAdminDoc);
    clientStates.set(target as object, state);
  }
  return state;
}
