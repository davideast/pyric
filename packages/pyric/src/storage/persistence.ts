/**
 * IndexedDB persistence layer for `pyric/storage`.
 *
 * One database (`pyric-storage` by default), two object stores —
 * `blobs` for the file content and `metadata` for the descriptive
 * record. Both stores key on composite bucket and path strings
 * (`${bucket}/${fullPath}`) to isolate storage persistence across
 * buckets. Object upload writes both stores within a single `readwrite`
 * transaction so the pair stays consistent — a partial failure can't
 * leave a blob without metadata or vice versa.
 *
 * Slice 3 of the v1 scope (per the design rationale):
 *
 * - Internal infrastructure; no public Storage API is exposed yet.
 *   Slice 5 builds `getStorage` / `ref` / `uploadBytes` / `getBytes` on
 *   top of this layer.
 * - The `StoredMetadata` shape mirrors Firebase's `FullMetadata`
 *   minus the `ref` field (computed at consumption time) and
 *   `downloadTokens` (sandbox `getDownloadURL` encodes the blob into a `data:`
 *   URI instead of minting Firebase download tokens).
 * - Database name is overridable so tests can isolate state per
 *   case via fake-indexeddb without colliding on the production
 *   default `pyric-storage`.
 *
 * Errors raised from this module are raw `DOMException`-shaped
 * objects — translation into Firebase-shaped `StorageError`s happens
 * in Slice 8 inside `errors.ts`. Keep this layer mechanical.
 */

/**
 * Legacy shared database name — used only when NO project identity is
 * available (bare library use, tests that don't pass a name).
 *
 * IndexedDB is origin-scoped, so under this fixed name every project served
 * on the same localhost port shared ONE storage database (issue #359,
 * defect B) — "old data" from unrelated projects surfaced in Studio.
 * Project-scoped callers now open `pyric-storage:<projectId>` via
 * {@link storageDbName} instead.
 *
 * Migration decision (deliberate, recorded here): the old shared
 * `pyric-storage` database is ORPHANED, not migrated — cross-project data
 * disappearing from Studio is the desired outcome of the fix. It is not
 * deleted either: other pyric versions on the same origin may still read it.
 */
const DEFAULT_DB_NAME = 'pyric-storage';

/**
 * Default sandbox bucket identifier when not explicitly provided.
 */
export const DEFAULT_BUCKET = 'pyric-default';

/**
 * Encode a composite key scoping an object path to its bucket: `${bucket}/${fullPath}`.
 */
