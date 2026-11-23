/**
 * SharedWorker persistence adapter keying named Firestore databases to
 * `<baseKey>/firestore/<id>` IndexedDB stores while keeping `meta` (including
 * `firestoreDeclared`) in `<baseKey>` only (ADR-0021 Decision 5).
 */
import type { PersistenceBackend, Sandbox } from 'pyric/sandbox';
import { CHUNK_FORMAT_VERSION } from 'pyric/sandbox/internal';
import {
  firestoreRecordSpaceKey,
  firestoreRecordSpacePrefix,
  listDeclaredFirestoreDatabases,
  markAllNamedFirestoreDirty,
  onNamedFirestorePersistenceChange,
  parseFirestoreRecordSpaceKey,
  prepareNamedFirestorePersistence,
  readFirestoreDeclaredFromMeta,
  restoreNamedFirestorePersistence,
  stampFirestoreDeclaredOnMeta,
} from 'pyric/firestore/internal';

export interface MirrorablePersistenceBackend extends PersistenceBackend {
  putRecordsWithoutMirror?(key: string, records: ReadonlyMap<string, unknown>): Promise<void>;
  deleteRecordsWithoutMirror?(key: string, recordIds: readonly string[]): Promise<void>;
  clearWithoutMirror?(key: string): Promise<void>;
  flushMirror?(baseKey: string, knownNamedIds?: Iterable<string>): Promise<void>;
  onClear?(listener: () => Promise<void> | void): () => void;
}

async function discoverIndexedDbNamedKeys(baseKey: string): Promise<string[]> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    return [];
  }
  try {
    const prefix = firestoreRecordSpacePrefix(baseKey);
    const infos = await indexedDB.databases();
    const matched: string[] = [];
    for (const info of infos) {
      if (typeof info.name === 'string' && info.name.startsWith(prefix)) {
        matched.push(info.name);
      }
    }
    return matched;
  } catch {
    return [];
  }
}

export interface WorkerFirestorePersistenceBinding {
  readonly backend: PersistenceBackend;
  hydrate(): Promise<void>;
  dispose(): void;
}

