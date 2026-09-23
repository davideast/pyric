import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureCheckpoint, listCheckpoints, removeCheckpoint, restoreNamedCheckpoint, saveCheckpoint } from 'pyric/sandbox/checkpoints';
import { directoryCheckpointBackend } from 'pyric/sandbox/checkpoints/directory';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, installStorageBackend } from 'pyric/storage/internal';
import { deleteObject, ref, uploadBytes } from 'pyric/storage';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';

const root = process.argv[2];
const MiB = 1024 * 1024;
const HOUR = 3600_000;
const bucket = 'pyric-default';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const objectFile = (project: string, hash: string): string => join(hostedStateDirectory(project), 'objects', hash.slice(0, 2), hash);
const take = new Uint8Array(3 * MiB).map((_, index) => index % 251);
const LARGE = 300 * MiB;
const largeHash = 'e'.repeat(64);

/** Make every object file look as old as a file from an earlier session. */
function age(project: string): void {
  const objects = join(hostedStateDirectory(project), 'objects');
  const past = new Date(Date.now() - HOUR);
  for (const shard of readdirSync(objects).filter(name => /^[0-9a-f]{2}$/.test(name))) {
    for (const name of readdirSync(join(objects, shard))) utimesSync(join(objects, shard, name), past, past);
  }
}

/** A host's sandbox over its persistence, as the hosted runtime builds it. */
async function open(project: string) {
  const persistence = await createHostedPersistence(project);
  await persistence.sweep;
  const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(sandbox, persistence.storage);
  const storage = getAdminStorageSandbox(sandbox);
  return { persistence, sandbox, storage, close() { sandbox.dispose(); persistence.close(); } };
}

function checkpointRows(project: string) {
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'), { readOnly: true });
  try {
    const state = database.prepare('SELECT state FROM checkpoints WHERE name=?').get('before')?.state;
    const hashes = database.prepare('SELECT sha256 FROM checkpoint_objects WHERE name=? ORDER BY sha256').all('before').map(row => String(row.sha256));
    return { state: state === undefined ? undefined : String(state), hashes };
  } finally { database.close(); }
}

