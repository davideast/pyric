import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';
import { createBlobStore } from '../../../src/serve/hosted/persistence/blob-store.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';

const root = process.argv[2];
const bucket = 'pyric-default';
const HOUR = 3600_000;
const metadata = (fullPath: string, size: number) => ({
  bucket, fullPath, name: fullPath.slice(fullPath.lastIndexOf('/') + 1), size, generation: '1', metageneration: '1',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'application/octet-stream',
});
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const objects = (project: string): string => join(hostedStateDirectory(project), 'objects');
const objectFile = (project: string, bytes: Uint8Array): string => {
  const hash = sha256(bytes);
  return join(objects(project), hash.slice(0, 2), hash);
};
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Every object file, as `<ab>/<sha256>`. */
function objectFiles(project: string): string[] {
  const directory = objects(project);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name !== '.staging').flatMap(shard => readdirSync(join(directory, shard)).map(name => `${shard}/${name}`)).sort();
}

/** Make every object file look as old as a file from an earlier session. */
function age(project: string): void {
  const past = new Date(Date.now() - HOUR);
  for (const file of objectFiles(project)) utimesSync(join(objects(project), file), past, past);
}

async function put(persistence: Awaited<ReturnType<typeof createHostedPersistence>>, path: string, bytes: Uint8Array): Promise<void> {
  await persistence.storage.put(path, new Blob([bytes]), metadata(path, bytes.byteLength));
}

const kept = bytesOf('kept');
const replaced = bytesOf('replaced');
const replacement = bytesOf('replacement');
const deleted = bytesOf('deleted');
const shared = bytesOf('shared by two paths');

// Replacing and deleting objects leaves their files; the next start removes the
// files no row names, and keeps every file a row names.
const project = join(root, 'project');
{
  const persistence = await createHostedPersistence(project);
  await persistence.sweep;
  await put(persistence, 'notes/kept.txt', kept);
  await put(persistence, 'notes/replaced.txt', replaced);
  await put(persistence, 'notes/replaced.txt', replacement);
  await put(persistence, 'notes/deleted.txt', deleted);
  await persistence.storage.delete('notes/deleted.txt', bucket);
  await put(persistence, 'notes/shared-a.txt', shared);
  await put(persistence, 'notes/shared-b.txt', shared);
  await persistence.storage.delete('notes/shared-a.txt', bucket);
  persistence.close();
  assert.equal(objectFiles(project).length, 5, 'deleting and replacing objects removes no file');
  age(project);

  const restarted = await createHostedPersistence(project);
  try {
    // The sweep runs after startup and does not delay a read.
    const order: string[] = [];
    const sweeping = restarted.sweep.then(report => { order.push('sweep'); return report; });
    await restarted.storage.getMetadata('notes/kept.txt', bucket).then(() => order.push('read'));
    const report = await sweeping;
    assert.deepEqual(order, ['read', 'sweep']);
    assert.equal(report.removed, 2);
    assert.equal(report.bytesRemoved, replaced.byteLength + deleted.byteLength);
    assert.equal(existsSync(objectFile(project, replaced)), false);
    assert.equal(existsSync(objectFile(project, deleted)), false);
    for (const bytes of [kept, replacement, shared]) assert.ok(existsSync(objectFile(project, bytes)));
    assert.equal(await (await restarted.storage.getBlob('notes/shared-b.txt', bucket))?.text(), 'shared by two paths');
  } finally { restarted.close(); }
}

// A file modified after the sweep began, or moments before it, is never removed,
// even when no row names it yet.
{
  const fresh = bytesOf('written while the sweep ran');
  const file = objectFile(project, fresh);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, fresh);
  const persistence = await createHostedPersistence(project);
  try {
    const report = await persistence.sweep;
    assert.equal(report.removed, 0);
    assert.ok(existsSync(file));
  } finally { persistence.close(); }
}

// Finishing an upload whose parts were written long ago gives its file a fresh
// modification time, so a sweep that began before the row commits cannot remove it.
{
  const persistence = await createHostedPersistence(project);
  try {
    await persistence.sweep;
    const bytes = bytesOf('staged a while ago');
    const uploadId = await persistence.storage.beginUpload(bucket, 'notes/slow.txt', bytes.byteLength, 'text/plain');
    await persistence.storage.putPart(uploadId, 0, bytes);
    const staged = join(objects(project), '.staging', uploadId);
    const past = new Date(Date.now() - HOUR);
    utimesSync(staged, past, past);
    const blob = await persistence.storage.readUpload(uploadId);
    await persistence.storage.put('notes/slow.txt', blob, { ...metadata('notes/slow.txt', bytes.byteLength), contentType: 'text/plain' });
    assert.ok(Date.now() - statSync(objectFile(project, bytes)).mtimeMs < 60_000, 'the adopted file was touched');
  } finally { persistence.close(); }
}

