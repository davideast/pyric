import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { FirebaseError } from 'pyric/app';
import type { StorageBackend, StorageReferenceRecord, StoredMetadata } from 'pyric/storage/internal';
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
  putPart(uploadId: string, index: number, part: Uint8Array): Promise<{ bytesReceived: number }>;
  readUpload(uploadId: string): Promise<Blob>;
  abortUpload(uploadId: string): Promise<void>;
  readRange(bucket: string, path: string, offset: number, length: number, expectedGeneration?: string): Promise<Uint8Array | undefined>;
  references(bucket?: string): Promise<StorageReferenceRecord[]>;
  putReference(path: string, reference: StoredBytes, mime: string, metadata: StoredMetadata): Promise<void>;
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
  nextIndex: number;
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

  const readRangeStmt = lazyStatement(connection, 'SELECT sha256, size, metadata FROM storage_objects WHERE bucket=? AND path=?');

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
    if (missingUpload) throw new Error(`Upload '${uploadId}' not found or already completed.`);
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

  function view(scope?: string): ScopedStorageBackend {
    const defaultBucket = scope ?? 'pyric-default';
    return {
      async put(path, blob, value) {
        const tooLarge = blob.size > MAX_STORAGE_OBJECT_BYTES;
        if (tooLarge) throw storageQuotaExceeded(blob.size, 'Storage object');
        const upload = finishedUploads.get(blob);
        const finishesUpload = upload !== undefined;
        if (finishesUpload) {
          await enqueue(() => adoptUpload(path, upload, blob.type, value));
          return;
        }
        await enqueue(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          putBytes(path, bytes, blob.type, value);
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
          uploads.set(uploadId, { path, size, contentType: mime ?? 'application/octet-stream', file, nextIndex: 0 });
          return uploadId;
        });
      },
      async putPart(uploadId: string, index: number, part: Uint8Array): Promise<{ bytesReceived: number }> {
        return enqueue(() => {
          const upload = uploadOf(uploadId);
          // Parts append to one file and one running hash, so each must be the next.
          const outOfOrder = index !== upload.nextIndex;
          if (outOfOrder) throw new Error(`Part ${index} of upload '${uploadId}' arrived out of order; part ${upload.nextIndex} is next.`);
          const overflows = upload.file.received + part.byteLength > upload.size;
          if (overflows) throw new Error(`Part ${index} of upload '${uploadId}' would pass its declared size of ${upload.size} bytes.`);
          upload.file.append(part);
          upload.nextIndex++;
          return { bytesReceived: upload.file.received };
        });
      },
      async readUpload(uploadId: string): Promise<Blob> {
        return enqueue(async () => {
          const upload = uploadOf(uploadId);
          const received = upload.file.received;
          const incomplete = received !== upload.size;
          if (incomplete) throw new Error(`Staged bytes (${received}) do not match declared size (${upload.size}).`);
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
      async readRange(bucket = defaultBucket, path: string, offset: number, length: number, expectedGeneration?: string): Promise<Uint8Array | undefined> {
        await mutations;
        const row = readRangeStmt().get(bucket, path);
        if (row === undefined) return undefined;
        const meta = metadataOf(row);
        if (expectedGeneration !== undefined && meta.generation !== expectedGeneration) {
          throw new FirebaseError('storage/object-changed', 'The object changed while reading. Re-read metadata and retry.');
        }
        return objects.readRange(storedBytesOf(row), offset, length);
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
