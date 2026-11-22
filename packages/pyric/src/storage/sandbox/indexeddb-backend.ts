/**
 * IndexedDB-backed StorageBackend implementation for browser and fake-indexeddb runtimes.
 */

import { computeStorageEtag } from '../digests.js';
import { higherGeneration, raisedMark, type GenerationIssuer } from '../generation.js';
import { prefixKeyRange } from '../idb-prefix-range.js';
import {
  DEFAULT_BUCKET,
  assertMatchingSize,
  assertPriorAt,
  parseStorageKey,
  toStorageKey,
  warnNotPersisting,
  type StorageBackend,
  type StoredMetadata,
  type StoredObject,
} from '../persistence.js';
import { ScopedStorageBackend } from './scoped-backend.js';
import { InMemoryUploadStaging } from './upload-staging.js';

/**
 * Schema version. Bump and add an `upgradeneeded` branch when the
 * store layout changes. Version 2 adds the `generations` store.
 */
const SCHEMA_VERSION = 2;
const BLOBS_STORE = 'blobs';
const METADATA_STORE = 'metadata';
/**
 * Each path's high-water mark: the highest generation ever stored there. A
 * delete or a reset leaves it, so no later write repeats a generation.
 */
const GENERATIONS_STORE = 'generations';

export class IndexedDbStorageBackend implements StorageBackend {
  private readonly staging = new InMemoryUploadStaging();
  private _defaultBucket: string | undefined;

  /** Why this tab's connection closed, once a newer schema took the store over. */
  private closedReason: string | undefined;

  constructor(
    private readonly db: IDBDatabase,
    defaultBucket?: string,
  ) {
    this._defaultBucket = defaultBucket;
    // Let a newer schema version open: this connection steps aside, and every
    // later operation says why instead of failing with InvalidStateError.
    db.addEventListener('versionchange', () => {
      db.close();
      this.closedReason = 'a newer pyric build opened it in another tab';
      warnNotPersisting(db.name, this.closedReason, 'this tab reloads');
    });
  }

  private transaction(stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
    const closed = this.closedReason !== undefined;
    if (closed) {
      throw new Error(
        `The IndexedDB store "${this.db.name}" closed because ${this.closedReason}. Reload this tab to use Storage.`,
      );
    }
    return this.db.transaction(stores, mode);
  }

  async put(path: string, blob: Blob, metadata: StoredMetadata, issue?: GenerationIssuer): Promise<StoredObject | undefined> {
    const bucket = metadata.bucket || this._defaultBucket || DEFAULT_BUCKET;
    if (!this._defaultBucket) {
      this._defaultBucket = bucket;
    }
    assertMatchingSize(blob, metadata);
    if (!metadata.bucket) {
      metadata.bucket = bucket;
    }
    const key = toStorageKey(bucket, path);
    const tx = this.transaction([BLOBS_STORE, METADATA_STORE, GENERATIONS_STORE], 'readwrite');
    // Requests in one transaction run in order, so the reads see the object
    // the writes replace. The writes are issued from the mark's success event,
    // while the transaction is still active, so no other write lands between.
    const replaced = readObject(tx, key);
    const markRequest = tx.objectStore(GENERATIONS_STORE).get(key);
    // An issuer that throws, or a value the store cannot clone, aborts the
    // transaction; the write rejects with that error, not the abort's.
    let failure: { error: unknown } | undefined;
    markRequest.addEventListener('success', () => {
      const mark = markRequest.result as string | undefined;
      try {
        if (issue !== undefined) {
          metadata.generation = issue(higherGeneration(replaced.object()?.metadata.generation, mark));
          metadata.etag = computeStorageEtag(metadata.generation, metadata.metageneration);
        } else if (metadata.etag === undefined) {
          metadata.etag = computeStorageEtag(metadata.generation, metadata.metageneration);
        }
        tx.objectStore(BLOBS_STORE).put(blob, key);
        tx.objectStore(METADATA_STORE).put(metadata, key);
        tx.objectStore(GENERATIONS_STORE).put(raisedMark(mark, metadata.generation), key);
      } catch (error) {
        failure = { error };
        tx.abort();
      }
    });
    try {
      await awaitTransaction(tx);
    } catch (error) {
      if (failure !== undefined) throw failure.error;
      throw error;
    }
    return replaced.object();
  }

  async deleteIfGeneration(path: string, generation: string, bucket?: string): Promise<boolean> {
    return this.replaceIfGeneration(path, generation, undefined, bucket);
  }

  async replaceIfGeneration(path: string, generation: string, prior: StoredObject | undefined, bucket?: string): Promise<boolean> {
    const target = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    if (prior !== undefined) assertPriorAt(prior, target, path);
    const key = toStorageKey(target, path);
    const tx = this.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    let wrote = false;
    // The write is issued from the read's success event, while the
    // transaction is still active, so no other write can land between them.
    const request = tx.objectStore(METADATA_STORE).get(key);
    request.addEventListener('success', () => {
      const current = request.result as StoredMetadata | undefined;
      const replaced = current?.generation !== generation;
      if (replaced) return;
      wrote = true;
      if (prior === undefined) {
        tx.objectStore(BLOBS_STORE).delete(key);
        tx.objectStore(METADATA_STORE).delete(key);
        return;
      }
      tx.objectStore(BLOBS_STORE).put(prior.blob, key);
      tx.objectStore(METADATA_STORE).put(prior.metadata, key);
    });
    await awaitTransaction(tx);
    return wrote;
  }

