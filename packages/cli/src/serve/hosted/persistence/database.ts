import { createBlobStore, type BlobStore, type StoredBytes } from './blob-store.js';
import { addCheckpointTables, CHECKPOINT_TABLES, createHostedCheckpointBackend } from './checkpoints.js';
import { createCommitController } from './commits.js';
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { inTransaction, openNodeSqlite, requireNodePersistence, sqlText, type SqlConnection } from './sqlite.js';
import { createSqliteStorage } from './storage.js';
import { FILE_BYTES_SCHEMA_VERSION, storedObjects } from './stored-objects.js';

/** Version 4 stages uploads in files and has no staging table. */
const FILE_STAGING_SCHEMA_VERSION = 4;

/** Version 5 keeps the host's checkpoints, and the object hashes they name. */
export const HOSTED_SCHEMA_VERSION = 5;

/**
 * Every schema version this build can read. A writable open upgrades an older
 * one in place; a read-only open reads it as it is.
 */
export const READABLE_HOSTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2, FILE_BYTES_SCHEMA_VERSION, FILE_STAGING_SCHEMA_VERSION, HOSTED_SCHEMA_VERSION]);

/** Object metadata; the bytes are the file `objects/<ab>/<sha256>`. */
const storageObjectsTable = (name: string): string => `
  CREATE TABLE ${name} (
    bucket TEXT NOT NULL,
    path TEXT NOT NULL,
    metadata TEXT NOT NULL,
    mime TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (bucket, path)
  ) STRICT;
`;

/**
 * Versions 1 and 2 kept each object's bytes in a column. Every object's bytes
 * are written to its file first, one object in memory at a time; one
 * transaction then replaces the table. An interruption before that commit
 * leaves the store as it was and some unreferenced files.
 */
function moveBytesToFiles(connection: SqlConnection, objects: BlobStore, version: number): void {
  const inline = storedObjects(connection, objects, version);
  const rows = inline.rows();
  const files = rows.map((row): StoredBytes => objects.write(inline.bytes(row)));
  inTransaction(connection, () => {
    connection.exec(storageObjectsTable('storage_objects_by_hash'));
    const copy = connection.prepare(`INSERT INTO storage_objects_by_hash (bucket, path, metadata, mime, sha256, size)
      SELECT bucket, path, metadata, mime, ?, ? FROM storage_objects WHERE bucket=? AND path=?`);
    rows.forEach((row, index) => copy.run(files[index].sha256, files[index].size, row.bucket, row.path));
    const copied = Number(connection.prepare('SELECT count(*) AS n FROM storage_objects_by_hash').get()?.n);
    const lostRows = copied !== rows.length;
    if (lostRows) throw new Error('Storage objects changed while their bytes moved to files.');
    connection.exec(`
      DROP TABLE storage_objects;
      ALTER TABLE storage_objects_by_hash RENAME TO storage_objects;
      DROP TABLE IF EXISTS storage_uploads;
      PRAGMA user_version=${FILE_STAGING_SCHEMA_VERSION};
    `);
  });
}

/** Version 3 staged uploads as rows. No host that staged them is running, so they are dropped. */
function dropStagingTable(connection: SqlConnection): void {
  inTransaction(connection, () => {
    connection.exec(`DROP TABLE IF EXISTS storage_uploads; PRAGMA user_version=${FILE_STAGING_SCHEMA_VERSION};`);
  });
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
          ${storageObjectsTable('storage_objects')}
          ${CHECKPOINT_TABLES}
          PRAGMA user_version=${HOSTED_SCHEMA_VERSION};
        `);
      });
    }
    let schemaVersion = isNew ? HOSTED_SCHEMA_VERSION : Number(version);
    const objects = createBlobStore(join(directory, 'objects'));
    // An older schema is upgraded only after its contents validate, so a store
    // that is refused is left exactly as it was found.
    const upgradePending = schemaVersion < HOSTED_SCHEMA_VERSION;
    let activated = false;
    const activate = (options: { checkpointFiles?: string } = {}): void => {
      const skip = readOnly || activated;
      if (skip) return;
      activated = true;
      if (upgradePending) {
        const holdsInlineBytes = schemaVersion < FILE_BYTES_SCHEMA_VERSION;
        if (holdsInlineBytes) moveBytesToFiles(connection, objects, schemaVersion);
        const stagesInTable = schemaVersion === FILE_BYTES_SCHEMA_VERSION;
        if (stagesInTable) dropStagingTable(connection);
        addCheckpointTables(connection, objects, options.checkpointFiles, HOSTED_SCHEMA_VERSION);
        schemaVersion = HOSTED_SCHEMA_VERSION;
        // Without the bytes and the staged parts the live data is small, so
        // rebuilding the file to give their pages back is quick.
        connection.exec('VACUUM');
        connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }
      // No upload survives the host that began it.
      objects.clearStaging();
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
      storage: createSqliteStorage(connection, commits.commit, objects),
      objects,
      /** The version of the schema as it is now; an upgrade changes it. */
      schemaVersion: (): number => schemaVersion,
      /** Checkpoints of the hosted sandbox, kept in this store. */
      checkpoints: createHostedCheckpointBackend(connection, commits.commit, objects),
      /** Every object file hash a row or a checkpoint names: the files a sweep keeps. */
      referencedObjects(): Set<string> {
        const rows = connection.prepare('SELECT sha256 FROM storage_objects UNION SELECT sha256 FROM checkpoint_objects').all();
        return new Set(rows.map(row => sqlText(row, 'sha256')));
      },
      /**
       * Bring an older writable schema up to date and discard uploads a stopped
       * host left staged. Call once, after the store's contents validate, so a
       * store that is refused is left exactly as it was found. Upgrading to
       * version 5 imports the checkpoint files in `checkpointFiles`.
       */
      activate,
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
