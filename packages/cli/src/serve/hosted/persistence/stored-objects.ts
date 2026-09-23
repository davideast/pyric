import type { BlobStore } from './blob-store.js';
import { sqlText, type SqlConnection } from './sqlite.js';

/** The first schema version that keeps object bytes in files rather than a column. */
export const FILE_BYTES_SCHEMA_VERSION = 3;

/** One `storage_objects` row, whichever schema wrote it. */
export interface StoredObjectRow {
  bucket: string;
  path: string;
  metadata: string;
  mime: string;
  /** The number of bytes stored: the column's length, or the size a file row records. */
  size: number;
  /** The file holding the bytes; absent while bytes are inline. */
  sha256?: string;
}

/** Storage rows and their bytes, read the way the store's schema version keeps them. */
export interface StoredObjects {
  rows(): StoredObjectRow[];
  totalSize(): number;
  bytes(row: StoredObjectRow): Uint8Array<ArrayBuffer>;
}

export function storedObjects(connection: SqlConnection, objects: BlobStore, version: number): StoredObjects {
  const inline = version < FILE_BYTES_SCHEMA_VERSION;
  if (inline) {
    return {
      rows: () => connection.prepare('SELECT bucket, path, metadata, mime, length(bytes) AS size FROM storage_objects ORDER BY bucket, path').all().map(row => ({
        bucket: sqlText(row, 'bucket'), path: sqlText(row, 'path'), metadata: sqlText(row, 'metadata'), mime: sqlText(row, 'mime'), size: Number(row.size),
      })),
      // length() comes from the row header, so this total reads no object bytes.
      totalSize: () => Number(connection.prepare('SELECT COALESCE(SUM(length(bytes)), 0) AS total FROM storage_objects').get()?.total ?? 0),
      bytes(row) {
        const found = connection.prepare('SELECT bytes FROM storage_objects WHERE bucket=? AND path=?').get(row.bucket, row.path);
        const bytes = found?.bytes;
        const binary = bytes instanceof Uint8Array;
        if (!binary) throw new Error('Invalid persisted Storage bytes.');
        // node:sqlite returns each blob in an ArrayBuffer of its own; copying it would double a large object.
        return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
      },
    };
  }
  return {
    rows: () => connection.prepare('SELECT bucket, path, metadata, mime, sha256, size FROM storage_objects ORDER BY bucket, path').all().map(row => ({
      bucket: sqlText(row, 'bucket'), path: sqlText(row, 'path'), metadata: sqlText(row, 'metadata'), mime: sqlText(row, 'mime'),
      size: Number(row.size), sha256: sqlText(row, 'sha256'),
    })),
    totalSize: () => Number(connection.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM storage_objects').get()?.total ?? 0),
    bytes(row) {
      const sha256 = row.sha256;
      const inlineRow = sha256 === undefined;
      if (inlineRow) throw new Error('Persisted Storage object names no file.');
      return objects.read({ sha256, size: row.size });
    },
  };
}