  async getBlob(path: string, bucket?: string): Promise<Blob | undefined> {
    const tx = this.transaction(BLOBS_STORE, 'readonly');
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
    const tx = this.transaction(METADATA_STORE, 'readonly');
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

  async getObject(path: string, bucket?: string): Promise<StoredObject | undefined> {
    const key = toStorageKey(bucket ?? this._defaultBucket ?? DEFAULT_BUCKET, path);
    // One transaction over both stores reads both halves of the same write.
    const tx = this.transaction([BLOBS_STORE, METADATA_STORE], 'readonly');
    const [blob, metadata] = await Promise.all([
      awaitRequest<Blob | undefined>(tx.objectStore(BLOBS_STORE).get(key)),
      awaitRequest<StoredMetadata | undefined>(tx.objectStore(METADATA_STORE).get(key)),
    ]);
    const missingObject = blob === undefined || metadata === undefined;
    if (missingObject) return undefined;
    return { blob, metadata };
  }

  async putMetadata(path: string, metadata: StoredMetadata, bucket?: string): Promise<void> {
    const b = bucket ?? metadata.bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    if (!metadata.bucket) metadata.bucket = b;
    const key = toStorageKey(b, path);
    const tx = this.transaction(METADATA_STORE, 'readwrite');
    tx.objectStore(METADATA_STORE).put(metadata, key);
    await awaitTransaction(tx);
  }

  async delete(path: string, bucket?: string): Promise<void> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const key = toStorageKey(targetBucket, path);
    const tx = this.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    tx.objectStore(BLOBS_STORE).delete(key);
    tx.objectStore(METADATA_STORE).delete(key);
    await awaitTransaction(tx);
  }

  async listByPrefix(prefix: string, bucket?: string): Promise<StoredMetadata[]> {
    const targetBucket = bucket ?? this._defaultBucket ?? DEFAULT_BUCKET;
    const tx = this.transaction(METADATA_STORE, 'readonly');
    const keyPrefix = `${targetBucket}/${prefix}`;
    const range = prefixKeyRange(keyPrefix);
    return awaitRequest<StoredMetadata[]>(
      tx.objectStore(METADATA_STORE).getAll(range),
    );
  }

  async reset(bucket?: string): Promise<void> {
    const tx = this.transaction([BLOBS_STORE, METADATA_STORE], 'readwrite');
    if (!bucket) {
      tx.objectStore(BLOBS_STORE).clear();
      tx.objectStore(METADATA_STORE).clear();
      this._defaultBucket = undefined;
    } else {
      const range = prefixKeyRange(`${bucket}/`);
      if (range !== undefined) {
        tx.objectStore(BLOBS_STORE).delete(range);
        tx.objectStore(METADATA_STORE).delete(range);
      }
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

  async readUpload(uploadId: string): Promise<Blob> {
    return this.staging.readUpload(uploadId);
  }

  async abortUpload(uploadId: string): Promise<void> {
    this.staging.abortUpload(uploadId);
  }

  close(): void {
    this.db.close();
  }

  scoped(bucket: string): StorageBackend {
    return new ScopedStorageBackend(this, bucket);
  }
}

export function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB.open) {
        reject(new Error('IndexedDB not available'));
        return;
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
        // Version 1 to 2: an empty store of marks. A path with no mark falls
        // back to its stored generation.
        if (!db.objectStoreNames.contains(GENERATIONS_STORE)) {
          db.createObjectStore(GENERATIONS_STORE);
        }
      });
      let blocked = false;
      req.addEventListener('success', () => {
        // An open that was blocked has already fallen back; once the older
        // tab lets go, the late connection is not used.
        if (blocked) {
          req.result.close();
          return;
        }
        resolve(req.result);
      });
      req.addEventListener('error', () => reject(req.error));
      req.addEventListener('blocked', () => {
        blocked = true;
        const blockedError = new Error('another tab holds it open on an older pyric build');
        blockedError.name = 'OpenBlockedError';
        reject(blockedError);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/** Read both halves of the object at `key` inside `tx`; `object()` is valid once `tx` completes. */
function readObject(tx: IDBTransaction, key: string): { object(): StoredObject | undefined } {
  const blob = tx.objectStore(BLOBS_STORE).get(key);
  const metadata = tx.objectStore(METADATA_STORE).get(key);
  return {
    object() {
      const found = blob.result as Blob | undefined;
      const stored = metadata.result as StoredMetadata | undefined;
      const missingObject = found === undefined || stored === undefined;
      if (missingObject) return undefined;
      return { blob: found, metadata: stored };
    },
  };
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
