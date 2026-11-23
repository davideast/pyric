import { createBlobStore, type BlobStore, type StoredBytes } from './blob-store.js';
import { addCheckpointTables, CHECKPOINT_TABLES, createHostedCheckpointBackend } from './checkpoints.js';
import { createCommitController } from './commits.js';
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Sandbox } from 'pyric/sandbox';
import { CHUNK_FORMAT_VERSION } from 'pyric/sandbox/internal';
import {
  firestoreRecordSpaceKey,
  firestoreRecordSpacePrefix,
  markAllNamedFirestoreDirty,
  onNamedFirestorePersistenceChange,
  prepareNamedFirestorePersistence,
  readFirestoreDeclaredFromMeta,
  restoreNamedFirestorePersistence,
  stampFirestoreDeclaredOnMeta,
} from 'pyric/firestore/internal';
import { inTransaction, openNodeSqlite, requireNodePersistence, sqlText, type SqlConnection } from './sqlite.js';
import { createSqliteStorage } from './storage.js';
import { FILE_BYTES_SCHEMA_VERSION, storedObjects } from './stored-objects.js';
import { BIND_HOSTED_SANDBOX_SYMBOL } from '../../worker/hosted-checkpoint-bind.js';

/** Version 4 stages uploads in files and has no staging table. */
const FILE_STAGING_SCHEMA_VERSION = 4;

/** Version 5 keeps the host's checkpoints, and the object hashes they name. */
const CHECKPOINTS_SCHEMA_VERSION = 5;

/** Version 6 keeps each Storage path's generation high-water mark. */
const GENERATIONS_SCHEMA_VERSION = 6;

/** Version 7 keys named Firestore databases under `<base>/firestore/<id>` namespaces. */
export const HOSTED_SCHEMA_VERSION = 7;

/**
 * Every schema version this build can read. A writable open upgrades an older
 * one in place; a read-only open reads it as it is.
 */
export const READABLE_HOSTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([
  1,
  2,
  FILE_BYTES_SCHEMA_VERSION,
  FILE_STAGING_SCHEMA_VERSION,
  CHECKPOINTS_SCHEMA_VERSION,
  GENERATIONS_SCHEMA_VERSION,
  HOSTED_SCHEMA_VERSION,
]);

/**
 * Each Storage path's high-water mark: the highest generation ever stored
 * there. Deletes, resets and restores leave it, so no write repeats one.
 */
const STORAGE_GENERATIONS_TABLE = `
  CREATE TABLE storage_generations (
    bucket TEXT NOT NULL,
    path TEXT NOT NULL,
    generation TEXT NOT NULL,
    PRIMARY KEY (bucket, path)
  ) STRICT;
`;

/** Version 5 to 6: an empty table of marks. A path with no mark falls back to its stored generation. */
function addGenerationsTable(connection: SqlConnection): void {
  inTransaction(connection, () => {
    connection.exec(`${STORAGE_GENERATIONS_TABLE} PRAGMA user_version=${GENERATIONS_SCHEMA_VERSION};`);
  });
}

