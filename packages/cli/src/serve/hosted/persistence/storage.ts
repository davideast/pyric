import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { FirebaseError } from 'pyric/app';
import { assertPriorAt, type StorageBackend, type StorageReferenceRecord, type StoredMetadata, type StoredObject } from 'pyric/storage/internal';
import { storedMetadataSchema } from 'pyric/sandbox/internal';
import { MAX_STORAGE_OBJECT_BYTES, storageQuotaExceeded } from '../../worker/protocol/storage.js';
import type { BlobStore, StagedFile, StoredBytes } from './blob-store.js';
import type { Commit } from './commits.js';
import { sqlText, type SqlConnection, type SqlRow } from './sqlite.js';

export type PutStorageBytes = (path: string, bytes: Uint8Array, mime: string, metadata: StoredMetadata) => void;

/** Store an object whose bytes are the file `source`, which must hash to `stored.sha256`. */
export type PutStorageFile = (path: string, source: string, stored: StoredBytes, mime: string, metadata: StoredMetadata) => void;

/** The writes a seed transaction can make. */
export interface StorageWrites {
  bytes: PutStorageBytes;
  file: PutStorageFile;
}

export interface ScopedStorageBackend extends StorageBackend {
  scoped(bucket: string): ScopedStorageBackend;
  /** Run a synchronous seed transaction after earlier Storage mutations. */
  mutate<T>(work: (writes: StorageWrites) => T): Promise<T>;
  beginUpload(bucket: string, path: string, size: number, mime?: string): Promise<string>;
  readUpload(uploadId: string): Promise<Blob>;
  abortUpload(uploadId: string): Promise<void>;
  references(bucket?: string): Promise<StorageReferenceRecord[]>;
  putReference(path: string, reference: StoredBytes, mime: string, metadata: StoredMetadata): Promise<void>;
  /** The file holding an object's bytes, with what a response needs to describe them. */
  objectFile(bucket: string, path: string): Promise<StoredObjectFile | undefined>;
  /** Append bytes that start at `offset`, which must be exactly what the upload has received. */
  appendUpload(uploadId: string, offset: number, bytes: Uint8Array): Promise<UploadProgress>;
  uploadProgress(uploadId: string): Promise<UploadProgress | undefined>;
}

export interface StoredObjectFile {
  file: string;
  size: number;
  mime: string;
  metadata: StoredMetadata;
}

export interface UploadProgress {
  received: number;
  size: number;
}

/** Bytes sent for an upload from an offset other than the one it has reached. */
export class UploadOffsetError extends Error {
  constructor(readonly received: number) {
    super(`The upload has received ${received} bytes; the next bytes must start there.`);
    this.name = 'UploadOffsetError';
  }
}

/** A statement prepared on first use; a read-only open of an older schema never needs it. */
function lazyStatement(connection: SqlConnection, sql: string): () => ReturnType<SqlConnection['prepare']> {
  let statement: ReturnType<SqlConnection['prepare']> | undefined;
  return () => {
    const unprepared = statement === undefined;
    if (unprepared) statement = connection.prepare(sql);
    return statement!;
  };
}

function metadataOf(row: SqlRow): StoredMetadata {
  return storedMetadataSchema.parse(JSON.parse(sqlText(row, 'metadata')));
}

function storedBytesOf(row: SqlRow): StoredBytes {
  return { sha256: sqlText(row, 'sha256'), size: Number(row.size) };
}

/**
 * A chunked upload in progress. It lives only as long as the host that began
 * it; a new host discards what an earlier one left staged.
 */
interface Upload {
  path: string;
  size: number;
  contentType: string;
  file: StagedFile;
}

/**
 * Metadata lives in a row that names the object's bytes by hash. The bytes are
 * durable in their file before the row that names them commits.
 */