export function toStorageKey(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

/**
 * Decode a composite key into bucket and object path.
 */
export function parseStorageKey(key: string): { bucket: string; path: string } | null {
  const slashIdx = key.indexOf('/');
  if (slashIdx === -1) return null;
  return {
    bucket: key.slice(0, slashIdx),
    path: key.slice(slashIdx + 1),
  };
}

/**
 * Resolve the default IndexedDB database name for a project identity:
 * `pyric-storage:<projectId>`, or the legacy shared {@link DEFAULT_DB_NAME}
 * when no identity is available. An explicit `dbName` option always wins
 * over this derivation (see `StorageOptions`).
 */
export function storageDbName(projectId?: string | null): string {
  return projectId ? `${DEFAULT_DB_NAME}:${projectId}` : DEFAULT_DB_NAME;
}
/**
 * Schema version. Bump and add an `upgradeneeded` branch when the
 * store layout changes.
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
  /** Full path of the object within the bucket. */
  fullPath: string;
  /** Last path segment (`b.txt` in `a/b.txt`). */
  name: string;
  /** Sandbox bucket id. */
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
   * Read the blob stored at `path` within `bucket`. Resolves to `undefined` when no
   * entry exists — callers translate that into `object-not-found`.
   */
  getBlob(path: string, bucket?: string): Promise<Blob | undefined>;

  /**
   * Read the metadata record stored at `path` within `bucket`. Resolves to
   * `undefined` when no entry exists.
   */
  getMetadata(path: string, bucket?: string): Promise<StoredMetadata | undefined>;

  /**
   * Replace the metadata record at `path` without touching the blob.
   * Used by `updateMetadata` (Slice 6). Caller is responsible for
   * preserving server-set fields (`generation`, `timeCreated`, …)
   * the spec says metadata-only updates leave intact.
   */
  putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void>;

  /**
   * Delete both the blob and the metadata at `path` atomically.
   * No-op when neither entry exists.
   */
  delete(path: string, bucket?: string): Promise<void>;

  /**
   * Enumerate metadata records whose `fullPath` starts with `prefix`.
   * Returned in key order (lexicographic by path within bucket). The
   * prefix is used verbatim — no implicit trailing-slash addition,
   * matching the survey's path-semantics call (Section 6).
   */
  listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]>;

  /**
   * Clear stores. If `bucket` is supplied, clears only entries in that bucket;
   * otherwise clears all stores.
   */
  reset(bucket?: string): Promise<void>;

  /**
   * Close the underlying IndexedDB connection. Idempotent.
   */
  close(): void;

  /**
   * Return a view of this backend scoped to a specific bucket.
   */
  scoped?(bucket: string): StorageBackend;

  /**
   * Begin a chunked upload session (ADR 0015).
   */
  beginUpload?(
    bucket: string | undefined,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
    connectionId?: string,
  ): Promise<string>;

  /**
   * Append a staged part to an active upload session.
   */
  putPart?(uploadId: string, partIndex: number, bytes: Uint8Array): Promise<{ bytesReceived: number } | void>;

  /**
   * Commit an active upload session, verifying that staged bytes match declared size.
   */
  finishUpload?(uploadId: string): Promise<StoredMetadata>;

  /**
   * Abort an active upload session and purge staged parts.
   */
  abortUpload?(uploadId: string): Promise<void>;

  /**
   * Read a slice of an object's bytes without loading the entire payload into memory.
   */
  readRange?(
    bucket: string | undefined,
    path: string,
    offset: number,
    length: number,
    expectedGeneration?: string,
  ): Promise<Uint8Array | undefined>;
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
export async function openStorageBackend(
  dbName: string = DEFAULT_DB_NAME,
  defaultBucket?: string,
): Promise<StorageBackend> {
  try {
    const db = await openDatabase(dbName);
    return new IndexedDbStorageBackend(db, defaultBucket);
  } catch (err) {
    return new InMemoryStorageBackend(defaultBucket);
  }
}

interface StagedPartUpload {
  uploadId: string;
  bucket: string;
  path: string;
  size: number;
  contentType: string;
  customMetadata?: Record<string, string>;
  parts: Map<number, Uint8Array>;
  createdAt: number;
}

class InMemoryUploadStaging {
  private readonly uploads = new Map<string, StagedPartUpload>();

  beginUpload(
    bucket: string,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): string {
    const uploadId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.uploads.set(uploadId, {
      uploadId,
      bucket,
      path,
      size,
      contentType,
      customMetadata,
      parts: new Map(),
      createdAt: Date.now(),
    });
    return uploadId;
  }

  putPart(uploadId: string, partIndex: number, bytes: Uint8Array): { bytesReceived: number } {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      const err = new Error(`storage/object-not-found: Upload '${uploadId}' not found.`) as Error & { code: string };
      err.code = 'storage/object-not-found';
      throw err;
    }
    upload.parts.set(partIndex, bytes);
    let bytesReceived = 0;
    for (const part of upload.parts.values()) {
      bytesReceived += part.byteLength;
    }
    return { bytesReceived };
  }

  finishUpload(uploadId: string): { upload: StagedPartUpload; fullBytes: Uint8Array } {
    const upload = this.uploads.get(uploadId);
    if (!upload) {
      const err = new Error(`storage/object-not-found: Upload '${uploadId}' not found.`) as Error & { code: string };
      err.code = 'storage/object-not-found';
      throw err;
    }
    let totalLength = 0;
    const sortedIndices = Array.from(upload.parts.keys()).sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      totalLength += upload.parts.get(idx)!.byteLength;
    }
    if (totalLength !== upload.size) {
      const err = new Error(`storage/invalid-argument: Uploaded bytes (${totalLength}) did not match declared size (${upload.size}).`) as Error & { code: string };
      err.code = 'storage/invalid-argument';
      throw err;
    }
    const fullBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const idx of sortedIndices) {
      const part = upload.parts.get(idx)!;
      fullBytes.set(part, offset);
      offset += part.byteLength;
    }
    this.uploads.delete(uploadId);
    return { upload, fullBytes };
  }

  abortUpload(uploadId: string): void {
    this.uploads.delete(uploadId);
  }
}

