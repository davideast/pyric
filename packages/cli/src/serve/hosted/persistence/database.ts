import { createCommitController } from './commits.js';
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { inTransaction, openNodeSqlite, requireNodePersistence, sqlText, type SqlConnection } from './sqlite.js';
import { createSqliteStorage } from './storage.js';

export const HOSTED_SCHEMA_VERSION = 2;

/**
 * Every schema version this build can read. A writable open upgrades an older
 * one in place; a read-only open reads it as it is.
 */
export const READABLE_HOSTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, HOSTED_SCHEMA_VERSION]);

/** Chunked-upload staging: one header row (`part_index` -1) and one row per part. */
const STORAGE_UPLOADS_TABLE = `
  CREATE TABLE storage_uploads (
    upload_id TEXT NOT NULL,
    connection_id TEXT,
    bucket TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_type TEXT,
    custom_metadata TEXT,
    part_index INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (upload_id, part_index)
  ) STRICT;
`;

/**
 * Version 1 had no staging table. A version-1 database opened by a build that
 * created the table without `part_index` holds that shape instead, and no
 * staged upload in it can be finished, so it is replaced.
 */
function upgradeFromVersion1(connection: SqlConnection): void {
  const columns = connection.prepare('PRAGMA table_info(storage_uploads)').all().map(row => sqlText(row, 'name'));
  const hasStagingTable = columns.length > 0;
  const hasPartIndex = columns.includes('part_index');
  const hasUnusableStaging = hasStagingTable && !hasPartIndex;
  if (hasUnusableStaging) connection.exec('DROP TABLE storage_uploads');
  const needsStagingTable = !hasStagingTable || hasUnusableStaging;
  if (needsStagingTable) connection.exec(STORAGE_UPLOADS_TABLE);
  connection.exec(`PRAGMA user_version=${HOSTED_SCHEMA_VERSION}`);
}