export function createSqliteStorage(connection: SqlConnection, commit: Commit, objects: BlobStore): ScopedStorageBackend {
  const read = lazyStatement(connection, 'SELECT sha256, size, mime FROM storage_objects WHERE bucket=? AND path=?');
  const metadata = connection.prepare('SELECT metadata FROM storage_objects WHERE bucket=? AND path=?');
  const put = lazyStatement(connection, `INSERT INTO storage_objects (bucket, path, metadata, mime, sha256, size) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket, path) DO UPDATE SET metadata=excluded.metadata, mime=excluded.mime, sha256=excluded.sha256, size=excluded.size`);
  const update = connection.prepare('UPDATE storage_objects SET metadata=? WHERE bucket=? AND path=?');
  const remove = connection.prepare('DELETE FROM storage_objects WHERE bucket=? AND path=?');
  const list = connection.prepare('SELECT metadata FROM storage_objects WHERE bucket=? AND substr(path, 1, length(?))=? ORDER BY path');
  const clearBucket = connection.prepare('DELETE FROM storage_objects WHERE bucket=?');

  // Reserve order before binary conversion yields. Reset and later uploads must
  // not overtake a pending upload and then be undone when its bytes arrive.
  let mutations: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = mutations.then(work);
    mutations = result.catch(() => {});
    return result;
  }

  const uploads = new Map<string, Upload>();
  // The Blob `readUpload` returned for each finished upload. The engine hands
  // it back to `put`, which moves the staged file into place instead of reading it.
  const finishedUploads = new WeakMap<Blob, Upload>();

  function uploadOf(uploadId: string): Upload {
    const upload = uploads.get(uploadId);
    const missingUpload = upload === undefined;
    if (missingUpload) throw new FirebaseError('storage/object-not-found', `storage/object-not-found: Upload '${uploadId}' not found.`);
    return upload;
  }

  function adoptUpload(path: string, upload: Upload, mime: string, value: StoredMetadata): void {
    const metadata = storedMetadataSchema.parse(value);
    const mismatchedObject = metadata.fullPath !== path || metadata.size !== upload.size;
    if (mismatchedObject) throw new Error('Storage metadata does not match its object.');
    const stored = objects.adopt(upload.file);
    commit(() => { put().run(metadata.bucket, path, JSON.stringify(metadata), mime, stored.sha256, stored.size); });
  }

  function putBytes(path: string, bytes: Uint8Array, mime: string, value: StoredMetadata): void {
    const tooLarge = bytes.byteLength > MAX_STORAGE_OBJECT_BYTES;
    if (tooLarge) throw storageQuotaExceeded(bytes.byteLength, 'Storage object');
    const metadata = storedMetadataSchema.parse(value);
    const mismatchedObject = metadata.fullPath !== path || metadata.size !== bytes.byteLength;
    if (mismatchedObject) throw new Error('Storage metadata does not match its object.');
    const stored = objects.write(bytes);
    commit(() => { put().run(metadata.bucket, path, JSON.stringify(metadata), mime, stored.sha256, stored.size); });
  }

  function putFile(path: string, source: string, stored: StoredBytes, mime: string, value: StoredMetadata): void {
    const tooLarge = stored.size > MAX_STORAGE_OBJECT_BYTES;
    if (tooLarge) throw storageQuotaExceeded(stored.size, 'Storage object');
    const metadata = storedMetadataSchema.parse(value);
    const mismatchedObject = metadata.fullPath !== path || metadata.size !== stored.size;
    if (mismatchedObject) throw new Error('Storage metadata does not match its object.');
    objects.importFile(source, stored);
    commit(() => { put().run(metadata.bucket, path, JSON.stringify(metadata), mime, stored.sha256, stored.size); });
  }

  const writes: StorageWrites = { bytes: putBytes, file: putFile };
  const referencesStmt = lazyStatement(connection, 'SELECT sha256, size, mime, metadata FROM storage_objects WHERE bucket=? ORDER BY path');
  const objectFileStmt = lazyStatement(connection, 'SELECT sha256, size, mime, metadata FROM storage_objects WHERE bucket=? AND path=?');

  // The bytes behind each replaced object `put` returned, so putting it back
  // writes only its row while its file is still held.
  const replacedBytes = new WeakMap<Blob, StoredBytes>();

  /**
   * The object at a path as one row, read inside a queued mutation. A row
   * whose file is gone has no object to give back, so an overwrite repairs it.
   */
  async function objectAt(bucket: string, path: string): Promise<StoredObject | undefined> {
    const row = objectFileStmt().get(bucket, path);
    const missingObject = row === undefined;
    if (missingObject) return undefined;
    const stored = storedBytesOf(row);
    const missingFile = objects.size(stored.sha256) !== stored.size;
    if (missingFile) return undefined;
    const blob = await openAsBlob(objects.path(stored.sha256), { type: sqlText(row, 'mime') });
    replacedBytes.set(blob, stored);
    return { blob, metadata: metadataOf(row) };
  }

  function currentGeneration(bucket: string, path: string): string | undefined {
    const row = metadata.get(bucket, path);
    const missingObject = row === undefined;
    if (missingObject) return undefined;
    return metadataOf(row).generation;
  }

  /** Put `prior` back at its path, by reference when this store still holds its bytes. */
  async function restoreObject(path: string, prior: StoredObject): Promise<void> {
    const stored = replacedBytes.get(prior.blob);
    const unheld = stored === undefined || objects.size(stored.sha256) !== stored.size;
    if (unheld) {
      const fromThisStore = stored !== undefined;
      if (fromThisStore) throw new Error(`The bytes of the prior Storage object at '${path}' are no longer held.`);
      putBytes(path, new Uint8Array(await prior.blob.arrayBuffer()), prior.blob.type, prior.metadata);
      return;
    }
    const value = storedMetadataSchema.parse(prior.metadata);
    const mismatchedObject = value.fullPath !== path || value.size !== stored.size;
    if (mismatchedObject) throw new Error('Storage metadata does not match its object.');
    commit(() => { put().run(value.bucket, path, JSON.stringify(value), prior.blob.type, stored.sha256, stored.size); });
  }

  function view(scope?: string): ScopedStorageBackend {
    const defaultBucket = scope ?? 'pyric-default';
    return {
      async put(path, blob, value) {
        const tooLarge = blob.size > MAX_STORAGE_OBJECT_BYTES;
        if (tooLarge) throw storageQuotaExceeded(blob.size, 'Storage object');
        const upload = finishedUploads.get(blob);
        const finishesUpload = upload !== undefined;
        const bucket = value.bucket || defaultBucket;
        if (finishesUpload) {
          return enqueue(async () => {
            const replaced = await objectAt(bucket, path);
            adoptUpload(path, upload, blob.type, value);
            return replaced;
          });
        }
        return enqueue(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const replaced = await objectAt(bucket, path);
          putBytes(path, bytes, blob.type, value);
          return replaced;
        });
      },
      async deleteIfGeneration(path, generation, bucket = defaultBucket) {
        return enqueue(() => {
          const replaced = currentGeneration(bucket, path) !== generation;
          if (replaced) return false;
          commit(() => { remove.run(bucket, path); });
          return true;
        });
      },
      async replaceIfGeneration(path, generation, prior, bucket = defaultBucket) {
        // Every Storage mutation runs through this queue, so nothing lands
        // between the check and the write.
        if (prior !== undefined) assertPriorAt(prior, bucket, path);
        return enqueue(async () => {
          const replaced = currentGeneration(bucket, path) !== generation;
          if (replaced) return false;
          if (prior === undefined) {
            commit(() => { remove.run(bucket, path); });
            return true;
          }
          await restoreObject(path, prior);
          return true;
        });
      },
      mutate: work => enqueue(() => commit(() => work(writes))),
      async getBlob(path, bucket = defaultBucket) {
        await mutations;
        const row = read().get(bucket, path);
        const missingObject = row === undefined;
        if (missingObject) return undefined;
        return new Blob([objects.read(storedBytesOf(row))], { type: sqlText(row, 'mime') });
      },
      async getMetadata(path, bucket = defaultBucket) {
        await mutations;
        const row = metadata.get(bucket, path);
        const hasObject = row !== undefined;
        if (hasObject) return metadataOf(row);
        return undefined;
      },
      async getObject(path, bucket = defaultBucket) {
        await mutations;
        // One row names both the metadata and the bytes of the same write.
        const row = objectFileStmt().get(bucket, path);
        const missingObject = row === undefined;
        if (missingObject) return undefined;
        const blob = new Blob([objects.read(storedBytesOf(row))], { type: sqlText(row, 'mime') });
        return { blob, metadata: metadataOf(row) };
      },
      async putMetadata(path, value, bucket = defaultBucket) {
        await enqueue(() => {
          const parsed = storedMetadataSchema.parse(value);
          const previous = metadata.get(bucket, path);
          const missingObject = previous === undefined;
          if (missingObject) return;
          const current = metadataOf(previous);
          const staleObject = parsed.generation !== current.generation;
          const staleMetadata = Number(parsed.metageneration) !== Number(current.metageneration) + 1;
          const changedSinceRead = staleObject || staleMetadata;
          if (changedSinceRead) throw new FirebaseError('storage/retry-limit-exceeded', 'The object changed while updating metadata. Read its metadata and retry.');
          const mismatchedObject = parsed.bucket !== bucket || parsed.fullPath !== path || parsed.size !== current.size;
          if (mismatchedObject) throw new Error('Storage metadata cannot change object identity or size.');
          commit(() => { update.run(JSON.stringify(parsed), bucket, path); });
        });
      },
      async delete(path, bucket = defaultBucket) {
        await enqueue(() => commit(() => { remove.run(bucket, path); }));
      },
      async listByPrefix(prefix, bucket = defaultBucket) {
        await mutations;
        return list.all(bucket, prefix, prefix).map(metadataOf);
      },
      async reset(bucket = scope) {
        await enqueue(() => commit(() => {
          const allBuckets = bucket === undefined;
          if (allBuckets) connection.exec('DELETE FROM storage_objects');
          else clearBucket.run(bucket);
        }));
      },
      // The object's bucket comes from the metadata the engine writes it with.
      async beginUpload(_bucket: string, path: string, size: number, mime?: string): Promise<string> {
        return enqueue(() => {
          const uploadId = randomUUID();
          const file = objects.stage(uploadId);
          uploads.set(uploadId, { path, size, contentType: mime ?? 'application/octet-stream', file });
          return uploadId;
        });
      },
      async readUpload(uploadId: string): Promise<Blob> {
        return enqueue(async () => {
          const upload = uploadOf(uploadId);
          const received = upload.file.received;
          const incomplete = received !== upload.size;
          if (incomplete) {
            throw new FirebaseError(
              'storage/invalid-argument',
              `storage/invalid-argument: Uploaded bytes (${received}) did not match declared size (${upload.size}).`,
            );
          }
          upload.file.seal();
          const blob = await openAsBlob(upload.file.path, { type: upload.contentType });
          finishedUploads.set(blob, upload);
          return blob;
        });
      },
      async abortUpload(uploadId: string): Promise<void> {
        return enqueue(() => {
          const upload = uploads.get(uploadId);
          uploads.delete(uploadId);
          upload?.file.discard();
        });
      },
      async objectFile(bucket, path) {
        await mutations;
        const row = objectFileStmt().get(bucket, path);
        const missingObject = row === undefined;
        if (missingObject) return undefined;
        const stored = storedBytesOf(row);
        return { file: objects.path(stored.sha256), size: stored.size, mime: sqlText(row, 'mime'), metadata: metadataOf(row) };
      },
      async appendUpload(uploadId, offset, bytes) {
        return enqueue(() => {
          const upload = uploadOf(uploadId);
          const received = upload.file.received;
          const misplaced = offset !== received;
          if (misplaced) throw new UploadOffsetError(received);
          const overflows = received + bytes.byteLength > upload.size;
          if (overflows) throw new FirebaseError('storage/invalid-argument', `Upload '${uploadId}' would pass its declared size of ${upload.size} bytes.`);
          upload.file.append(bytes);
          return { received: upload.file.received, size: upload.size };
        });
      },
      async uploadProgress(uploadId) {
        await mutations;
        const upload = uploads.get(uploadId);
        const missingUpload = upload === undefined;
        if (missingUpload) return undefined;
        return { received: upload.file.received, size: upload.size };
      },
      async references(bucket = defaultBucket) {
        await mutations;
        return referencesStmt().all(bucket).map(row => ({ ...storedBytesOf(row), blobType: sqlText(row, 'mime'), metadata: metadataOf(row) }));
      },
      async putReference(path, reference, mime, value) {
        await enqueue(() => {
          const metadata = storedMetadataSchema.parse(value);
          const mismatchedObject = metadata.fullPath !== path || metadata.size !== reference.size;
          if (mismatchedObject) throw new Error('Storage metadata does not match its object.');
          // Only a row is written; its file must already hold the bytes.
          const held = objects.size(reference.sha256) === reference.size;
          const missing = !held;
          if (missing) throw new Error(`Storage object '${path}' names bytes this store does not hold.`);
          commit(() => { put().run(metadata.bucket, path, JSON.stringify(metadata), mime, reference.sha256, reference.size); });
        });
      },
      // The owning hosted database closes the shared connection after draining.
      close() {},
      scoped: view,
    };
  }
  return view();
}
