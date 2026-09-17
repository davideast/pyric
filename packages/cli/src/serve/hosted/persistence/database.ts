import { encodeHistory, historyChecksum } from './history-codec.js';
import { randomUUID } from 'node:crypto';
import { createHostedHistory } from './history.js';
import { createCommitController } from './commits.js';
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { inTransaction, openNodeSqlite, requireNodePersistence, sqlText } from './sqlite.js';
import { createSqliteStorage } from './storage.js';

export const HOSTED_SCHEMA_VERSION = 2;

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
    const unknownVersion = version !== 0 && version !== 1 && version !== HOSTED_SCHEMA_VERSION;
    const unsupported = emptyReadOnly || unknownVersion;
    if (unsupported) throw new Error(`Unsupported hosted database version ${String(version)}.`);
    const checks = connection.prepare('PRAGMA quick_check').all();
    const corrupt = checks.some(row => row.quick_check !== 'ok');
    if (corrupt) throw new Error('Hosted database integrity check failed. Preserve the directory before attempting salvage.');
    const mode = connection.prepare(readOnly ? 'PRAGMA journal_mode' : 'PRAGMA journal_mode=WAL').get()?.journal_mode;
    const lacksWal = mode !== 'wal';
    if (lacksWal) throw new Error('Hosted persistence requires local storage supporting SQLite WAL.');
    connection.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');
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
          PRAGMA user_version=1;
        `);
      });
    }
    const needsHistory = version !== HOSTED_SCHEMA_VERSION;
    if (needsHistory) {
      if (readOnly) throw new Error('Open this hosted database normally once to migrate history.');
      inTransaction(connection, () => {
        connection.exec(`
          CREATE TABLE history_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL,
            kind TEXT NOT NULL, service TEXT NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL) STRICT;
          CREATE INDEX history_service_sequence ON history_records(service, sequence);
          CREATE INDEX history_kind_sequence ON history_records(kind, sequence);
          CREATE TABLE history_meta(id INTEGER PRIMARY KEY CHECK(id=1), store_id TEXT NOT NULL, clean INTEGER NOT NULL) STRICT;
          CREATE TABLE history_undo(id INTEGER PRIMARY KEY, previous INTEGER NOT NULL, redo_next INTEGER NOT NULL, record_sequence INTEGER NOT NULL) STRICT;
          CREATE TABLE history_undo_state(id INTEGER PRIMARY KEY CHECK(id=1), next INTEGER NOT NULL, undo INTEGER NOT NULL, redo INTEGER NOT NULL, undo_count INTEGER NOT NULL, redo_count INTEGER NOT NULL) STRICT;
          INSERT INTO history_undo_state VALUES(1,1,0,0,0,0);
          PRAGMA user_version=2;
        `);
        connection.prepare('INSERT INTO history_meta VALUES (1,?,1)').run(randomUUID());
        const payload = encodeHistory({ reason: 'history-start', priorHistoryUnavailable: true });
        connection.prepare('INSERT INTO history_records(session,kind,service,payload,checksum) VALUES (?,?,?,?,?)').run('migration', 'boundary', 'runtime', payload, historyChecksum(payload));
      });
    }
    const commits = createCommitController(connection);
    const history = createHostedHistory(connection, commits, readOnly);
    const read = connection.prepare('SELECT payload FROM records WHERE namespace=? AND id=?');
    const list = connection.prepare('SELECT id FROM records WHERE namespace=? ORDER BY id');
    const put = connection.prepare('INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET payload=excluded.payload');
    const remove = connection.prepare('DELETE FROM records WHERE namespace=? AND id=?');
    const clear = connection.prepare('DELETE FROM records WHERE namespace=?');

    function commitChanges(key: string, changed: ReadonlyMap<string, unknown>, removed: readonly string[]): void {
      const empty = changed.size === 0 && removed.length === 0;
      const nothingChanged = empty && !history.engine.hasPending();
      if (nothingChanged) { history.flush(); return; }
      const encoded = [...changed].map(([id, value]) => {
        const payload = JSON.stringify(value);
        const missing = payload === undefined;
        if (missing) throw new Error(`Record '${id}' has no JSON representation.`);
        return { id, payload };
      });
      history.commitState(() => {
        history.record('mutation', 'runtime', { namespace: key, changed: encoded.map(record => record.id), removed });
        for (const { id, payload } of encoded) put.run(key, id, payload);
        for (const id of removed) remove.run(key, id);
      });
    }

    let closed = false;
    return {
      storage: createSqliteStorage(connection, history.commit, value => { history.record('mutation', 'storage', value); }),
      history,
      ...commits,
      connection,
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
          history.commitState(() => { history.boundary('clear'); clear.run(key); });
        },
      },
      close(): void {
        if (closed) return;
        try { history.close(); }
        finally { connection.close(); closed = true; }
      },
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
