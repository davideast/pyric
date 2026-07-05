/**
 * IndexedDB persistence layer for `@pyric/storage`.
 *
 * One database (`pyric-storage` by default), two object stores —
 * `blobs` for the file content and `metadata` for the descriptive
 * record. Both stores key on the file's full path string. Object
 * upload writes both stores within a single `readwrite` transaction
 * so the pair stays consistent — a partial failure can't leave a
 * blob without metadata or vice versa.
 *
 * Slice 3 of the v1 scope (per the design rationale):
 *
 * - Internal infrastructure; no public Storage API is exposed yet.
 *   Slice 5 builds `getStorage` / `ref` / `uploadBytes` / `getBytes` on
 *   top of this layer.
 * - The `StoredMetadata` shape mirrors Firebase's `FullMetadata`
 *   minus the `ref` field (computed at consumption time) and
 *   `downloadTokens` (deferred — no browser-renderable URLs in the
 *   v1 scope, per Section 4 of the survey).
 * - Database name is overridable so tests can isolate state per
 *   case via fake-indexeddb without colliding on the production
 *   default `pyric-storage`.
 *
 * Errors raised from this module are raw `DOMException`-shaped
 * objects — translation into Firebase-shaped `StorageError`s happens
 * in Slice 8 inside `errors.ts`. Keep this layer mechanical.
 */

const DEFAULT_DB_NAME = 'pyric-storage';
/**
 * Schema version. Bump and add an `upgradeneeded` branch when the
 * store layout changes. Slice 3 ships v1: two object stores keyed by
 * fullPath, no indexes. Future migrations follow IndexedDB's standard
 * upgrade path.
 */
const SCHEMA_VERSION = 1;
const BLOBS_STORE = 'blobs';
const METADATA_STORE = 'metadata';

/**
 * Persisted metadata for a single stored object. Mirrors Firebase's
 * `FullMetadata` so Slice 6 (the public `getMetadata` /
 * `updateMetadata` surface) can return this shape directly.
 *
 * Server-set fields (`generation`, `metageneration`, `timeCreated`,
 * `updated`, `bucket`, `fullPath`, `name`, `size`) are populated by
 * the upload pipeline before reaching this layer. The client-settable
 * fields (`contentType` through `customMetadata`) flow in from the
 * caller's `SettableMetadata`.
 */
export interface StoredMetadata {
  /** Full path of the object within the bucket. Also the store key. */
  fullPath: string;
  /** Last path segment (`b.txt` in `a/b.txt`). */
  name: string;
  /** Sandbox bucket id. v1 has a single implicit bucket. */
  bucket: string;
  /** Monotonically increasing version of the object content. */
  generation: string;
  /** Monotonically increasing version of just the metadata. */
  metageneration: string;
  /** ISO-8601 timestamp of original creation. */
  timeCreated: string;
  /** ISO-8601 timestamp of the most recent update (content or metadata). */
  updated: string;
  /** Size of the blob in bytes. */
  size: number;
  /** Client-settable: MIME type. Defaults to `application/octet-stream`. */
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  /** Free-form key/value annotations the client attached at upload. */
  customMetadata?: Record<string, string>;
  /** Hex-encoded MD5 hash of the content. Populated when computable. */
  md5Hash?: string;
}

/**
 * Persistence-layer interface. Higher layers (Slice 4's
 * `StorageService`, Slice 5's reference operations) interact with
 * the backend through this surface only — the IndexedDB calls stay
 * isolated behind it.
 *
 * All methods are async and return a promise that settles when the
 * underlying IDB transaction completes. Missing keys resolve to
 * `undefined` rather than throwing; the public API translates that
 * to `storage/object-not-found` in Slice 8.
 */
export interface StorageBackend {
  /**
   * Write a blob + its metadata atomically. Both stores update under
   * one `readwrite` transaction so a failure on either path rolls
   * the other back. Existing entries at the same path are replaced.
   */
  put(path: string, blob: Blob, metadata: StoredMetadata): Promise<void>;

  /**
   * Read the blob stored at `path`. Resolves to `undefined` when no
   * entry exists — callers translate that into `object-not-found`.
   */
  getBlob(path: string): Promise<Blob | undefined>;

  /**
   * Read the metadata record stored at `path`. Resolves to
   * `undefined` when no entry exists.
   */
  getMetadata(path: string): Promise<StoredMetadata | undefined>;

