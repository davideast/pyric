import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';

const root = process.argv[2];

/** Compares bytes without asking assert to render a diff of megabytes on failure. */
function assertSameBytes(actual: Uint8Array | undefined, expected: Uint8Array, message: string): void {
  const same = actual !== undefined && Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
  assert.ok(same, `${message}: ${actual?.byteLength ?? 'no'} bytes differ from the expected ${expected.byteLength}`);
}

const MiB = 1024 * 1024;
const bucket = 'pyric-default';
const metadata = (fullPath: string, size: number) => ({
  bucket, fullPath, name: fullPath.slice(fullPath.lastIndexOf('/') + 1), size, generation: '1', metageneration: '1',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'application/octet-stream',
});
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const objectFile = (project: string, hash: string): string => join(hostedStateDirectory(project), 'objects', hash.slice(0, 2), hash);

function columns(project: string): string[] {
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'), { readOnly: true });
  try { return database.prepare('PRAGMA table_info(storage_objects)').all().map(row => String(row.name)); }
  finally { database.close(); }
}

function row(project: string, path: string): { sha256: string; size: number } | undefined {
  const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'), { readOnly: true });
  try {
    const found = database.prepare('SELECT sha256, size FROM storage_objects WHERE bucket=? AND path=?').get(bucket, path);
    return found === undefined ? undefined : { sha256: String(found.sha256), size: Number(found.size) };
  } finally { database.close(); }
}

// A new store names each object's bytes by hash and keeps them out of SQLite.
const project = join(root, 'project');
{
  const persistence = await createHostedPersistence(project);
  persistence.close();
  const names = columns(project);
  assert.ok(names.includes('sha256') && names.includes('size'), `columns: ${names.join(', ')}`);
  assert.equal(names.includes('bytes'), false);
  // Opening a store creates no object directory; the first write does.
  assert.equal(existsSync(join(hostedStateDirectory(project), 'objects')), false);
}

// An object's bytes are one file named by their SHA-256; the row records the hash and size.
const bytes = new Uint8Array(3 * MiB).map((_, index) => (index * 31) % 251);
{
  const persistence = await createHostedPersistence(project);
  try {
    await persistence.storage.put('media/a.bin', new Blob([bytes]), metadata('media/a.bin', bytes.byteLength));
    await persistence.storage.put('media/copy.bin', new Blob([bytes]), metadata('media/copy.bin', bytes.byteLength));
  } finally { persistence.close(); }
  const hash = sha256(bytes);
  assert.deepEqual(row(project, 'media/a.bin'), { sha256: hash, size: bytes.byteLength });
  assertSameBytes(readFileSync(objectFile(project, hash)), bytes, 'object file');
  // Identical bytes are stored once.
  assert.deepEqual(row(project, 'media/copy.bin'), { sha256: hash, size: bytes.byteLength });
  assert.deepEqual(readdirSync(join(hostedStateDirectory(project), 'objects', hash.slice(0, 2))), [hash]);
  // No temporary file outlives a completed write.
  const staging = join(hostedStateDirectory(project), 'objects', '.staging');
  assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], []);
}

// Reads come from the file: a whole object, and the file itself for the byte route.
{
  const persistence = await createHostedPersistence(project);
  try {
    const blob = await persistence.storage.getBlob('media/a.bin', bucket);
    assertSameBytes(new Uint8Array(await blob!.arrayBuffer()), bytes, 'whole object');
    const stored = await persistence.storage.objectFile(bucket, 'media/a.bin');
    assert.equal(stored?.file, objectFile(project, sha256(bytes)));
    assert.equal(stored?.size, bytes.byteLength);
  } finally { persistence.close(); }
}