/** One database per hosted directory; callers own its lifetime. */
export async function openHostedDatabase(directory: string, options: { readOnly?: boolean } = {}) {
  requireNodePersistence();
  const readOnly = options.readOnly === true;
  const createsStore = !readOnly;
  if (createsStore) mkdirSync(directory, { recursive: true });
  const pathSegments = resolve(directory).split(sep);
  const knownSyncedDirectory = pathSegments.some(part => /^(Dropbox|OneDrive(?: - .+)?|CloudStorage|Mobile Documents)$/i.test(part));
  if (knownSyncedDirectory) console.warn('[pyric] Hosted SQLite appears to be in a synced directory. Use a local, unsynced project directory; this warning cannot certify filesystem safety.');
  const connection = await openNodeSqlite(join(directory, 'state.sqlite'), readOnly);
  try {
    const version = connection.prepare('PRAGMA user_version').get()?.user_version;
    const emptyReadOnly = readOnly && version === 0;
    const unknownVersion = version !== 0 && !READABLE_HOSTED_SCHEMA_VERSIONS.has(Number(version));
    const unsupported = emptyReadOnly || unknownVersion;
    if (unsupported) throw new Error(`Unsupported hosted database version ${String(version)}.`);
    const checks = connection.prepare('PRAGMA quick_check').all();
    const corrupt = checks.some(row => row.quick_check !== 'ok');
    if (corrupt) throw new Error('Hosted database integrity check failed. Preserve the directory before attempting salvage.');
    const mode = connection.prepare(readOnly ? 'PRAGMA journal_mode' : 'PRAGMA journal_mode=WAL').get()?.journal_mode;
    const lacksWal = mode !== 'wal';
    if (lacksWal) throw new Error('Hosted persistence requires local storage supporting SQLite WAL.');
    // SQLite retries transient contention within this bound. The separate
    // project-ownership connection retains its fail-fast busy_timeout=0.
    connection.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=250');
    const isNew = version === 0;
    if (isNew) {
      inTransaction(connection, () => {
        connection.exec(`
          CREATE TABLE records (
            namespace TEXT NOT NULL,
            id TEXT NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY (namespace, id)
          ) STRICT;
          CREATE TABLE storage_objects (
            bucket TEXT NOT NULL,
            path TEXT NOT NULL,
            metadata TEXT NOT NULL,
            mime TEXT NOT NULL,
            bytes BLOB NOT NULL,
            PRIMARY KEY (bucket, path)
          ) STRICT;
          ${STORAGE_UPLOADS_TABLE}
          PRAGMA user_version=${HOSTED_SCHEMA_VERSION};
        `);
      });
    }
    // An older schema is upgraded only after its contents validate, so a store
    // that is refused is left exactly as it was found.
    let upgradePending = !readOnly && version === 1;
    const clearStaleUploads = (): void => {
      // Staged parts older than an hour belong to uploads no client will finish.
      connection.prepare('DELETE FROM storage_uploads WHERE created_at < ?').run(Date.now() - 3600_000);
    };
    const clearsStaleUploadsNow = !readOnly && !upgradePending;
    if (clearsStaleUploadsNow) clearStaleUploads();
    const upgradeSchema = (): void => {
      const upToDate = !upgradePending;
      if (upToDate) return;
      inTransaction(connection, () => upgradeFromVersion1(connection));
      upgradePending = false;
      clearStaleUploads();
    };
    const commits = createCommitController(connection);
    const read = connection.prepare('SELECT payload FROM records WHERE namespace=? AND id=?');
    const list = connection.prepare('SELECT id FROM records WHERE namespace=? ORDER BY id');
    const put = connection.prepare('INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET payload=excluded.payload');
    const remove = connection.prepare('DELETE FROM records WHERE namespace=? AND id=?');
    const clear = connection.prepare('DELETE FROM records WHERE namespace=?');

    function commitChanges(key: string, changed: ReadonlyMap<string, unknown>, removed: readonly string[]): void {
      const empty = changed.size === 0 && removed.length === 0;
      if (empty) return;
      const encoded = [...changed].map(([id, value]) => {
        const payload = JSON.stringify(value);
        const missing = payload === undefined;
        if (missing) throw new Error(`Record '${id}' has no JSON representation.`);
        return { id, payload };
      });
      commits.commit(() => {
        for (const { id, payload } of encoded) put.run(key, id, payload);
        for (const id of removed) remove.run(key, id);
      });
    }

    let closed = false;
    return {
      storage: createSqliteStorage(connection, commits.commit),
      /** Bring an older writable schema up to date; call after its contents validate. */
      upgradeSchema,
      ...commits,
      connection,
      readOnly,
      readRecord(key: string, id: string): unknown | null {
        const row = read.get(key, id);
        const hasRecord = row !== undefined;
        if (hasRecord) return JSON.parse(sqlText(row, 'payload'));
        return null;
      },
      hasRecords(key: string): boolean {
        return connection.prepare('SELECT 1 FROM records WHERE namespace=? LIMIT 1').get(key) !== undefined;
      },
      readRecords(key: string): Map<string, unknown> {
        return new Map(list.all(key).map(row => {
          const id = sqlText(row, 'id');
          const record = read.get(key, id);
          const missingRecord = record === undefined;
          if (missingRecord) throw new Error(`Persisted record '${id}' disappeared during a read.`);
          return [id, JSON.parse(sqlText(record, 'payload'))];
        }));
      },
      commitChanges,
      records: {
        retryFailedFlush: false,
        async getRecord(key: string, id: string): Promise<unknown | null> {
          const row = read.get(key, id);
          const missingRecord = row === undefined;
          if (missingRecord) return null;
          return JSON.parse(sqlText(row, 'payload'));
        },
        async listRecords(key: string): Promise<string[]> {
          return list.all(key).map(row => sqlText(row, 'id'));
        },
        async applyChanges(key: string, changed: ReadonlyMap<string, unknown>, removed: readonly string[]): Promise<void> {
          commitChanges(key, changed, removed);
        },
        async putRecords(key: string, records: ReadonlyMap<string, unknown>): Promise<void> {
          commitChanges(key, records, []);
        },
        async deleteRecords(key: string, ids: readonly string[]): Promise<void> {
          commitChanges(key, new Map(), ids);
        },
        async clear(key: string): Promise<void> {
          commits.commit(() => { clear.run(key); });
        },
      },
      close(): void {
        if (closed) return;
        connection.close();
        closed = true;
      },
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
