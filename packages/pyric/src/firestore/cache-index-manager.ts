/**
 * `pyric/firestore` -- `PersistentCacheIndexManager` controller and
 * `setIndexConfiguration` helpers.
 */
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { Firestore, type Firestore as FirestoreHandle } from './types.js';

export interface IndexField {
  fieldPath: string;
  order?: 'ascending' | 'descending' | 'ASCENDING' | 'DESCENDING';
  arrayConfig?: 'contains' | 'CONTAINS';
}

export interface Index {
  collectionGroup: string;
  queryScope?: string;
  fields?: IndexField[];
}

export interface IndexConfiguration {
  indexes?: Index[];
  fieldOverrides?: unknown[];
}

const handleCacheModes = new WeakMap<object, 'memory' | 'persistent'>();
const indexManagers = new WeakMap<object, PersistentCacheIndexManager>();

export class PersistentCacheIndexManager {
  readonly type = 'PersistentCacheIndexManager' as const;

  constructor(private readonly _db?: FirestoreHandle) {
    void this._db;
  }
}

export function getPersistentCacheIndexManager(
  db: FirestoreHandle,
): PersistentCacheIndexManager | null {
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to getPersistentCacheIndexManager() to be a Firestore instance.',
    );
  }
  const mode = handleCacheModes.get(db as object);
  if (mode !== 'persistent') {
    return null;
  }
  const existing = indexManagers.get(db as object);
  if (existing !== undefined) {
    return existing;
  }
  const created = new PersistentCacheIndexManager(db);
  indexManagers.set(db as object, created);
  return created;
}

function assertIndexManager(
  indexManager: unknown,
  fnName: string,
): asserts indexManager is PersistentCacheIndexManager {
  if (!(indexManager instanceof PersistentCacheIndexManager)) {
    throw new FirebaseError(
      'invalid-argument',
      `Expected first argument to ${fnName}() to be a PersistentCacheIndexManager instance.`,
    );
  }
}

export function enablePersistentCacheIndexAutoCreation(
  indexManager: PersistentCacheIndexManager,
): void {
  assertIndexManager(indexManager, 'enablePersistentCacheIndexAutoCreation');
}

export function disablePersistentCacheIndexAutoCreation(
  indexManager: PersistentCacheIndexManager,
): void {
  assertIndexManager(indexManager, 'disablePersistentCacheIndexAutoCreation');
}

export function deleteAllPersistentCacheIndexes(
  indexManager: PersistentCacheIndexManager,
): void {
  assertIndexManager(indexManager, 'deleteAllPersistentCacheIndexes');
}

export async function setIndexConfiguration(
  db: FirestoreHandle,
  configuration: IndexConfiguration | string,
): Promise<void> {
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to setIndexConfiguration() to be a Firestore instance.',
    );
  }
  if (typeof configuration === 'string') {
    try {
      JSON.parse(configuration);
    } catch {
      throw new FirebaseError(
        'invalid-argument',
        'Invalid JSON string passed to setIndexConfiguration().',
      );
    }
  }
}

export function setHandleCacheTier(handle: object, tier: 'memory' | 'persistent'): void {
  handleCacheModes.set(handle, tier);
  if (tier !== 'persistent') {
    indexManagers.delete(handle);
  }
}

export function hasHandleCacheTier(handle: object): boolean {
  return handleCacheModes.has(handle);
}

export function clearHandleCacheTier(handle: object): void {
  handleCacheModes.delete(handle);
  indexManagers.delete(handle);
}

export function markHandlePersistentCache(handle: object): void {
  setHandleCacheTier(handle, 'persistent');
}
