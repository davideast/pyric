/**
 * Backends that satisfy {@link PersistenceBackend} (record-shaped, v3).
 *
 *   memory    = in-process Map<key, Map<recordId, record>>. Fallback in
 *               non-browser hosts and a deterministic store in tests. Clones
 *               records in/out so stored values are decoupled from callers,
 *               mirroring IndexedDB's structured-clone value semantics.
 *   indexedDB = one IndexedDB database per `key`, one object store
 *               (`snapshots`) holding many records keyed by bucket id. Records
 *               are stored natively (structured clone), so vectors and other
 *               binary-ish values persist without a keyspace-sized string.
 *
 * Each operation opens, transacts, and closes, no connection pooling. The
 * volume is "a handful of dirty buckets every few hundred ms", so open-cost is
 * irrelevant and not managing a long-lived connection across resets is simpler.
 */

import type { PersistenceBackend } from './types.js';
import { bundleRecords, parseBundle } from './chunk-format.js';

const OBJECT_STORE = 'snapshots';

/**
 * A record-shaped backend over a single-blob store (read/write/clear ONE blob).
 * The whole record set is bundled into that blob, for serve's committable export
 * file / HTTP state endpoint and any single-key store. It loses chunking's scale
 * benefit by design (the blob IS the single artifact). The blob is loaded once and
 * cached, so a restore (list + per-record get) costs one read, not one per record.
 */
export function recordBackendOverBlob(io: {
  read(): Promise<string | null>;
  write(blob: string): Promise<void>;
  clear(): Promise<void>;
}): PersistenceBackend {
  let cache: Map<string, unknown> | null = null;
  const load = async (): Promise<Map<string, unknown>> => {
    if (cache) return cache;
    const blob = await io.read();
    cache = blob ? parseBundle(blob) : new Map();
    return cache;
  };
  return {
    async getRecord(_key, recordId) {
      return (await load()).get(recordId) ?? null;
    },
    async listRecords() {
      return [...(await load()).keys()];
    },
    async putRecords(_key, records) {
      const all = await load();
      for (const [id, rec] of records) all.set(id, rec);
      await io.write(bundleRecords(all));
    },
    async deleteRecords(_key, recordIds) {
      const all = await load();
      for (const id of recordIds) all.delete(id);
      await io.write(bundleRecords(all));
    },
    async clear() {
      cache = new Map();
      await io.clear();
    },
  };
}

export function createMemoryBackend(): PersistenceBackend {
  const store = new Map<string, Map<string, unknown>>();
  const bucketsFor = (key: string): Map<string, unknown> => {
    let m = store.get(key);
    if (!m) {
      m = new Map();
      store.set(key, m);
    }
    return m;
  };
  return {
    async getRecord(key, recordId) {
      const rec = store.get(key)?.get(recordId);
      return rec === undefined ? null : structuredClone(rec);
    },
    async listRecords(key) {
      return [...(store.get(key)?.keys() ?? [])];
    },
    async putRecords(key, records) {
      const m = bucketsFor(key);
      for (const [id, rec] of records) m.set(id, structuredClone(rec));
    },
    async deleteRecords(key, recordIds) {
      const m = store.get(key);
      if (m) for (const id of recordIds) m.delete(id);
    },
    async clear(key) {
      store.delete(key);
    },
  };
}

/**
 * Open (or create) the IndexedDB database for `key`. Each backend operation
 * calls this fresh and closes the connection when done, which keeps the API simple
 * and avoids stale-connection bugs across sandbox resets.
 */
function openDb(key: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(key, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OBJECT_STORE)) {
        db.createObjectStore(OBJECT_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error(`Failed to open IndexedDB '${key}'`));
    req.onblocked = () =>
      reject(new Error(`IndexedDB open blocked for '${key}'`));
  });
}

/** Run a single store request and resolve with its result on tx complete. */
function runOp<T>(
  key: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  return openDb(key).then(
    (db) =>
      new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(OBJECT_STORE, mode);
        const store = tx.objectStore(OBJECT_STORE);
        const req = run(store);
        let result: T | null = null;
        if (req) {
          req.onsuccess = () => {
            result = (req.result as T) ?? null;
          };
          req.onerror = () => reject(req.error);
        }
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

/** Run many store mutations in ONE transaction; resolve on tx complete. */
function runBatch(
  key: string,
  fill: (store: IDBObjectStore) => void,
): Promise<void> {
  return openDb(key).then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(OBJECT_STORE, 'readwrite');
        fill(tx.objectStore(OBJECT_STORE));
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

/**
 * Build an IndexedDB-backed `PersistenceBackend`. Throws synchronously when
 * called outside a browser (no `indexedDB` global) so callers can detect the
 * absence and fall back to memory.
 */
export function createIndexedDBBackend(): PersistenceBackend {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      'IndexedDB is not available in this environment. ' +
        'Use { backend: "memory" } or supply an injectedBackend.',
    );
  }
  return {
    async getRecord(key, recordId) {
      const v = await runOp<unknown>(key, 'readonly', (store) =>
        store.get(recordId) as IDBRequest<unknown>,
      );
      return v ?? null;
    },
    async listRecords(key) {
      const keys = await runOp<IDBValidKey[]>(key, 'readonly', (store) =>
        store.getAllKeys() as IDBRequest<IDBValidKey[]>,
      );
      return (keys ?? []).map((k) => String(k));
    },
    async putRecords(key, records) {
      await runBatch(key, (store) => {
        for (const [id, rec] of records) store.put(rec, id);
      });
    },
    async deleteRecords(key, recordIds) {
      await runBatch(key, (store) => {
        for (const id of recordIds) store.delete(id);
      });
    },
    async clear(key) {
      await runOp(key, 'readwrite', (store) =>
        store.clear() as IDBRequest<undefined>,
      );
    },
    async estimate() {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
        return null;
      }
      const e = await navigator.storage.estimate();
      return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
    },
  };
}
