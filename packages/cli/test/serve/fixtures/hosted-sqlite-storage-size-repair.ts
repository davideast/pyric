import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';
import { MAX_STORAGE_OBJECT_BYTES } from '../../../src/serve/worker/protocol/storage.js';

const root = process.argv[2];
const path = 'notes/timings.json';
const body = '{"chunk":1}';
const bucket = 'pyric-default';
const hashedPath = 'notes/hashed.json';
const metadata = (size: number, fullPath = path) => ({
  bucket, fullPath, name: fullPath.slice(fullPath.lastIndexOf('/') + 1), size, generation: '7', metageneration: '3',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z', contentType: 'application/json',
});
const hashedMetadata = (size: number, md5Hash: string) => ({ ...metadata(size, hashedPath), md5Hash });
const records = new Map<string, unknown>([
  ['meta', { version: 3, savedAt: 0, services: { auth: { users: [], providers: {} } } }],
  ['00', { docs: { 'notes/kept': { answer: 42 } } }],
]);

function rewriteMetadata(database: Awaited<ReturnType<typeof openHostedDatabase>>, target: string, value: unknown): void {
  const changed = database.connection.prepare('UPDATE storage_objects SET metadata=? WHERE bucket=? AND path=?')
    .run(JSON.stringify(value), bucket, target) as { changes: number | bigint };
  assert.equal(Number(changed.changes), 1);
}

// A recorded size that disagrees with the stored bytes is repaired at startup.
const project = join(root, 'project');
const created = await createHostedPersistence(project);
await created.backend.putRecords('hosted', records);
await created.storage.put(path, new Blob([body], { type: 'application/json' }), metadata(body.length));
await created.storage.put(hashedPath, new Blob([body], { type: 'application/json' }), hashedMetadata(body.length, 'stale'));
created.close();

const directory = hostedStateDirectory(project);
const damage = await openHostedDatabase(directory);
rewriteMetadata(damage, path, metadata(body.length + 7));
rewriteMetadata(damage, hashedPath, hashedMetadata(body.length - 4, 'stale'));
damage.close();

const restored = await createHostedPersistence(project);
try {
  assert.deepEqual([...restored.repairedObjects].sort((left, right) => left.path.localeCompare(right.path)), [
    { bucket, path: hashedPath, recordedSize: body.length - 4, actualSize: body.length },
    { bucket, path, recordedSize: body.length + 7, actualSize: body.length },
  ]);
  const hashed = await restored.storage.getMetadata(hashedPath, bucket);
  assert.equal(hashed?.size, body.length);
  assert.equal(hashed?.md5Hash, createHash('md5').update(body).digest('base64'));
  assert.equal((await restored.storage.getMetadata(path, bucket))?.size, body.length);
  assert.equal(await (await restored.storage.getBlob(path, bucket))?.text(), body);
  assert.deepEqual(await restored.backend.getRecord('hosted', '00'), { docs: { 'notes/kept': { answer: 42 } } });
  assert.equal(restored.status().state, 'healthy');
} finally { restored.close(); }

// The repair survives the process that made it, and leaves the versions alone.
const inspect = await openHostedDatabase(directory);
try {
  const row = inspect.connection.prepare('SELECT metadata, size FROM storage_objects WHERE bucket=? AND path=?').get(bucket, path);
  assert.ok(row);
  assert.equal(row.size, body.length);
  assert.deepEqual(JSON.parse(String(row.metadata)), metadata(body.length));
} finally { inspect.close(); }

const reopened = await createHostedPersistence(project);
try {
  assert.deepEqual(reopened.repairedObjects, []);
  assert.equal((await reopened.storage.getMetadata(path, bucket))?.size, body.length);
} finally { reopened.close(); }

// Salvage recovers the object with repaired metadata and names it in the report.
const damaged = join(root, 'damaged');
const source = await openHostedDatabase(damaged);
await source.records.putRecords('hosted', records);
await source.storage.put(path, new Blob([body], { type: 'application/json' }), metadata(body.length));
rewriteMetadata(source, path, metadata(body.length + 3));
source.close();

const output = join(root, 'recovered');
const report = await salvageHostedState(damaged, output);
assert.deepEqual(report.excluded, []);
assert.equal(report.recoveredObjects, 1);
assert.deepEqual(report.repairedObjects, [{ bucket, path, recordedSize: body.length + 3, actualSize: body.length }]);
assert.deepEqual(JSON.parse(readFileSync(join(output, 'recovery-report.json'), 'utf8')).repairedObjects, report.repairedObjects);
const recovered = await openHostedDatabase(output);
try {
  assert.equal((await recovered.storage.getMetadata(path, bucket))?.size, body.length);
  assert.equal(await (await recovered.storage.getBlob(path, bucket))?.text(), body);
} finally { recovered.close(); }

