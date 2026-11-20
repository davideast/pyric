/**
 * Per-Firestore-handle lifecycle state for the SharedWorker and Node-hosted
 * WebSocket client planes: persistence preconditions (`FS-140`, `FS-141`),
 * per-client warmed cache path tracking (`FS-148`), and handle-scoped
 * `terminate(db)` isolation (`FS-152`) without closing shared ports.
 */
import { FirebaseError } from 'pyric/app';
import { markHandlePersistentCache } from 'pyric/firestore/internal';
import type { ClientDb, ClientPort, CollRefHandle, DocRefHandle, QueryHandle } from './handles.js';

type WorkerTarget = ClientDb | DocRefHandle<unknown> | CollRefHandle<unknown> | QueryHandle<unknown>;

interface HandleLifecycleState {
  started: boolean;
  persistenceEnabled: boolean;
  terminated: boolean;
  readonly cachedPaths: Set<string>;
  readonly stopCallbacks: Set<() => void>;
}

const lifecycleByOwner = new WeakMap<object, HandleLifecycleState>();
const handleOwnerDb = new WeakMap<object, object>();
const activeDbByPort = new WeakMap<ClientPort, ClientDb>();
const dbTeardownCallbacks = new WeakMap<object, () => void>();
const portTerminationResets = new Set<(port: ClientPort) => void>();

function getOrCreateLifecycle(owner: object): HandleLifecycleState {
  let state = lifecycleByOwner.get(owner);
  if (state === undefined) {
    state = {
      started: false,
      persistenceEnabled: false,
      terminated: false,
      cachedPaths: new Set(),
      stopCallbacks: new Set(),
    };
    lifecycleByOwner.set(owner, state);
  }
  return state;
}

export function registerPortTerminationReset(fn: (port: ClientPort) => void): void {
  portTerminationResets.add(fn);
}

export function registerWorkerDbTeardown(db: object, onTerminate: () => void): void {
  dbTeardownCallbacks.set(db, onTerminate);
}

export function getActiveWorkerDbForPort(port: ClientPort): ClientDb | undefined {
  return activeDbByPort.get(port);
}

export function bindWorkerHandleOwner<T extends object>(handle: T, owner: object | undefined): T {
  if (owner !== undefined) handleOwnerDb.set(handle, owner);
  return handle;
}

function ownerForTarget(target: WorkerTarget): object {
  if (target.__kind === 'client-db') {
    if (!getOrCreateLifecycle(target).terminated) activeDbByPort.set(target.port, target);
    return target;
  }
  const explicitOwner = handleOwnerDb.get(target);
  if (explicitOwner !== undefined) return explicitOwner;
  const portDb = activeDbByPort.get(target.port);
  if (portDb !== undefined) return portDb;
  return target.port;
}

function ownerForPort(port: object): object {
  const portDb = activeDbByPort.get(port as ClientPort);
  if (portDb !== undefined) return portDb;
  return port;
}

export function assertWorkerClientDb(candidate: unknown, fnName: string): asserts candidate is ClientDb {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    (candidate as { __kind?: unknown }).__kind !== 'client-db' ||
    !('port' in candidate)
  ) {
    throw new FirebaseError('invalid-argument', `Expected first argument to ${fnName}() to be a Firestore instance.`);
  }
}

export function assertWorkerFirestoreActive(target: WorkerTarget): void {
  if (getOrCreateLifecycle(ownerForTarget(target)).terminated) {
    throw new FirebaseError('failed-precondition', 'The client has already been terminated.');
  }
}

export function resolveWorkerParentOwner(parent: WorkerTarget): object {
  assertWorkerFirestoreActive(parent);
  return ownerForTarget(parent);
}

export function markWorkerHandleStarted(target: WorkerTarget): void {
  getOrCreateLifecycle(ownerForTarget(target)).started = true;
}

export function markWorkerPortStarted(port: object): void {
  getOrCreateLifecycle(ownerForPort(port)).started = true;
}