export function createWorkerFirestorePersistenceBinding(
  sandbox: Sandbox,
  underlying: MirrorablePersistenceBackend,
  baseKey: string,
): WorkerFirestorePersistenceBinding {
  const knownNamedIds = new Set<string>();
  let disposed = false;
  let restoringHydratedState = false;
  let autoFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const putNoMirror = async (key: string, records: ReadonlyMap<string, unknown>): Promise<void> => {
    if (underlying.putRecordsWithoutMirror !== undefined) {
      await underlying.putRecordsWithoutMirror(key, records);
      return;
    }
    await underlying.putRecords(key, records);
  };

  const deleteNoMirror = async (key: string, recordIds: readonly string[]): Promise<void> => {
    if (underlying.deleteRecordsWithoutMirror !== undefined) {
      await underlying.deleteRecordsWithoutMirror(key, recordIds);
      return;
    }
    await underlying.deleteRecords(key, recordIds);
  };

  const clearNoMirror = async (key: string): Promise<void> => {
    if (underlying.clearWithoutMirror !== undefined) {
      await underlying.clearWithoutMirror(key);
      return;
    }
    await underlying.clear(key);
  };

  const commitMultiSpace = async (
    key: string,
    changed: ReadonlyMap<string, unknown>,
    removed: readonly string[],
  ): Promise<void> => {
    if (key !== baseKey) {
      if (changed.size > 0) await underlying.putRecords(key, changed);
      if (removed.length > 0) await underlying.deleteRecords(key, removed);
      return;
    }

    const plan = prepareNamedFirestorePersistence(sandbox);
    const effectiveChanged = new Map<string, unknown>(changed);

    if (effectiveChanged.has('meta')) {
      const rawMeta = effectiveChanged.get('meta');
      if (rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
        effectiveChanged.set(
          'meta',
          stampFirestoreDeclaredOnMeta(rawMeta as Record<string, unknown>, plan.declared),
        );
      }
    } else if (plan.declaredChanged) {
      const priorMeta = await underlying.getRecord(key, 'meta');
      let baseMeta: Record<string, unknown>;
      if (priorMeta !== null && typeof priorMeta === 'object' && !Array.isArray(priorMeta)) {
        baseMeta = priorMeta as Record<string, unknown>;
      } else {
        baseMeta = { version: CHUNK_FORMAT_VERSION, savedAt: Date.now(), services: {} };
      }
      effectiveChanged.set('meta', stampFirestoreDeclaredOnMeta(baseMeta, plan.declared));
    }

    for (const dbId of plan.declared) {
      knownNamedIds.add(dbId);
    }

    const hasBaseWork = effectiveChanged.size > 0 || removed.length > 0;
    if (!hasBaseWork && plan.databases.size === 0) {
      plan.commit();
      return;
    }

    try {
      if (effectiveChanged.size > 0) await putNoMirror(key, effectiveChanged);
      if (removed.length > 0) await deleteNoMirror(key, removed);

      for (const [dbId, diff] of plan.databases) {
        knownNamedIds.add(dbId);
        const dbKey = firestoreRecordSpaceKey(key, dbId);
        if (diff.changed.size > 0) await putNoMirror(dbKey, diff.changed);
        if (diff.removed.length > 0) await deleteNoMirror(dbKey, diff.removed);
      }

      if (underlying.flushMirror !== undefined) {
        await underlying.flushMirror(key, knownNamedIds);
      }
      plan.commit();
    } catch (error) {
      plan.retry();
      throw error;
    }
  };

  const unsubNamedChanges = onNamedFirestorePersistenceChange(sandbox, () => {
    if (disposed || restoringHydratedState || autoFlushTimer !== null) return;
    autoFlushTimer = setTimeout(() => {
      autoFlushTimer = null;
      if (disposed) return;
      void sandbox.flush().catch(() => {});
    }, 50);
  });

  const unsubDispose = sandbox.onEvent((event) => {
    if (event.kind === 'session_boundary' && event.phase === 'dispose') {
      dispose();
    }
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (autoFlushTimer !== null) {
      clearTimeout(autoFlushTimer);
      autoFlushTimer = null;
    }
    unsubNamedChanges();
    unsubDispose();
  }

  const backend: PersistenceBackend = {
    retryFailedFlush: underlying.retryFailedFlush,
    getRecord(key, recordId) {
      return underlying.getRecord(key, recordId);
    },
    listRecords(key) {
      return underlying.listRecords(key);
    },
    async applyChanges(key, changed, removed) {
      await commitMultiSpace(key, changed, removed);
    },
    async putRecords(key, records) {
      await commitMultiSpace(key, records, []);
    },
    async deleteRecords(key, recordIds) {
      await commitMultiSpace(key, new Map(), recordIds);
    },
    async clear(key) {
      if (key !== baseKey) {
        await underlying.clear(key);
        return;
      }
      if (autoFlushTimer !== null) {
        clearTimeout(autoFlushTimer);
        autoFlushTimer = null;
      }
      const keysToClear = new Set<string>();
      for (const dbId of knownNamedIds) {
        keysToClear.add(firestoreRecordSpaceKey(baseKey, dbId));
      }
      for (const dbId of listDeclaredFirestoreDatabases(sandbox)) {
        keysToClear.add(firestoreRecordSpaceKey(baseKey, dbId));
      }
      const discovered = await discoverIndexedDbNamedKeys(baseKey);
      for (const discoveredKey of discovered) {
        keysToClear.add(discoveredKey);
      }
      for (const namedKey of keysToClear) {
        await clearNoMirror(namedKey);
        if (typeof indexedDB !== 'undefined' && typeof indexedDB.deleteDatabase === 'function') {
          try {
            indexedDB.deleteDatabase(namedKey);
          } catch {
            // Best-effort IDB database deletion after store clear.
          }
        }
      }
      knownNamedIds.clear();
      await underlying.clear(baseKey);
      markAllNamedFirestoreDirty(sandbox);
    },
  };

  async function hydrate(): Promise<void> {
    const meta = await underlying.getRecord(baseKey, 'meta');
    const declared = readFirestoreDeclaredFromMeta(meta);
    const dbRecords = new Map<string, Array<[string, unknown]>>();
    for (const dbId of declared) {
      knownNamedIds.add(dbId);
      const dbKey = firestoreRecordSpaceKey(baseKey, dbId);
      const ids = await underlying.listRecords(dbKey);
      const entries: Array<[string, unknown]> = [];
      for (const id of ids) {
        const record = await underlying.getRecord(dbKey, id);
        if (record !== null && record !== undefined) {
          entries.push([id, record]);
        }
      }
      dbRecords.set(dbId, entries);
    }
    const discovered = await discoverIndexedDbNamedKeys(baseKey);
    for (const discoveredKey of discovered) {
      const parsedId = parseFirestoreRecordSpaceKey(baseKey, discoveredKey);
      if (parsedId !== null && parsedId !== '(default)') {
        knownNamedIds.add(parsedId);
      }
    }
    restoringHydratedState = true;
    try {
      restoreNamedFirestorePersistence(sandbox, declared, dbRecords);
    } finally {
      restoringHydratedState = false;
    }
  }

  return { backend, hydrate, dispose };
}