// The sweep removes only files it named: a staged upload, a file in a shard
// that is not named by a hash, and entries beside the shards are never candidates.
{
  const directory = join(root, 'strays');
  const store = createBlobStore(directory);
  const staged = store.stage('in-progress');
  staged.append(bytesOf('part'));
  const orphan = bytesOf('orphan');
  store.write(orphan);
  const orphanFile = store.path(sha256(orphan));
  const stray = join(directory, sha256(orphan).slice(0, 2), 'notes.txt');
  writeFileSync(stray, 'not an object');
  // Finder writes this beside the shards; it is a file, not a shard directory.
  writeFileSync(join(directory, '.DS_Store'), '');
  const past = new Date(Date.now() - HOUR);
  for (const file of [staged.path, orphanFile, stray]) utimesSync(file, past, past);
  const report = await store.sweep(new Set(), Date.now());
  assert.equal(report.removed, 1);
  assert.equal(existsSync(orphanFile), false);
  for (const file of [staged.path, stray, join(directory, '.DS_Store')]) assert.ok(existsSync(file), file);
}

// Closing the host stops a sweep between shard directories, without failing it.
{
  const stopping = join(root, 'stopping');
  (await createHostedPersistence(stopping)).close();
  const orphans = Array.from({ length: 16 }, (_, index) => bytesOf(`orphan ${index}`));
  const shards = new Set(orphans.map(bytes => sha256(bytes).slice(0, 2)));
  assert.equal(shards.size, orphans.length, 'each orphan is in its own shard');
  for (const bytes of orphans) {
    const file = objectFile(stopping, bytes);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, bytes);
  }
  age(stopping);
  const persistence = await createHostedPersistence(stopping);
  // The sweep starts on the next turn and yields after its first shard; close then.
  await new Promise(resolve => setImmediate(resolve));
  persistence.close();
  const report = await persistence.sweep;
  const remaining = orphans.filter(bytes => existsSync(objectFile(stopping, bytes))).length;
  assert.ok(report.removed < orphans.length, `the sweep stopped early (removed ${report.removed})`);
  assert.equal(remaining, orphans.length - report.removed);
}

// Salvage leaves out an object whose file does not match its hash, copies the
// file to quarantine/, and names it in the report.
{
  const damaged = join(root, 'damaged');
  const persistence = await createHostedPersistence(damaged);
  await persistence.backend.putRecords('hosted', new Map<string, unknown>([
    ['meta', { version: 3, savedAt: 0, services: {} }],
    ['00', { docs: { 'notes/kept': { answer: 42 } } }],
  ]));
  await put(persistence, 'notes/good.txt', kept);
  await put(persistence, 'notes/rotted.txt', replaced);
  persistence.close();
  const rotted = objectFile(damaged, replaced);
  const flipped = Uint8Array.from(replaced);
  flipped[0] ^= 0xff;
  writeFileSync(rotted, flipped);
  const output = join(root, 'recovered');
  const report = await salvageHostedState(hostedStateDirectory(damaged), output);
  assert.equal(report.recoveredObjects, 1);
  const hash = sha256(replaced);
  assert.deepEqual(report.quarantined, [{ bucket, path: 'notes/rotted.txt', sha256: hash, file: `quarantine/${hash}` }]);
  assert.deepEqual(report.excluded, [{ namespace: 'storage', id: `${bucket}/notes/rotted.txt`, reason: 'Object bytes do not match their hash; the file was copied to quarantine' }]);
  assert.deepEqual(new Uint8Array(readFileSync(join(output, 'quarantine', hash))), flipped);
  assert.deepEqual(new Uint8Array(readFileSync(rotted)), flipped, 'the source is unchanged');
  const written = JSON.parse(readFileSync(join(output, 'recovery-report.json'), 'utf8'));
  assert.deepEqual(written.quarantined, report.quarantined);
}

console.log('Object sweep passed');