  /**
   * Replace the metadata record at `path` without touching the blob.
   * Used by `updateMetadata` (Slice 6). Caller is responsible for
   * preserving server-set fields (`generation`, `timeCreated`, …)
   * the spec says metadata-only updates leave intact.
   */
  putMetadata(path: string, metadata: StoredMetadata): Promise<void>;

  /**
   * Delete both the blob and the metadata at `path` atomically.
   * No-op when neither entry exists.
   */
  delete(path: string): Promise<void>;

  /**
   * Enumerate metadata records whose `fullPath` starts with `prefix`.
   * Returned in IndexedDB key order (lexicographic by path). The
   * prefix is used verbatim — no implicit trailing-slash addition,
   * matching the survey's path-semantics call (Section 6).
   */
  listByPrefix(prefix: string): Promise<StoredMetadata[]>;

  /**
   * Clear both stores. Called by Slice 4's `StorageService.reset`.
   */
  reset(): Promise<void>;

  /**
   * Close the underlying IndexedDB connection. Idempotent.
   */
  close(): void;
}

/**
 * Open (or create) the backing database and return a backend bound
 * to it. The connection stays open for the lifetime of the returned
 * backend; call `close()` before discarding it so future opens get a
 * clean handle.
 *
 * `dbName` is overridable so tests can isolate per-case state. In
 * production, callers pass nothing and inherit the default
 * `pyric-storage`.
 */
export function openStorageBackend(
  dbName: string = DEFAULT_DB_NAME,
): Promise<StorageBackend> {
  return openDatabase(dbName).then((db) => new IndexedDbStorageBackend(db));
}

// ─── Internal ──────────────────────────────────────────────────────

class IndexedDbStorageBackend implements StorageBackend {
  constructor(private readonly db: IDBDatabase) {}

  async put(path: string, blob: Blob, metadata: StoredMetadata): Promise<void> {
    const tx = this.db.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    tx.objectStore(BLOBS_STORE).put(blob, path);
    tx.objectStore(METADATA_STORE).put(metadata, path);
    await awaitTransaction(tx);
  }

  async getBlob(path: string): Promise<Blob | undefined> {
    const tx = this.db.transaction(BLOBS_STORE, 'readonly');
    return awaitRequest<Blob | undefined>(tx.objectStore(BLOBS_STORE).get(path));
  }

  async getMetadata(path: string): Promise<StoredMetadata | undefined> {
    const tx = this.db.transaction(METADATA_STORE, 'readonly');
    return awaitRequest<StoredMetadata | undefined>(
      tx.objectStore(METADATA_STORE).get(path),
    );
  }

  async putMetadata(path: string, metadata: StoredMetadata): Promise<void> {
    const tx = this.db.transaction(METADATA_STORE, 'readwrite');
    tx.objectStore(METADATA_STORE).put(metadata, path);
    await awaitTransaction(tx);
  }

  async delete(path: string): Promise<void> {
    const tx = this.db.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    tx.objectStore(BLOBS_STORE).delete(path);
    tx.objectStore(METADATA_STORE).delete(path);
    await awaitTransaction(tx);
  }

  async listByPrefix(prefix: string): Promise<StoredMetadata[]> {
    const tx = this.db.transaction(METADATA_STORE, 'readonly');
    // `IDBKeyRange.bound(prefix, prefix + '￿')` returns every
    // key that starts with `prefix` — '￿' is the highest BMP
    // code point, so any path whose first char beyond `prefix` is
    // legal will sort below it. Matches the survey's recommended
    // prefix-query pattern (Section 6).
    const range = IDBKeyRange.bound(prefix, prefix + '￿', false, false);
    return awaitRequest<StoredMetadata[]>(
      tx.objectStore(METADATA_STORE).getAll(range),
    );
  }

  async reset(): Promise<void> {
    const tx = this.db.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    tx.objectStore(BLOBS_STORE).clear();
    tx.objectStore(METADATA_STORE).clear();
    await awaitTransaction(tx);
  }

  close(): void {
    this.db.close();
  }
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, SCHEMA_VERSION);
    req.addEventListener('upgradeneeded', () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE);
      }
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE);
      }
    });
    req.addEventListener('success', () => resolve(req.result));
    req.addEventListener('error', () => reject(req.error));
    req.addEventListener('blocked', () =>
      reject(new Error(`IndexedDB open blocked for db "${dbName}"`)),
    );
  });
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener('success', () => resolve(req.result));
    req.addEventListener('error', () => reject(req.error));
  });
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('error', () => reject(tx.error));
    tx.addEventListener('abort', () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted')),
    );
  });
}
