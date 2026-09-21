import { bundleRecords } from 'pyric/sandbox';
import { decodeImportBundle, storedMetadataSchema, validatePersistedService } from 'pyric/sandbox/internal';
import { createHash } from 'node:crypto';
import type { StoredMetadata } from 'pyric/storage/internal';
import type { openHostedDatabase } from './database.js';
import { sqlText } from './sqlite.js';
import { MAX_STORAGE_OP_BYTES } from '../../worker/protocol/storage.js';

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
  const rows = database.connection.prepare('SELECT bucket, path, metadata, mime, length(bytes) AS size FROM storage_objects').all();
  for (const row of rows) {
    const metadata = storedMetadataSchema.parse(JSON.parse(sqlText(row, 'metadata')));
    const wrongIdentity = metadata.bucket !== row.bucket || metadata.fullPath !== row.path;
    // The limit applies to the bytes the row holds, not to the size it records.
    const storedSize = Number(row.size);
    const oversize = storedSize > MAX_STORAGE_OP_BYTES;
    const invalid = wrongIdentity || oversize;
    if (invalid) throw new Error('Persisted Storage object does not match its metadata.');
    sqlText(row, 'mime');
    const recordsTheBytes = metadata.size === storedSize;
    if (recordsTheBytes) continue;
    repairs.push({ bucket: sqlText(row, 'bucket'), path: sqlText(row, 'path'), recordedSize: metadata.size, actualSize: storedSize });
  }
  // A read-only export reports the repair its next writable startup performs.
  const writesRepairs = repairs.length > 0 && !database.readOnly;
  if (writesRepairs) writeRepairs(database, repairs);
  return repairs;
}

function writeRepairs(database: Awaited<ReturnType<typeof openHostedDatabase>>, repairs: readonly StorageMetadataRepair[]): void {
  const read = database.connection.prepare('SELECT metadata, bytes FROM storage_objects WHERE bucket=? AND path=?');
  const update = database.connection.prepare('UPDATE storage_objects SET metadata=? WHERE bucket=? AND path=?');
  database.commit(() => {
    for (const repair of repairs) {
      const row = read.get(repair.bucket, repair.path);
      const missingObject = row === undefined;
      if (missingObject) throw new Error('Persisted Storage object disappeared during validation.');
      const bytes = row.bytes;
      const binary = bytes instanceof Uint8Array;
      const invalidBytes = !binary;
      if (invalidBytes) throw new Error('Invalid persisted Storage bytes.');
      const metadata = storedMetadataSchema.parse(JSON.parse(sqlText(row, 'metadata')));
      update.run(JSON.stringify(repairedStorageMetadata(metadata, bytes)), repair.bucket, repair.path);
    }
  });
}
