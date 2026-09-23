import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StorageObjectState } from 'pyric/sandbox';
import {
  assertCheckpointName,
  CHECKPOINT_FORMAT,
  CHECKPOINT_NAME_PATTERN,
  isCheckpointEnvelope,
  type Checkpoint,
  type CheckpointBackend,
  type CheckpointListing,
} from 'pyric/sandbox/checkpoints';
import type { BlobStore } from './blob-store.js';
import type { Commit } from './commits.js';
import { inTransaction, sqlText, type SqlConnection } from './sqlite.js';

/**
 * Checkpoints of the hosted sandbox. A checkpoint's state is JSON whose Storage
 * entries name their bytes by hash; `checkpoint_objects` lists those hashes so
 * the sweep keeps their files.
 */
export const CHECKPOINT_TABLES = `
  CREATE TABLE checkpoints (
    name TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    counts TEXT NOT NULL,
    state TEXT NOT NULL
  ) STRICT;
  CREATE TABLE checkpoint_objects (
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (name, sha256)
  ) STRICT;
`;

/** The hashes a checkpoint's Storage entries name. */
function hashesOf(checkpoint: Checkpoint): string[] {
  const hashes = checkpoint.state.storage.flatMap(object => ('sha256' in object ? [object.sha256] : []));
  return [...new Set(hashes)];
}

/**
 * Write each inline Storage entry that has its metadata as an object file and
 * refer to it by hash. An entry without metadata stays inline, as restoring a
 * reference needs the metadata it was stored with.
 */
function withObjectFiles(checkpoint: Checkpoint, objects: BlobStore): Checkpoint {
  const storage = checkpoint.state.storage.map((object): StorageObjectState => {
    const convertible = 'contentBase64' in object && object.metadata !== undefined;
    if (!convertible) return object;
    const { contentBase64, ...rest } = object;
    const stored = objects.write(Buffer.from(contentBase64, 'base64'));
    return { ...rest, sha256: stored.sha256, size: stored.size };
  });
  return { ...checkpoint, state: { ...checkpoint.state, storage } };
}

/** A checkpoint file's contents, or null when the file is not a checkpoint. */
function checkpointFile(path: string): Checkpoint | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
  return isCheckpointEnvelope(parsed) ? parsed : null;
}

function insertCheckpoint(connection: SqlConnection, name: string, checkpoint: Checkpoint): void {
  connection.prepare(`INSERT INTO checkpoints (name, at, counts, state) VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET at=excluded.at, counts=excluded.counts, state=excluded.state`)
    .run(name, checkpoint.at, JSON.stringify(checkpoint.counts), JSON.stringify(checkpoint.state));
  connection.prepare('DELETE FROM checkpoint_objects WHERE name=?').run(name);
  const insertObject = connection.prepare('INSERT INTO checkpoint_objects (name, sha256) VALUES (?, ?)');
  for (const sha256 of hashesOf(checkpoint)) insertObject.run(name, sha256);
}

/**
 * Create the checkpoint tables and bring in the checkpoints a host saved as
 * files in `filesDirectory` before it kept them in SQLite. Their inline bytes
 * are written as object files first; the tables, the imported rows, and the
 * version change commit together. The files are left for an in-process sandbox.
 * A file that is not a checkpoint is left out.
 */
export function addCheckpointTables(connection: SqlConnection, objects: BlobStore, filesDirectory: string | undefined, version: number): void {
  const imported: Array<[string, Checkpoint]> = [];
  const hasFiles = filesDirectory !== undefined && existsSync(filesDirectory);
  if (hasFiles) {
    for (const file of readdirSync(filesDirectory).sort()) {
      const name = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
      const namedLikeCheckpoint = CHECKPOINT_NAME_PATTERN.test(name);
      if (!namedLikeCheckpoint) continue;
      const checkpoint = checkpointFile(join(filesDirectory, file));
      const unreadable = checkpoint === null;
      if (unreadable) continue;
      imported.push([name, withObjectFiles(checkpoint, objects)]);
    }
  }
  inTransaction(connection, () => {
    connection.exec(CHECKPOINT_TABLES);
    for (const [name, checkpoint] of imported) insertCheckpoint(connection, name, checkpoint);
    connection.exec(`PRAGMA user_version=${version}`);
  });
}

/**
 * Keep the hosted sandbox's checkpoints in its SQLite store. A capture refers
 * to Storage objects by hash, so taking a checkpoint copies no bytes and
 * restoring one writes only rows.
 */
export function createHostedCheckpointBackend(connection: SqlConnection, commit: Commit, objects: BlobStore): CheckpointBackend {
  return {
    storage: 'reference',
    async write(name, checkpoint) {
      assertCheckpointName(name);
      const stored = withObjectFiles(checkpoint, objects);
      for (const object of stored.state.storage) {
        const referenced = 'sha256' in object;
        const present = !referenced || objects.size(object.sha256) === object.size;
        if (!present) throw new Error(`Checkpoint '${name}' names object '${object.path}', whose file is missing.`);
      }
      commit(() => insertCheckpoint(connection, name, stored));
    },
    async read(name) {
      assertCheckpointName(name);
      const row = connection.prepare('SELECT at, counts, state FROM checkpoints WHERE name=?').get(name);
      const missing = row === undefined;
      if (missing) return null;
      const checkpoint: unknown = {
        format: CHECKPOINT_FORMAT, at: Number(row.at), counts: JSON.parse(sqlText(row, 'counts')), state: JSON.parse(sqlText(row, 'state')),
      };
      const isCheckpoint = isCheckpointEnvelope(checkpoint);
      if (!isCheckpoint) throw new Error(`Checkpoint '${name}' in the hosted store is not a checkpoint.`);
      return checkpoint;
    },
    async list() {
      return connection.prepare('SELECT name, at, counts FROM checkpoints ORDER BY name').all().map((row): CheckpointListing => ({
        name: sqlText(row, 'name'), at: Number(row.at), counts: JSON.parse(sqlText(row, 'counts')),
      }));
    },
    async remove(name) {
      assertCheckpointName(name);
      return commit(() => {
        const existed = connection.prepare('SELECT 1 AS present FROM checkpoints WHERE name=?').get(name) !== undefined;
        connection.prepare('DELETE FROM checkpoint_objects WHERE name=?').run(name);
        connection.prepare('DELETE FROM checkpoints WHERE name=?').run(name);
        return existed;
      });
    },
  };
}
