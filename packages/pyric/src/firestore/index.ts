/**
 * `pyric/firestore` -- modular Web-SDK Firestore adapter for the Pyric sandbox.
 *
 * Re-export barrel over the per-family modules in this directory.
 */

export { TARGET_SYMBOL } from './state.js';
export * from './types.js';
export * from './instances.js';
export * from './equality.js';
export {
  memoryEagerGarbageCollector,
  memoryLocalCache,
  memoryLruGarbageCollector,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  type FirestoreLocalCache,
  type LocalCache,
  type MemoryCacheSettings,
  type MemoryEagerGarbageCollector,
  type MemoryGarbageCollector,
  type MemoryLocalCache,
  type MemoryLruGarbageCollector,
  type PersistentCacheSettings,
  type PersistentLocalCache,
  type PersistentMultipleTabManager,
  type PersistentSingleTabManager,
  type PersistentSingleTabManagerSettings,
  type PersistentTabManager,
} from './cache-tokens.js';
export {
  deleteAllPersistentCacheIndexes,
  disablePersistentCacheIndexAutoCreation,
  enablePersistentCacheIndexAutoCreation,
  getPersistentCacheIndexManager,
  PersistentCacheIndexManager,
  setIndexConfiguration,
  type Index,
  type IndexConfiguration,
  type IndexField,
} from './cache-index-manager.js';
export type { FirestoreSettings } from './init-settings.js';
export * from './persistence.js';
export * from './refs.js';
export { getDoc, getDocs } from './reads.js';
export * from './writes.js';
export * from './query-constraints.js';
export * from './aggregates.js';
export { onSnapshot, type SnapshotListenOptions, type SnapshotObserver } from './listeners.js';
export * from './transactions.js';
export * from './field-values.js';
export {
  LoadBundleTask,
  loadBundle,
  namedQuery,
  type LoadBundleTaskProgress,
  type TaskState,
} from './bundles.js';
export {
  documentSnapshotFromJSON,
  querySnapshotFromJSON,
  type ListenSource,
  type SnapshotOptions,
} from './ssr-snapshots.js';
export { onSnapshotResume } from './snapshot-resume.js';
export { createFirestoreDataTools, createFirestoreInspectTools } from './tools.js';
export type {
  FirestoreDataToolDeps,
  FirestoreInspectToolDeps,
  UserAuth,
  As,
} from './tools.js';