export class InMemoryStorageBackend implements StorageBackend {
  private readonly blobs = new Map<string, Blob>();
  private readonly metadata = new Map<string, StoredMetadata>();
  private readonly staging = new InMemoryUploadStaging();
  private _defaultBucket: string | undefined;

  constructor(defaultBucket?: string) {
    this._defaultBucket = defaultBucket;
  }

  async put(path: string, blob: Blob, metadata: StoredMetadata): Promise<void> {
    const bucket = metadata.bucket || this._defaultBucket || DEFAULT_BUCKET;
    if (!this._defaultBucket) {
      this._defaultBucket = bucket;
    }
    if (!metadata.bucket) {
      metadata.bucket = bucket;
    }
    const key = toStorageKey(bucket, path);
    this.blobs.set(key, blob);
    this.metadata.set(key, metadata);
  }

  async getBlob(path: string, bucket?: string): Promise<Blob | undefined> {
    if (bucket) {
      return this.blobs.get(toStorageKey(bucket, path));
    }
    const targetBucket = this._defaultBucket ?? DEFAULT_BUCKET;
    const direct = this.blobs.get(toStorageKey(targetBucket, path));
    if (direct !== undefined) return direct;
    if (targetBucket !== DEFAULT_BUCKET) {
      const def = this.blobs.get(toStorageKey(DEFAULT_BUCKET, path));
      if (def !== undefined) return def;
    }
    for (const [key, blob] of this.blobs.entries()) {
      const parsed = parseStorageKey(key);
      if (parsed && parsed.path === path) {
        return blob;
      }
    }
    return undefined;
  }

  async getMetadata(path: string, bucket?: string): Promise<StoredMetadata | undefined> {
    if (bucket) {
      return this.metadata.get(toStorageKey(bucket, path));
    }
    const targetBucket = this._defaultBucket ?? DEFAULT_BUCKET;
    const direct = this.metadata.get(toStorageKey(targetBucket, path));
    if (direct !== undefined) return direct;
    if (targetBucket !== DEFAULT_BUCKET) {
      const def = this.metadata.get(toStorageKey(DEFAULT_BUCKET, path));
      if (def !== undefined) return def;
    }
    for (const [key, meta] of this.metadata.entries()) {
      const parsed = parseStorageKey(key);
      if (parsed && parsed.path === path) {
        return meta;
      }
    }
    return undefined;
  }

  async putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void> {
    const b = bucket ?? metadata.bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    if (!metadata.bucket) metadata.bucket = b;
    this.metadata.set(toStorageKey(b, path), metadata);
  }