// Metadata naming a different object is still fatal.
const identity = join(root, 'identity');
const mislabelled = await createHostedPersistence(identity);
await mislabelled.storage.put(path, new Blob([body], { type: 'application/json' }), metadata(body.length));
mislabelled.close();
const relabel = await openHostedDatabase(hostedStateDirectory(identity));
rewriteMetadata(relabel, path, metadata(body.length, 'notes/other.json'));
relabel.close();
await assert.rejects(createHostedPersistence(identity), /Hosted state could not be restored/);

// Storage objects larger than 8 MiB but within MAX_STORAGE_OBJECT_BYTES are retained across restart and salvage.
const largeProject = join(root, 'large-project');
const largePersistence = await createHostedPersistence(largeProject);
const largePath = 'media/narration.wav';
const largeBytes = new Uint8Array(16 * 1024 * 1024);
largeBytes[0] = 1;
largeBytes[largeBytes.length - 1] = 2;
await largePersistence.storage.put(largePath, new Blob([largeBytes], { type: 'audio/wav' }), metadata(largeBytes.byteLength, largePath));

const oversizeBytes = new Uint8Array(MAX_STORAGE_OBJECT_BYTES + 1);

// Direct storage.put rejects objects exceeding MAX_STORAGE_OBJECT_BYTES with quota-exceeded.
await assert.rejects(
  largePersistence.storage.put('too-big.bin', new Blob([oversizeBytes]), metadata(oversizeBytes.byteLength, 'too-big.bin')),
  (err: unknown) => {
    const error = err as { code?: string; message?: string };
    return error.code === 'storage/quota-exceeded' && typeof error.message === 'string' && error.message.includes('MAX_STORAGE_OBJECT_BYTES');
  },
);
largePersistence.close();

const largeRestored = await createHostedPersistence(largeProject);
try {
  assert.equal(largeRestored.status().state, 'healthy');
  const stored = await largeRestored.storage.getMetadata(largePath, bucket);
  assert.equal(stored?.size, largeBytes.byteLength);
  const blob = await largeRestored.storage.getBlob(largePath, bucket);
  assert.equal(blob?.size, largeBytes.byteLength);
} finally {
  largeRestored.close();
}

const largeDamaged = join(root, 'large-damaged');
const largeSource = await openHostedDatabase(largeDamaged);
await largeSource.records.putRecords('hosted', records);
await largeSource.storage.put(largePath, new Blob([largeBytes], { type: 'audio/wav' }), metadata(largeBytes.byteLength, largePath));
largeSource.close();

const largeOutput = join(root, 'large-recovered');
const largeReport = await salvageHostedState(largeDamaged, largeOutput);
assert.deepEqual(largeReport.excluded, []);
assert.equal(largeReport.recoveredObjects, 1);
const largeRecovered = await openHostedDatabase(largeOutput);
try {
  assert.equal((await largeRecovered.storage.getMetadata(largePath, bucket))?.size, largeBytes.byteLength);
} finally {
  largeRecovered.close();
}

// The size limit judges the bytes stored, whatever size the metadata records, against MAX_STORAGE_OBJECT_BYTES.
const oversize = join(root, 'oversize');
const small = await createHostedPersistence(oversize);
await small.storage.put(path, new Blob([body], { type: 'application/json' }), metadata(body.length));
small.close();
const oversizeHash = 'd'.repeat(64);
const oversizeShard = join(hostedStateDirectory(oversize), 'objects', 'dd');
mkdirSync(oversizeShard, { recursive: true });
writeFileSync(join(oversizeShard, oversizeHash), '');
truncateSync(join(oversizeShard, oversizeHash), MAX_STORAGE_OBJECT_BYTES + 1);
const enlarge = await openHostedDatabase(hostedStateDirectory(oversize));
enlarge.connection.prepare('UPDATE storage_objects SET sha256=?, size=? WHERE bucket=? AND path=?').run(oversizeHash, MAX_STORAGE_OBJECT_BYTES + 1, bucket, path);
enlarge.close();
await assert.rejects(createHostedPersistence(oversize), /Hosted state could not be restored/);

console.log('Storage size repair passed');