export function isWorkerDbStartedAndRunning(db: ClientDb): boolean {
  const state = getOrCreateLifecycle(db);
  if (state.terminated) return false;
  return state.started || getOrCreateLifecycle(db.port).started;
}

export function registerWorkerOwnedListener(target: WorkerTarget, stop: () => void): () => void {
  const state = getOrCreateLifecycle(ownerForTarget(target));
  state.stopCallbacks.add(stop);
  return () => { state.stopCallbacks.delete(stop); };
}

export function markWorkerPathCached(port: ClientPort, path: string): void {
  getOrCreateLifecycle(ownerForPort(port)).cachedPaths.add(path);
}

export function unmarkWorkerPathCached(port: ClientPort, path: string): void {
  getOrCreateLifecycle(ownerForPort(port)).cachedPaths.delete(path);
}

export function isWorkerTargetPathCached(target: WorkerTarget, path: string): boolean {
  return getOrCreateLifecycle(ownerForTarget(target)).cachedPaths.has(path);
}

export function hasWorkerCachedPaths(source: CollRefHandle<unknown> | QueryHandle<unknown>): boolean {
  return getOrCreateLifecycle(ownerForTarget(source)).cachedPaths.size > 0;
}

function enableWorkerPersistence(db: unknown, fnName: string): Promise<void> {
  try {
    assertWorkerClientDb(db, fnName);
    assertWorkerFirestoreActive(db);
    const state = getOrCreateLifecycle(db);
    if (state.started || getOrCreateLifecycle(db.port).started || state.persistenceEnabled) {
      return Promise.reject(
        new FirebaseError(
          'failed-precondition',
          'Firestore has already been started and persistence can no longer be enabled.',
        ),
      );
    }
    state.persistenceEnabled = true;
    state.started = true;
    markHandlePersistentCache(db);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function enableIndexedDbPersistence(db: ClientDb, _settings?: { forceOwnership?: boolean }): Promise<void> {
  return enableWorkerPersistence(db, 'enableIndexedDbPersistence');
}

export function enableMultiTabIndexedDbPersistence(db: ClientDb): Promise<void> {
  return enableWorkerPersistence(db, 'enableMultiTabIndexedDbPersistence');
}

export function terminate(db: ClientDb): Promise<void> {
  try {
    assertWorkerClientDb(db, 'terminate');
  } catch (error) {
    return Promise.reject(error);
  }
  const state = getOrCreateLifecycle(db);
  if (state.terminated) return Promise.resolve();
  state.terminated = true;
  state.cachedPaths.clear();
  for (const stop of [...state.stopCallbacks]) {
    state.stopCallbacks.delete(stop);
    stop();
  }
  if (activeDbByPort.get(db.port) === db || activeDbByPort.get(db.port) === undefined) {
    activeDbByPort.delete(db.port);
    getOrCreateLifecycle(db.port).started = false;
    getOrCreateLifecycle(db.port).cachedPaths.clear();
    for (const resetPort of portTerminationResets) resetPort(db.port);
  }
  const teardown = dbTeardownCallbacks.get(db);
  if (teardown !== undefined) {
    dbTeardownCallbacks.delete(db);
    teardown();
  }
  return Promise.resolve();
}

export function ensureFirestoreConfigured(db: unknown): object {
  assertWorkerClientDb(db, 'ensureFirestoreConfigured');
  assertWorkerFirestoreActive(db);
  markWorkerHandleStarted(db);
  markWorkerPortStarted(db.port);
  return getOrCreateLifecycle(db);
}

export function executeWrite(
  db: unknown,
  mutations: readonly unknown[],
): Promise<void> {
  ensureFirestoreConfigured(db);
  if (!Array.isArray(mutations)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected second argument to executeWrite() to be an array of mutations.',
    );
  }
  if (mutations.length === 0) {
    return Promise.resolve();
  }
  return Promise.reject(
    new FirebaseError(
      'invalid-argument',
      'Unsupported internal mutation entry passed to executeWrite().',
    ),
  );
}