  async delete(path: string, bucket?: string): Promise<void> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    this.blobs.delete(toStorageKey(targetBucket, path));
    this.metadata.delete(toStorageKey(targetBucket, path));
  }

  async listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const keyPrefix = `${targetBucket}/${prefix}`;
    const results: StoredMetadata[] = [];
    const keys = Array.from(this.metadata.keys()).sort();
    for (const key of keys) {
      if (key.startsWith(keyPrefix)) {
        const meta = this.metadata.get(key);
        if (meta) results.push(meta);
      }
    }
    return results;
  }

  async reset(bucket?: string): Promise<void> {
    if (!bucket) {
      this.blobs.clear();
      this.metadata.clear();
      this._defaultBucket = undefined;
      return;
    }
    const bucketPrefix = `${bucket}/`;
    for (const key of Array.from(this.blobs.keys())) {
      if (key.startsWith(bucketPrefix)) {
        this.blobs.delete(key);
      }
    }
    for (const key of Array.from(this.metadata.keys())) {
      if (key.startsWith(bucketPrefix)) {
        this.metadata.delete(key);
      }
    }
  }

  async beginUpload(
    bucket: string | undefined,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): Promise<string> {
    const b = bucket || this._defaultBucket || DEFAULT_BUCKET;
    return this.staging.beginUpload(b, path, size, contentType, customMetadata);
  }

  async putPart(uploadId: string, partIndex: number, bytes: Uint8Array): Promise<{ bytesReceived: number }> {
    return this.staging.putPart(uploadId, partIndex, bytes);
  }

  async finishUpload(uploadId: string): Promise<StoredMetadata> {
    const { upload, fullBytes } = this.staging.finishUpload(uploadId);
    const now = new Date().toISOString();
    const generation = String(Date.now());
    const stored: StoredMetadata = {
      bucket: upload.bucket,
      fullPath: upload.path,
      name: upload.path.split('/').pop() ?? upload.path,
      size: upload.size,
      generation,
      metageneration: '1',
      timeCreated: now,
      updated: now,
      contentType: upload.contentType,
      customMetadata: upload.customMetadata,
    };
    const blob = new Blob([fullBytes as unknown as BlobPart], { type: upload.contentType });
    await this.put(upload.path, blob, stored);
    return stored;
  }

  async abortUpload(uploadId: string): Promise<void> {
    this.staging.abortUpload(uploadId);
  }

  async readRange(
    bucket: string | undefined,
    path: string,
    offset: number,
    length: number,
    expectedGeneration?: string,
  ): Promise<Uint8Array | undefined> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const meta = await this.getMetadata(path, targetBucket);
    if (!meta) return undefined;
    if (expectedGeneration !== undefined && meta.generation !== expectedGeneration) {
      const err = new Error('storage/object-changed: The object changed while reading. Re-read metadata and retry.') as Error & { code: string };
      err.code = 'storage/object-changed';
      throw err;
    }
    const blob = await this.getBlob(path, targetBucket);
    if (!blob) return undefined;
    const slice = blob.slice(offset, offset + length);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }

  close(): void {}

  scoped(bucket: string): StorageBackend {
    return new ScopedStorageBackend(this, bucket);
  }
}

// ─── Internal ──────────────────────────────────────────────────────

export class IndexedDbStorageBackend implements StorageBackend {
  private readonly staging = new InMemoryUploadStaging();
  private _defaultBucket: string | undefined;

  constructor(
    private readonly db: IDBDatabase,
    defaultBucket?: string,
  ) {
    this._defaultBucket = defaultBucket;
  }

  async put(path: string, blob: Blob, metadata: StoredMetadata): Promise<void> {
    const bucket = metadata.bucket || this._defaultBucket || DEFAULT_BUCKET;
    if (!this._defaultBucket) {
      this._defaultBucket = bucket;
    }
    if (!metadata.bucket) {
      metadata.bucket = bucket;
    }
    const key = toStorageKey(bucket, path);
    const tx = this.db.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    tx.objectStore(BLOBS_STORE).put(blob, key);
    tx.objectStore(METADATA_STORE).put(metadata, key);
    await awaitTransaction(tx);
  }

