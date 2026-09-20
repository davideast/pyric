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
      // The owning hosted database closes the shared connection after draining.
      close() {},
      scoped: view,
    };
  }
  return view();
}