/** Version 6 to 7: named Firestore namespaces (`<base>/firestore/<id>`); existing rows stay `(default)`. */
function upgradeToNamedFirestoreSchema(connection: SqlConnection): void {
  inTransaction(connection, () => {
    connection.exec(`PRAGMA user_version=${HOSTED_SCHEMA_VERSION};`);
  });
}

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
          ${STORAGE_GENERATIONS_TABLE}
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
        const initialVersion = schemaVersion;
        const holdsInlineBytes = schemaVersion < FILE_BYTES_SCHEMA_VERSION;
        if (holdsInlineBytes) moveBytesToFiles(connection, objects, schemaVersion);
        const stagesInTable = schemaVersion === FILE_BYTES_SCHEMA_VERSION;
        if (stagesInTable) dropStagingTable(connection);
        const lacksCheckpoints = schemaVersion < CHECKPOINTS_SCHEMA_VERSION;
        if (lacksCheckpoints) addCheckpointTables(connection, objects, options.checkpointFiles, CHECKPOINTS_SCHEMA_VERSION);
        const lacksGenerations = schemaVersion < GENERATIONS_SCHEMA_VERSION;
        if (lacksGenerations) addGenerationsTable(connection);
        const lacksNamedFirestore = schemaVersion < HOSTED_SCHEMA_VERSION;
        if (lacksNamedFirestore) upgradeToNamedFirestoreSchema(connection);
        schemaVersion = HOSTED_SCHEMA_VERSION;
        // Reclaim dropped inline-byte / staging pages when upgrading from < 6.
        if (initialVersion < GENERATIONS_SCHEMA_VERSION) {
          connection.exec('VACUUM');
        }
        connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }
      // No upload survives the host that began it.
      objects.clearStaging();
    };
    const commits = createCommitController(connection);
    const read = connection.prepare('SELECT payload FROM records WHERE namespace=? AND id=?');
    const list = connection.prepare('SELECT id FROM records WHERE namespace=? ORDER BY id');
    const listSubspaces = connection.prepare(
      'SELECT DISTINCT namespace FROM records WHERE substr(namespace, 1, ?)=? ORDER BY namespace',
    );
    const hasSubspaceRow = connection.prepare(
      'SELECT 1 FROM records WHERE substr(namespace, 1, ?)=? LIMIT 1',
    );
    const put = connection.prepare('INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET payload=excluded.payload');
    const remove = connection.prepare('DELETE FROM records WHERE namespace=? AND id=?');
    const clear = connection.prepare('DELETE FROM records WHERE namespace=?');
    const clearPrefix = connection.prepare('DELETE FROM records WHERE substr(namespace, 1, ?)=?');

    const boundSandboxes = new Map<string, Sandbox>();
    const boundUnsubs = new Set<() => void>();
    const boundTimers = new Set<ReturnType<typeof setTimeout>>();
    const boundTimersByKey = new Map<string, ReturnType<typeof setTimeout>>();

    function encodeChangedEntries(
      changed: ReadonlyMap<string, unknown>,
      serialized?: ReadonlyMap<string, string>,
    ): Array<{ id: string; payload: string }> {
      return [...changed].map(([id, value]) => {
        const payload = serialized?.get(id) ?? JSON.stringify(value);
        const missing = payload === undefined;
        if (missing) throw new Error(`Record '${id}' has no JSON representation.`);
        return { id, payload };
      });
    }

    function readRawRecord(key: string, id: string): unknown | null {
      const row = read.get(key, id);
      if (row === undefined) return null;
      return JSON.parse(sqlText(row, 'payload'));
    }

    function readAllRecords(key: string): Map<string, unknown> {
      return new Map(list.all(key).map(row => {
        const id = sqlText(row, 'id');
        const record = read.get(key, id);
        if (record === undefined) throw new Error(`Persisted record '${id}' disappeared during a read.`);
        return [id, JSON.parse(sqlText(record, 'payload'))];
      }));
    }

    function commitChanges(
      key: string,
      changed: ReadonlyMap<string, unknown>,
      removed: readonly string[],
      serialized?: ReadonlyMap<string, string>,
    ): void {
      const boundSandbox = boundSandboxes.get(key);
      if (boundSandbox === undefined) {
        if (changed.size === 0 && removed.length === 0) return;
        const encoded = encodeChangedEntries(changed, serialized);
        commits.commit(() => {
          for (const { id, payload } of encoded) put.run(key, id, payload);
          for (const id of removed) remove.run(key, id);
        });
        return;
      }

      const plan = prepareNamedFirestorePersistence(boundSandbox);
      const effectiveChanged = new Map<string, unknown>(changed);
      const effectiveSerialized = new Map<string, string>(serialized ?? []);

      if (effectiveChanged.has('meta')) {
        const rawMeta = effectiveChanged.get('meta');
        if (rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
          const stamped = stampFirestoreDeclaredOnMeta(rawMeta as Record<string, unknown>, plan.declared);
          effectiveChanged.set('meta', stamped);
          effectiveSerialized.set('meta', JSON.stringify(stamped));
        }
      } else if (plan.declaredChanged) {
        const priorMeta = readRawRecord(key, 'meta');
        let baseMeta: Record<string, unknown>;
        if (priorMeta !== null && typeof priorMeta === 'object' && !Array.isArray(priorMeta)) {
          baseMeta = priorMeta as Record<string, unknown>;
        } else {
          baseMeta = { version: CHUNK_FORMAT_VERSION, savedAt: Date.now(), services: {} };
        }
        const stamped = stampFirestoreDeclaredOnMeta(baseMeta, plan.declared);
        effectiveChanged.set('meta', stamped);
        effectiveSerialized.set('meta', JSON.stringify(stamped));
      }

      const hasBaseWork = effectiveChanged.size > 0 || removed.length > 0;
      if (!hasBaseWork && plan.databases.size === 0) {
        plan.commit();
        return;
      }

      const baseEncoded = encodeChangedEntries(effectiveChanged, effectiveSerialized);
      const namedEncoded: Array<{
        namespace: string;
        encoded: Array<{ id: string; payload: string }>;
        removed: readonly string[];
      }> = [];
      for (const [dbId, diff] of plan.databases) {
        namedEncoded.push({
          namespace: firestoreRecordSpaceKey(key, dbId),
          encoded: encodeChangedEntries(diff.changed, diff.serializedChanged),
          removed: diff.removed,
        });
      }

      try {
        commits.commit(() => {
          for (const { id, payload } of baseEncoded) put.run(key, id, payload);
          for (const id of removed) remove.run(key, id);
          for (const space of namedEncoded) {
            for (const { id, payload } of space.encoded) put.run(space.namespace, id, payload);
            for (const id of space.removed) remove.run(space.namespace, id);
          }
        });
        plan.commit();
      } catch (error) {
        plan.retry();
        throw error;
      }
    }

    function listNamedFirestoreDatabases(baseKey: string): string[] {
      const prefix = firestoreRecordSpacePrefix(baseKey);
      return listSubspaces
        .all(prefix.length, prefix)
        .map(row => sqlText(row, 'namespace').slice(prefix.length));
    }

    function clearAllRecordSpaces(baseKey: string): void {
      if (baseKey.includes('/firestore/')) {
        commits.commit(() => { clear.run(baseKey); });
        return;
      }
      const pendingTimer = boundTimersByKey.get(baseKey);
      if (pendingTimer !== undefined) {
        clearTimeout(pendingTimer);
        boundTimers.delete(pendingTimer);
        boundTimersByKey.delete(baseKey);
      }
      const prefix = firestoreRecordSpacePrefix(baseKey);
      commits.commit(() => {
        clear.run(baseKey);
        clearPrefix.run(prefix.length, prefix);
      });
      const boundSandbox = boundSandboxes.get(baseKey);
      if (boundSandbox !== undefined) {
        markAllNamedFirestoreDirty(boundSandbox);
      }
    }

    let closed = false;
    const checkpoints = createHostedCheckpointBackend(connection, commits.commit, objects);
    const databaseHandle = {
      storage: createSqliteStorage(connection, commits.commit, objects),
      objects,
      /** The version of the schema as it is now; an upgrade changes it. */
      schemaVersion: (): number => schemaVersion,
      /** Checkpoints of the hosted sandbox, kept in this store. */
      checkpoints,
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
      readRecord: readRawRecord,
      hasRecords(key: string): boolean {
        return connection.prepare('SELECT 1 FROM records WHERE namespace=? LIMIT 1').get(key) !== undefined;
      },
      hasAnyRecords(baseKey: string): boolean {
        if (connection.prepare('SELECT 1 FROM records WHERE namespace=? LIMIT 1').get(baseKey) !== undefined) {
          return true;
        }
        if (baseKey.includes('/firestore/')) return false;
        const prefix = firestoreRecordSpacePrefix(baseKey);
        return hasSubspaceRow.get(prefix.length, prefix) !== undefined;
      },
      readRecords: readAllRecords,
      listNamedFirestoreDatabases,
      clearAllRecordSpaces,
      bindSandbox(sandbox: Sandbox, baseKey = 'hosted'): void {
        if (boundSandboxes.get(baseKey) === sandbox) return;
        boundSandboxes.set(baseKey, sandbox);
        const meta = readRawRecord(baseKey, 'meta');
        const declared = readFirestoreDeclaredFromMeta(meta);
        const dbRecords = new Map<string, Map<string, unknown>>();
        for (const dbId of declared) {
          dbRecords.set(dbId, readAllRecords(firestoreRecordSpaceKey(baseKey, dbId)));
        }
        restoreNamedFirestorePersistence(sandbox, declared, dbRecords);
        const unsub = onNamedFirestorePersistenceChange(sandbox, () => {
          if (closed || readOnly || boundTimersByKey.has(baseKey)) return;
          const timer = setTimeout(() => {
            boundTimers.delete(timer);
            if (boundTimersByKey.get(baseKey) === timer) {
              boundTimersByKey.delete(baseKey);
            }
            if (closed || readOnly) return;
            void sandbox.flush().catch(() => {});
          }, 50);
          boundTimers.add(timer);
          boundTimersByKey.set(baseKey, timer);
        });
        boundUnsubs.add(unsub);
      },
      commitChanges,
      records: {
        retryFailedFlush: false,
        async getRecord(key: string, id: string): Promise<unknown | null> {
          return readRawRecord(key, id);
        },
        async listRecords(key: string): Promise<string[]> {
          return list.all(key).map(row => sqlText(row, 'id'));
        },
        async applyChanges(
          key: string,
          changed: ReadonlyMap<string, unknown>,
          removed: readonly string[],
          serialized?: ReadonlyMap<string, string>,
        ): Promise<void> {
          commitChanges(key, changed, removed, serialized);
        },
        async putRecords(key: string, records: ReadonlyMap<string, unknown>): Promise<void> {
          commitChanges(key, records, []);
        },
        async deleteRecords(key: string, ids: readonly string[]): Promise<void> {
          commitChanges(key, new Map(), ids);
        },
        async clear(key: string): Promise<void> {
          clearAllRecordSpaces(key);
        },
      },
      close(): void {
        if (closed) return;
        closed = true;
        for (const unsub of boundUnsubs) unsub();
        boundUnsubs.clear();
        for (const timer of boundTimers) clearTimeout(timer);
        boundTimers.clear();
        boundTimersByKey.clear();
        boundSandboxes.clear();
        connection.close();
      },
    };
    Object.defineProperty(checkpoints, BIND_HOSTED_SANDBOX_SYMBOL, {
      value: (sandbox: Sandbox) => {
        databaseHandle.bindSandbox(sandbox, 'hosted');
      },
      enumerable: false,
      configurable: true,
    });
    return databaseHandle;
  } catch (error) {
    connection.close();
    throw error;
  }
}