  async getBlob(path: string, bucket?: string): Promise<Blob | undefined> {
    const tx = this.db.transaction(BLOBS_STORE, 'readonly');
    const store = tx.objectStore(BLOBS_STORE);
    if (bucket) {
      return awaitRequest<Blob | undefined>(store.get(toStorageKey(bucket, path)));
    }
    const targetBucket = this._defaultBucket ?? DEFAULT_BUCKET;
    const direct = await awaitRequest<Blob | undefined>(store.get(toStorageKey(targetBucket, path)));
    if (direct !== undefined) return direct;
    if (targetBucket !== DEFAULT_BUCKET) {
      const def = await awaitRequest<Blob | undefined>(store.get(toStorageKey(DEFAULT_BUCKET, path)));
      if (def !== undefined) return def;
    }
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.addEventListener('success', () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(undefined);
          return;
        }
        const key = String(cursor.key);
        const parsed = parseStorageKey(key);
        if (parsed && parsed.path === path) {
          resolve(cursor.value as Blob);
          return;
        }
        cursor.continue();
      });
      req.addEventListener('error', () => reject(req.error));
    });
  }

  async getMetadata(path: string, bucket?: string): Promise<StoredMetadata | undefined> {
    const tx = this.db.transaction(METADATA_STORE, 'readonly');
    const store = tx.objectStore(METADATA_STORE);
    if (bucket) {
      return awaitRequest<StoredMetadata | undefined>(store.get(toStorageKey(bucket, path)));
    }
    const targetBucket = this._defaultBucket ?? DEFAULT_BUCKET;
    const direct = await awaitRequest<StoredMetadata | undefined>(store.get(toStorageKey(targetBucket, path)));
    if (direct !== undefined) return direct;
    if (targetBucket !== DEFAULT_BUCKET) {
      const def = await awaitRequest<StoredMetadata | undefined>(store.get(toStorageKey(DEFAULT_BUCKET, path)));
      if (def !== undefined) return def;
    }
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.addEventListener('success', () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(undefined);
          return;
        }
        const key = String(cursor.key);
        const parsed = parseStorageKey(key);
        if (parsed && parsed.path === path) {
          resolve(cursor.value as StoredMetadata);
          return;
        }
        cursor.continue();
      });
      req.addEventListener('error', () => reject(req.error));
    });
  }

  async putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void> {
    const b = bucket ?? metadata.bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    if (!metadata.bucket) metadata.bucket = b;
    const key = toStorageKey(b, path);
    const tx = this.db.transaction(METADATA_STORE, 'readwrite');
    tx.objectStore(METADATA_STORE).put(metadata, key);
    await awaitTransaction(tx);
  }

  async delete(path: string, bucket?: string): Promise<void> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const key = toStorageKey(targetBucket, path);
    const tx = this.db.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    tx.objectStore(BLOBS_STORE).delete(key);
    tx.objectStore(METADATA_STORE).delete(key);
    await awaitTransaction(tx);
  }

  async listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const tx = this.db.transaction(METADATA_STORE, 'readonly');
    const keyPrefix = `${targetBucket}/${prefix}`;
    const range = IDBKeyRange.bound(keyPrefix, keyPrefix + '\ufffd', false, false);
    return awaitRequest<StoredMetadata[]>(
      tx.objectStore(METADATA_STORE).getAll(range),
    );
  }

  async reset(bucket?: string): Promise<void> {
    const tx = this.db.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    if (!bucket) {
      tx.objectStore(BLOBS_STORE).clear();
      tx.objectStore(METADATA_STORE).clear();
      this._defaultBucket = undefined;
    } else {
      const bucketPrefix = `${bucket}/`;
      const range = IDBKeyRange.bound(bucketPrefix, bucketPrefix + '\ufffd', false, false);
      tx.objectStore(BLOBS_STORE).delete(range);
      tx.objectStore(METADATA_STORE).delete(range);
    }
    await awaitTransaction(tx);
  }

  async beginUpload(
    bucket: string | undefined,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): Promise<string> {
    const b = bucket || this._defaultBucket || DEFAULT_BUCKET;
    return this.staging.beginUpload(b, path, size, contentType, customMetadata);
  }

  async putPart(uploadId: string, partIndex: number, bytes: Uint8Array): Promise<{ bytesReceived: number }> {
    return this.staging.putPart(uploadId, partIndex, bytes);
  }

  async finishUpload(uploadId: string): Promise<StoredMetadata> {
    const { upload, fullBytes } = this.staging.finishUpload(uploadId);
    const now = new Date().toISOString();
    const generation = String(Date.now());
    const stored: StoredMetadata = {
      bucket: upload.bucket,
      fullPath: upload.path,
      name: upload.path.split('/').pop() ?? upload.path,
      size: upload.size,
      generation,
      metageneration: '1',
      timeCreated: now,
      updated: now,
      contentType: upload.contentType,
      customMetadata: upload.customMetadata,
    };
    const blob = new Blob([fullBytes as unknown as BlobPart], { type: upload.contentType });
    await this.put(upload.path, blob, stored);
    return stored;
  }

  async abortUpload(uploadId: string): Promise<void> {
    this.staging.abortUpload(uploadId);
  }

  async readRange(
    bucket: string | undefined,
    path: string,
    offset: number,
    length: number,
    expectedGeneration?: string,
  ): Promise<Uint8Array | undefined> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const meta = await this.getMetadata(path, targetBucket);
    if (!meta) return undefined;
    if (expectedGeneration !== undefined && meta.generation !== expectedGeneration) {
      const err = new Error('storage/object-changed: The object changed while reading. Re-read metadata and retry.') as Error & { code: string };
      err.code = 'storage/object-changed';
      throw err;
    }
    const blob = await this.getBlob(path, targetBucket);
    if (!blob) return undefined;
    const slice = blob.slice(offset, offset + length);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  }

  close(): void {
    this.db.close();
  }

  scoped(bucket: string): StorageBackend {
    return new ScopedStorageBackend(this, bucket);
  }
}