// Finding an object's file costs nothing of the object. The object here is a
// 400 MiB sparse file, so reading it whole would add hundreds of MiB of resident memory.
{
  const large = join(root, 'large');
  const persistence = await createHostedPersistence(large);
  await persistence.storage.put('media/seed.bin', new Blob([new Uint8Array(8)]), metadata('media/seed.bin', 8));
  persistence.close();
  const size = 400 * MiB;
  const fakeHash = 'c'.repeat(64);
  mkdirSync(join(hostedStateDirectory(large), 'objects', 'cc'), { recursive: true });
  const file = objectFile(large, fakeHash);
  writeFileSync(file, '');
  truncateSync(file, size);
  const marker = new TextEncoder().encode('positional');
  const descriptor = openSync(file, 'r+');
  try { writeSync(descriptor, marker, 0, marker.byteLength, 300 * MiB); } finally { closeSync(descriptor); }
  const database = new DatabaseSync(join(hostedStateDirectory(large), 'state.sqlite'));
  database.prepare('UPDATE storage_objects SET sha256=?, size=?, metadata=? WHERE bucket=? AND path=?')
    .run(fakeHash, size, JSON.stringify(metadata('media/seed.bin', size)), bucket, 'media/seed.bin');
  database.close();
  const opened = await createHostedPersistence(large);
  try {
    const rssBefore = process.memoryUsage().rss;
    for (let read = 0; read < 8; read++) {
      const stored = await opened.storage.objectFile(bucket, 'media/seed.bin');
      assert.equal(stored?.size, size);
      const found = openSync(stored!.file, 'r');
      const range = new Uint8Array(marker.byteLength);
      try { readSync(found, range, 0, range.byteLength, 300 * MiB); } finally { closeSync(found); }
      assert.deepEqual(range, marker);
    }
    const growth = process.memoryUsage().rss - rssBefore;
    assert.ok(growth < 64 * MiB, `reads from the object's file grew rss by ${(growth / MiB).toFixed(1)} MiB`);
  } finally { opened.close(); }
}

// A write whose bytes cannot be made durable commits no row.
{
  const failing = join(root, 'failing');
  const persistence = await createHostedPersistence(failing);
  try {
    const objects = join(hostedStateDirectory(failing), 'objects');
    rmSync(objects, { recursive: true, force: true });
    writeFileSync(objects, 'not a directory');
    await assert.rejects(persistence.storage.put('media/lost.bin', new Blob([bytes]), metadata('media/lost.bin', bytes.byteLength)));
    assert.equal(await persistence.storage.getMetadata('media/lost.bin', bucket), undefined);
    assert.equal(persistence.status().state, 'healthy');
  } finally { persistence.close(); }
  assert.equal(row(failing, 'media/lost.bin'), undefined);
}

// A row whose file is missing refuses startup instead of serving an object without bytes.
{
  const missing = join(root, 'missing');
  const persistence = await createHostedPersistence(missing);
  await persistence.storage.put('media/a.bin', new Blob([bytes]), metadata('media/a.bin', bytes.byteLength));
  persistence.close();
  rmSync(objectFile(missing, sha256(bytes)));
  await assert.rejects(createHostedPersistence(missing), /Hosted state could not be restored/);
}

// A hash that is not a SHA-256 hex digest never becomes a file path, even when
// the path it spells holds a file of the right size outside the store.
{
  const escaping = join(root, 'escaping');
  const persistence = await createHostedPersistence(escaping);
  await persistence.storage.put('media/a.bin', new Blob([bytes]), metadata('media/a.bin', bytes.byteLength));
  persistence.close();
  writeFileSync(join(hostedStateDirectory(escaping), '..', 'decoy'), bytes);
  const database = new DatabaseSync(join(hostedStateDirectory(escaping), 'state.sqlite'));
  // objects/ + '..' + '../decoy' resolves beside the hosted directory.
  database.prepare('UPDATE storage_objects SET sha256=? WHERE bucket=? AND path=?').run('../decoy', bucket, 'media/a.bin');
  database.close();
  await assert.rejects(createHostedPersistence(escaping), /Hosted state could not be restored/);
}

console.log('Blob store passed');
