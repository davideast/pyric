/**
 * IndexedDB-backed metadata store for the OPFS VFS.
 *
 * OPFS file handles expose `size` and `lastModified` but lack the
 * Unix-like fields `isomorphic-git` reads through `stat`/`lstat`:
 * `mode`, `ino`, `ctimeMs`, and the file-type distinction needed for
 * symlinks. We mirror those fields here in a single object store
 * (`meta`) keyed by absolute VFS path. Symlinks live entirely in this
 * store — they have no OPFS file at all.
 *
 * The IDB layout matches `packages/sandbox/src/persistence/backends.ts`:
 * a thin Promise wrapper over the raw request API, one open per op,
 * no connection pooling. Volume is low and the simplification is
 * worth more than micro-optimising open cost.
 */

const DB_NAME = 'pyric:opfs-meta';
const STORE = 'meta';
const INO_KEY = '__ino_counter__';

export interface FileMeta {
  ino: number;
  mode: number;
  ctimeMs: number;
  mtimeMs: number;
  type: 'file' | 'dir' | 'symlink';
  symlinkTarget?: string;
}

export interface MetaStore {
  get(path: string): Promise<FileMeta | null>;
  set(path: string, meta: FileMeta): Promise<void>;
  delete(path: string): Promise<void>;
  /** Direct child names (no nested descendants) of `dirPath`. */
  listChildren(dirPath: string): Promise<string[]>;
  /** Atomically increment and return the next inode number. */
  nextIno(): Promise<number>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`Failed to open IndexedDB '${DB_NAME}'`));
    req.onblocked = () => reject(new Error(`IndexedDB open blocked for '${DB_NAME}'`));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let value: T;
        let settled = false;
        run(store).then(
          (v) => {
            value = v;
            settled = true;
          },
          (e) => {
            settled = true;
            reject(e);
            try {
              tx.abort();
            } catch {
              // tx may already be finishing — abort is best-effort.
            }
          },
        );
        tx.oncomplete = () => {
          db.close();
          if (settled) resolve(value!);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          if (!settled) reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Direct-child key derivation. A child of `/a/b` looks like `/a/b/<name>`
 * with no further `/`. Root (`/`) children look like `/<name>` with no
 * further `/`. We normalise the prefix so both cases collapse to the
 * same scan: prefix `/a/b/` → look for `<prefix><name>` with no slash
 * in `<name>`.
 */
function childPrefix(dirPath: string): string {
  if (dirPath === '/' || dirPath === '') return '/';
  return dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
}

let singleton: MetaStore | null = null;

export function getMetaStore(): MetaStore {
  if (singleton) return singleton;
  singleton = {
    async get(path) {
      return withStore('readonly', async (store) => {
        const value = await reqAsPromise(store.get(path));
        return (value as FileMeta | undefined) ?? null;
      });
    },
    async set(path, meta) {
      await withStore('readwrite', async (store) => {
        await reqAsPromise(store.put(meta, path));
      });
    },
    async delete(path) {
      await withStore('readwrite', async (store) => {
        await reqAsPromise(store.delete(path));
      });
    },
    async listChildren(dirPath) {
      const prefix = childPrefix(dirPath);
      return withStore('readonly', async (store) => {
        // Range [prefix, prefix + '￿'] captures every key starting
        // with `prefix`. We then filter to direct children (no further '/').
        const range = IDBKeyRange.bound(prefix, `${prefix}￿`, false, false);
        const names: string[] = [];
        await new Promise<void>((resolve, reject) => {
          const req = store.openCursor(range);
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve();
              return;
            }
            const key = cursor.key as string;
            if (key !== INO_KEY) {
              const tail = key.slice(prefix.length);
              if (tail.length > 0 && !tail.includes('/')) {
                names.push(tail);
              }
            }
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
        });
        return names;
      });
    },
    async nextIno() {
      return withStore('readwrite', async (store) => {
        const current = ((await reqAsPromise(store.get(INO_KEY))) as number | undefined) ?? 0;
        const next = current + 1;
        await reqAsPromise(store.put(next, INO_KEY));
        return next;
      });
    },
  };
  return singleton;
}
