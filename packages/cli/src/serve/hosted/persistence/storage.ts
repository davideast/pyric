import { randomUUID } from 'node:crypto';
import { FirebaseError } from 'pyric/app';
import type { StorageBackend, StoredMetadata } from 'pyric/storage/internal';
import { storedMetadataSchema } from 'pyric/sandbox/internal';
import { MAX_STORAGE_OP_BYTES, storagePayloadTooLarge } from '../../worker/protocol/storage.js';
import type { Commit } from './commits.js';
import { sqlText, type SqlConnection, type SqlRow } from './sqlite.js';

export type PutStorageBytes = (path: string, bytes: Uint8Array, mime: string, metadata: StoredMetadata) => void;

export interface ScopedStorageBackend extends StorageBackend {
  scoped(bucket: string): ScopedStorageBackend;
  /** Run a synchronous seed transaction after earlier Storage mutations. */
  mutate<T>(work: (putBytes: PutStorageBytes) => T): Promise<T>;
  beginUpload(bucket: string, path: string, size: number, mime?: string, customMetadata?: Record<string, string>, connectionId?: string): Promise<string>;
  putPart(uploadId: string, index: number, part: Uint8Array): Promise<{ bytesReceived: number }>;
  finishUpload(uploadId: string): Promise<StoredMetadata>;
  abortUpload(uploadId: string): Promise<void>;
  readRange(bucket: string, path: string, offset: number, length: number, expectedGeneration?: string): Promise<Uint8Array | undefined>;
}

function metadataOf(row: SqlRow): StoredMetadata {
  return storedMetadataSchema.parse(JSON.parse(sqlText(row, 'metadata')));
}

