import { bundleRecords } from 'pyric/sandbox';
import { decodeImportBundle, storedMetadataSchema, validatePersistedService } from 'pyric/sandbox/internal';
import type { openHostedDatabase } from './database.js';
import { sqlText } from './sqlite.js';
import { MAX_STORAGE_OP_BYTES } from '../../worker/protocol/storage.js';

/** Validate every hosted payload before normal startup or repaired-state activation. */
export function validateHostedDatabase(database: Awaited<ReturnType<typeof openHostedDatabase>>): void {
  const namespaces = database.connection.prepare('SELECT DISTINCT namespace FROM records').all();
  const unknownNamespace = namespaces.some(row => row.namespace !== 'hosted');
  if (unknownNamespace) throw new Error('Unsupported hosted persistence namespace.');
  const records = database.readRecords('hosted');
  const hasState = records.size > 0;
  if (hasState) {
    const snapshot = decodeImportBundle(bundleRecords(records));
    for (const [name, value] of Object.entries(snapshot.services)) validatePersistedService(name, value);
  }
  const rows = database.connection.prepare('SELECT bucket, path, metadata, mime, length(bytes) AS size FROM storage_objects').all();
  for (const row of rows) {
    const metadata = storedMetadataSchema.parse(JSON.parse(sqlText(row, 'metadata')));
    const wrongIdentity = metadata.bucket !== row.bucket || metadata.fullPath !== row.path;
    const wrongSize = metadata.size !== row.size || metadata.size > MAX_STORAGE_OP_BYTES;
    const invalid = wrongIdentity || wrongSize;
    if (invalid) throw new Error('Persisted Storage object does not match its metadata.');
    sqlText(row, 'mime');
  }
}