// A hosted checkpoint records its objects by hash in SQLite: taking one reads no object bytes.
const project = join(root, 'project');
{
  const host = await open(project);
  await uploadBytes(ref(host.storage, 'media/take.wav'), take, { contentType: 'audio/wav' });
  host.close();
  // A 300 MiB object as a sparse file, so reading it would show in resident memory.
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'));
  const metadata = {
    bucket, fullPath: 'media/long.wav', name: 'long.wav', size: LARGE, generation: '1', metageneration: '1',
    timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'audio/wav',
  };
  mkdirSync(join(objectFile(project, largeHash), '..'), { recursive: true });
  writeFileSync(objectFile(project, largeHash), '');
  truncateSync(objectFile(project, largeHash), LARGE);
  database.prepare('INSERT INTO storage_objects (bucket, path, metadata, mime, sha256, size) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bucket, 'media/long.wav', JSON.stringify(metadata), 'audio/wav', largeHash, LARGE);
  database.close();

  const reopened = await open(project);
  try {
    const rssBefore = process.memoryUsage().rss;
    const saved = await saveCheckpoint(reopened.persistence.checkpoints, 'before', reopened.sandbox);
    const growth = process.memoryUsage().rss - rssBefore;
    assert.ok(growth < 32 * MiB, `taking the checkpoint read no object bytes (rss grew ${(growth / MiB).toFixed(1)} MiB)`);
    assert.equal(saved.checkpoint.counts.storage, 2);
  } finally { reopened.close(); }
  const rows = checkpointRows(project);
  assert.ok(rows.state !== undefined);
  assert.equal(rows.state!.includes('contentBase64'), false);
  assert.deepEqual(rows.hashes, [sha256(take), largeHash].sort());
  assert.deepEqual(readdirSync(join(project, '.pyric', 'state')).includes('checkpoints'), false, 'no checkpoint file is written');
}

// Objects deleted since the checkpoint keep their files through a sweep, and restoring
// the checkpoint writes their rows back without reading their bytes.
{
  const host = await open(project);
  await deleteObject(ref(host.storage, 'media/take.wav'));
  await deleteObject(ref(host.storage, 'media/long.wav'));
  host.close();
  age(project);
  const restarted = await open(project);
  try {
    assert.ok(existsSync(objectFile(project, sha256(take))), 'a checkpoint keeps its files');
    assert.ok(existsSync(objectFile(project, largeHash)));
    const rssBefore = process.memoryUsage().rss;
    const restored = await restoreNamedCheckpoint(restarted.persistence.checkpoints, 'before', restarted.sandbox);
    const growth = process.memoryUsage().rss - rssBefore;
    assert.ok(restored !== null);
    assert.ok(growth < 32 * MiB, `restoring read no object bytes (rss grew ${(growth / MiB).toFixed(1)} MiB)`);
    const blob = await restarted.persistence.storage.getBlob('media/take.wav', bucket);
    assert.ok(Buffer.from(await blob!.arrayBuffer()).equals(Buffer.from(take)));
    assert.equal((await restarted.persistence.storage.getMetadata('media/long.wav', bucket))?.size, LARGE);
    assert.deepEqual((await listCheckpoints(restarted.persistence.checkpoints)).map(entry => entry.name), ['before']);
  } finally { restarted.close(); }
}

// Removing the checkpoint releases its files: once no row names them either, a sweep removes them.
{
  const host = await open(project);
  assert.equal(await removeCheckpoint(host.persistence.checkpoints, 'before'), true);
  await deleteObject(ref(host.storage, 'media/take.wav'));
  await deleteObject(ref(host.storage, 'media/long.wav'));
  host.close();
  age(project);
  const restarted = await open(project);
  restarted.close();
  assert.equal(existsSync(objectFile(project, sha256(take))), false);
  assert.equal(existsSync(objectFile(project, largeHash)), false);
  assert.deepEqual(checkpointRows(project).hashes, []);
}

// Checkpoints a host saved as files before it kept them in SQLite are imported
// on its first start, and the files are left for an in-process sandbox.
{
  const source = mkdtempSync(join(root, 'source-'));
  const inProcess = await open(source);
  await uploadBytes(ref(inProcess.storage, 'media/old.wav'), take, { contentType: 'audio/wav' });
  const checkpoint = await captureCheckpoint(inProcess.sandbox);
  inProcess.close();

  const upgraded = mkdtempSync(join(root, 'upgraded-'));
  const directory = hostedStateDirectory(upgraded);
  mkdirSync(directory, { recursive: true });
  // The store as the previous release left it: version 4, checkpoints beside it as files.
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE records (namespace TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (namespace, id)) STRICT;
    CREATE TABLE storage_objects (bucket TEXT NOT NULL, path TEXT NOT NULL, metadata TEXT NOT NULL, mime TEXT NOT NULL,
      sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (bucket, path)) STRICT;
    PRAGMA user_version=4;`);
  database.close();
  await directoryCheckpointBackend(upgraded).write('from-files', checkpoint);
  const file = join(upgraded, '.pyric', 'state', 'checkpoints', 'from-files.json');
  assert.ok(existsSync(file));

  const host = await open(upgraded);
  try {
    assert.deepEqual((await listCheckpoints(host.persistence.checkpoints)).map(entry => entry.name), ['from-files']);
    await restoreNamedCheckpoint(host.persistence.checkpoints, 'from-files', host.sandbox);
    const blob = await host.persistence.storage.getBlob('media/old.wav', bucket);
    assert.ok(Buffer.from(await blob!.arrayBuffer()).equals(Buffer.from(take)));
    assert.ok(existsSync(objectFile(upgraded, sha256(take))));
  } finally { host.close(); }
  assert.ok(existsSync(file), 'the checkpoint file is left in place');
}

console.log('Checkpoints passed');