/** Bytes and metadata share a row and a transaction, including replacements. */
export function createSqliteStorage(connection: SqlConnection, commit: Commit): ScopedStorageBackend {
  const read = connection.prepare('SELECT bytes, mime FROM storage_objects WHERE bucket=? AND path=?');
  const metadata = connection.prepare('SELECT metadata FROM storage_objects WHERE bucket=? AND path=?');
  const put = connection.prepare('INSERT INTO storage_objects VALUES (?, ?, ?, ?, ?) ON CONFLICT(bucket, path) DO UPDATE SET metadata=excluded.metadata, mime=excluded.mime, bytes=excluded.bytes');
  const update = connection.prepare('UPDATE storage_objects SET metadata=? WHERE bucket=? AND path=?');
  const remove = connection.prepare('DELETE FROM storage_objects WHERE bucket=? AND path=?');
  const list = connection.prepare('SELECT metadata FROM storage_objects WHERE bucket=? AND substr(path, 1, length(?))=? ORDER BY path');
  const clearBucket = connection.prepare('DELETE FROM storage_objects WHERE bucket=?');

  // ADR 0015 Chunked storage staging and ranged reads
  const beginUploadStmt = connection.prepare('INSERT INTO storage_uploads VALUES (?, ?, ?, ?, ?, ?, ?, -1, ?, ?)');
  const readHeaderStmt = connection.prepare('SELECT * FROM storage_uploads WHERE upload_id=? AND part_index=-1');
  const insertPartStmt = connection.prepare('INSERT INTO storage_uploads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(upload_id, part_index) DO UPDATE SET bytes=excluded.bytes');
  const readPartsStmt = connection.prepare('SELECT bytes FROM storage_uploads WHERE upload_id=? AND part_index >= 0 ORDER BY part_index');
  const sumPartsStmt = connection.prepare('SELECT COALESCE(SUM(length(bytes)), 0) AS bytesReceived FROM storage_uploads WHERE upload_id=? AND part_index >= 0');
  const deleteUploadStmt = connection.prepare('DELETE FROM storage_uploads WHERE upload_id=?');
  const readRangeStmt = connection.prepare('SELECT substr(bytes, ? + 1, ?) AS slice, metadata FROM storage_objects WHERE bucket=? AND path=?');

  // Reserve order before binary conversion yields. Reset and later uploads must
  // not overtake a pending upload and then be undone when its bytes arrive.
  let mutations: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = mutations.then(work);
    mutations = result.catch(() => {});
    return result;
  }

  function putBytes(path: string, bytes: Uint8Array, mime: string, value: StoredMetadata): void {
    const tooLarge = bytes.byteLength > MAX_STORAGE_OP_BYTES;
    if (tooLarge) throw storagePayloadTooLarge(bytes.byteLength, 'Storage object');
    const metadata = storedMetadataSchema.parse(value);
    const mismatchedObject = metadata.fullPath !== path || metadata.size !== bytes.byteLength;
    if (mismatchedObject) throw new Error('Storage metadata does not match its object.');
    commit(() => { put.run(metadata.bucket, path, JSON.stringify(metadata), mime, bytes); });
  }

  function view(scope?: string): ScopedStorageBackend {
    const defaultBucket = scope ?? 'pyric-default';
    return {
      async put(path, blob, value) {
        const tooLarge = blob.size > MAX_STORAGE_OP_BYTES;
        if (tooLarge) throw storagePayloadTooLarge(blob.size, 'Storage object');
        await enqueue(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          putBytes(path, bytes, blob.type, value);
        });
      },
      mutate: work => enqueue(() => commit(() => work(putBytes))),
      async getBlob(path, bucket = defaultBucket) {
        await mutations;
        const row = read.get(bucket, path);
        const missingObject = row === undefined;
        if (missingObject) return undefined;
        const bytes = row.bytes;
        const isBinary = bytes instanceof Uint8Array;
        const invalidBytes = !isBinary;
        if (invalidBytes) throw new Error('Invalid persisted Storage bytes.');
        return new Blob([Uint8Array.from(bytes)], { type: sqlText(row, 'mime') });
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
      async beginUpload(bucket = defaultBucket, path: string, size: number, mime?: string, customMetadata?: Record<string, string>, connectionId?: string): Promise<string> {
        return enqueue(() => {
          const uploadId = randomUUID();
          const contentType = mime ?? 'application/octet-stream';
          const metaJson = customMetadata ? JSON.stringify(customMetadata) : null;
          commit(() => {
            beginUploadStmt.run(uploadId, connectionId ?? null, bucket, path, size, contentType, metaJson, new Uint8Array(0), Date.now());
          });
          return uploadId;
        });
      },
      async putPart(uploadId: string, index: number, part: Uint8Array): Promise<{ bytesReceived: number }> {
        return enqueue(() => {
          const header = readHeaderStmt.get(uploadId);
          if (header === undefined) throw new Error(`Upload '${uploadId}' not found or already completed.`);
          commit(() => {
            insertPartStmt.run(
              uploadId,
              header.connection_id,
              header.bucket,
              header.path,
              header.size,
              header.content_type,
              header.custom_metadata,
              index,
              part,
              Date.now(),
            );
          });
          const sumRow = sumPartsStmt.get(uploadId);
          const bytesReceived = Number(sumRow?.bytesReceived ?? 0);
          return { bytesReceived };
        });
      },
      async finishUpload(uploadId: string): Promise<StoredMetadata> {
        return enqueue(() => {
          const header = readHeaderStmt.get(uploadId);
          if (header === undefined) throw new Error(`Upload '${uploadId}' not found or already completed.`);
          const bucket = sqlText(header, 'bucket');
          const path = sqlText(header, 'path');
          const declaredSize = Number(header.size);
          const parts = readPartsStmt.all(uploadId);
          const totalLength = parts.reduce((sum, p) => sum + (p.bytes instanceof Uint8Array ? p.bytes.byteLength : 0), 0);
          if (totalLength !== declaredSize) {
            throw new Error(`Staged bytes (${totalLength}) do not match declared size (${declaredSize}).`);
          }
          const fullBytes = new Uint8Array(declaredSize);
          let offset = 0;
          for (const partRow of parts) {
            if (partRow.bytes instanceof Uint8Array) {
              fullBytes.set(partRow.bytes, offset);
              offset += partRow.bytes.byteLength;
            }
          }
          const previous = metadata.get(bucket, path);
          const hasPrevious = previous !== undefined;
          const current = hasPrevious ? metadataOf(previous) : null;
          const generation = current !== null ? String(Number(current.generation) + 1) : String(Date.now());
          const timeCreated = current !== null ? current.timeCreated : new Date().toISOString();
          const updated = new Date().toISOString();
          const contentType = sqlText(header, 'content_type');
          const customMetaRaw = header.custom_metadata ? sqlText(header, 'custom_metadata') : null;
          const customMetadata = customMetaRaw ? JSON.parse(customMetaRaw) : undefined;
          const name = path.split('/').pop() ?? path;
          const stored: StoredMetadata = {
            bucket,
            fullPath: path,
            name,
            size: declaredSize,
            generation,
            metageneration: '1',
            timeCreated,
            updated,
            contentType,
            customMetadata,
          };
          const validated = storedMetadataSchema.parse(stored);
          commit(() => {
            put.run(bucket, path, JSON.stringify(validated), contentType, fullBytes);
            deleteUploadStmt.run(uploadId);
          });
          return validated;
        });
      },
      async abortUpload(uploadId: string): Promise<void> {
        return enqueue(() => {
          commit(() => {
            deleteUploadStmt.run(uploadId);
          });
        });
      },
      async readRange(bucket = defaultBucket, path: string, offset: number, length: number, expectedGeneration?: string): Promise<Uint8Array | undefined> {
        await mutations;
        const row = readRangeStmt.get(offset, length, bucket, path);
        if (row === undefined) return undefined;
        const meta = metadataOf(row);
        if (expectedGeneration !== undefined && meta.generation !== expectedGeneration) {
          throw new FirebaseError('storage/object-changed', 'The object changed while reading. Re-read metadata and retry.');
        }
        const slice = row.slice;
        if (!(slice instanceof Uint8Array)) throw new Error('Invalid ranged slice bytes.');
        return Uint8Array.from(slice);
      },
      // The owning hosted database closes the shared connection after draining.
      close() {},
      scoped: view,
    };
  }
  return view();
}
