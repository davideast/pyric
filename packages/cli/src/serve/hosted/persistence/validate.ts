import { bundleRecords } from 'pyric/sandbox';
import { decodeImportBundle, storedMetadataSchema, validatePersistedService } from 'pyric/sandbox/internal';
import { createHash } from 'node:crypto';
import type { StoredMetadata } from 'pyric/storage/internal';
import type { openHostedDatabase } from './database.js';
import { storedObjects, type StoredObjectRow, type StoredObjects } from './stored-objects.js';
import { MAX_STORAGE_OBJECT_BYTES } from '../../worker/protocol/storage.js';

/** One Storage object whose recorded size disagreed with its stored bytes. */
export interface StorageMetadataRepair {
  bucket: string;
  path: string;
  recordedSize: number;
  actualSize: number;
}

/** The bytes are the object; the fields derived from them follow the bytes. */
export function repairedStorageMetadata(metadata: StoredMetadata, bytes: Uint8Array): StoredMetadata {
  const repaired: StoredMetadata = { ...metadata, size: bytes.byteLength };
  const hashed = typeof metadata.md5Hash === 'string';
  // Base64 MD5, the encoding `FullMetadata.md5Hash` carries. This store runs only under Node.
  if (hashed) repaired.md5Hash = createHash('md5').update(bytes).digest('base64');
  return repaired;
}

/** Validate every hosted payload before normal startup or repaired-state activation. */
export function validateHostedDatabase(database: Awaited<ReturnType<typeof openHostedDatabase>>): StorageMetadataRepair[] {
  const namespaces = database.connection.prepare('SELECT DISTINCT namespace FROM records').all();
  const unknownNamespace = namespaces.some(row => row.namespace !== 'hosted');
  if (unknownNamespace) throw new Error('Unsupported hosted persistence namespace.');
  const records = database.readRecords('hosted');
  const hasState = records.size > 0;
  if (hasState) {
    const snapshot = decodeImportBundle(bundleRecords(records));
    for (const [name, value] of Object.entries(snapshot.services)) validatePersistedService(name, value);
  }
  const repairs: StorageMetadataRepair[] = [];
  const repairedRows: StoredObjectRow[] = [];
  const stored = storedObjects(database.connection, database.objects, database.schemaVersion());
  for (const row of stored.rows()) {
    const metadata = storedMetadataSchema.parse(JSON.parse(row.metadata));
    const wrongIdentity = metadata.bucket !== row.bucket || metadata.fullPath !== row.path;
    // The limit applies to the bytes the row holds, not to the size it records.
    const oversize = row.size > MAX_STORAGE_OBJECT_BYTES;
    const invalid = wrongIdentity || oversize;
    if (invalid) throw new Error('Persisted Storage object does not match its metadata.');
    const sha256 = row.sha256;
    const inFile = sha256 !== undefined;
    if (inFile) {
      // A missing file has no size, so it fails the same check as a truncated one.
      const fileSize = database.objects.size(sha256);
      const mismatchedFile = fileSize !== row.size;
      if (mismatchedFile) throw new Error(`Persisted Storage object '${row.bucket}/${row.path}' ${fileSize === undefined ? 'has no file' : 'has a file of the wrong size'}.`);
    }
    const recordsTheBytes = metadata.size === row.size;
    if (recordsTheBytes) continue;
    repairs.push({ bucket: row.bucket, path: row.path, recordedSize: metadata.size, actualSize: row.size });
    repairedRows.push(row);
  }
  // A read-only export reports the repair its next writable startup performs.
  const writesRepairs = repairs.length > 0 && !database.readOnly;
  if (writesRepairs) writeRepairs(database, stored, repairedRows);
  return repairs;
}

function writeRepairs(database: Awaited<ReturnType<typeof openHostedDatabase>>, stored: StoredObjects, rows: readonly StoredObjectRow[]): void {
  const update = database.connection.prepare('UPDATE storage_objects SET metadata=? WHERE bucket=? AND path=?');
  database.commit(() => {
    for (const row of rows) {
      const metadata = storedMetadataSchema.parse(JSON.parse(row.metadata));
      update.run(JSON.stringify(repairedStorageMetadata(metadata, stored.bytes(row))), row.bucket, row.path);
    }
  });
}