export class ScopedStorageBackend implements StorageBackend {
  constructor(
    private readonly underlying: StorageBackend,
    readonly bucket: string,
  ) {}

  put(path: string, blob: Blob, metadata: StoredMetadata): Promise<void> {
    const meta = metadata.bucket ? metadata : { ...metadata, bucket: this.bucket };
    return this.underlying.put(path, blob, meta);
  }

  getBlob(path: string, bucket?: string): Promise<Blob | undefined> {
    return this.underlying.getBlob(path, bucket ?? this.bucket);
  }

  getMetadata(path: string, bucket?: string): Promise<StoredMetadata | undefined> {
    return this.underlying.getMetadata(path, bucket ?? this.bucket);
  }

  putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void> {
    const meta = metadata.bucket ? metadata : { ...metadata, bucket: this.bucket };
    return this.underlying.putMetadata(path, meta, bucket ?? this.bucket);
  }

  delete(path: string, bucket?: string): Promise<void> {
    return this.underlying.delete(path, bucket ?? this.bucket);
  }

  listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]> {
    return this.underlying.listByPrefix(prefix, bucket ?? this.bucket);
  }

  reset(bucket?: string): Promise<void> {
    return this.underlying.reset(bucket ?? this.bucket);
  }

  beginUpload(
    bucket: string | undefined,
    path: string,
    size: number,
    contentType: string,
    customMetadata?: Record<string, string>,
  ): Promise<string> {
    const b = bucket ?? this.bucket;
    if (this.underlying.beginUpload) return this.underlying.beginUpload(b, path, size, contentType, customMetadata);
    throw new Error('Chunked upload not supported by underlying storage backend');
  }

  putPart(uploadId: string, partIndex: number, bytes: Uint8Array): Promise<{ bytesReceived: number } | void> {
    if (this.underlying.putPart) return this.underlying.putPart(uploadId, partIndex, bytes);
    throw new Error('Chunked upload not supported by underlying storage backend');
  }

  finishUpload(uploadId: string): Promise<StoredMetadata> {
    if (this.underlying.finishUpload) return this.underlying.finishUpload(uploadId);
    throw new Error('Chunked upload not supported by underlying storage backend');
  }

  abortUpload(uploadId: string): Promise<void> {
    if (this.underlying.abortUpload) return this.underlying.abortUpload(uploadId);
    return Promise.resolve();
  }

  readRange(
    bucket: string | undefined,
    path: string,
    offset: number,
    length: number,
    expectedGeneration?: string,
  ): Promise<Uint8Array | undefined> {
    const b = bucket ?? this.bucket;
    if (this.underlying.readRange) return this.underlying.readRange(b, path, offset, length, expectedGeneration);
    return Promise.resolve(undefined);
  }

  close(): void {
    this.underlying.close();
  }

  scoped(bucket: string): StorageBackend {
    if (bucket === this.bucket) return this;
    return this.underlying.scoped ? this.underlying.scoped(bucket) : new ScopedStorageBackend(this.underlying, bucket);
  }
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB.open) {
        return reject(new Error('IndexedDB not available'));
      }
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
    } catch (err) {
      reject(err);
    }
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
