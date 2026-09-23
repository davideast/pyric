import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, installStorageBackend } from 'pyric/storage/internal';
import { ref, uploadBytes } from 'pyric/storage';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';

const root = process.argv[2];
const MiB = 1024 * 1024;
const PART = 4 * MiB;
const bucket = 'pyric-default';

const staging = (project: string): string => join(hostedStateDirectory(project), 'objects', '.staging');
const objectFile = (project: string, sha256: string): string => join(hostedStateDirectory(project), 'objects', sha256.slice(0, 2), sha256);

/** The host's finish: the engine writes the object from the staged upload. */
async function open(project: string) {
  const persistence = await createHostedPersistence(project);
  const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(sandbox, persistence.storage);
  const storage = getAdminStorageSandbox(sandbox);
  async function finish(uploadId: string, path: string, contentType: string) {
    const staged = await persistence.storage.readUpload(uploadId);
    const result = await uploadBytes(ref(storage, path), staged, { contentType });
    await persistence.storage.abortUpload(uploadId);
    return result;
  }
  return { persistence, finish, close() { sandbox.dispose(); persistence.close(); } };
}

// Parts append to one staging file; nothing about the upload is written to SQLite.
const project = join(root, 'project');
{
  const host = await open(project);
  try {
    const parts = [new Uint8Array(PART).fill(1), new Uint8Array(PART).fill(2), new Uint8Array(1000).fill(3)];
    const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const uploadId = await host.persistence.storage.beginUpload(bucket, 'media/take.wav', size, 'audio/wav');
    for (const [index, part] of parts.entries()) await host.persistence.storage.putPart(uploadId, index, part);
    const file = join(staging(project), uploadId);
    assert.equal(statSync(file).size, size);
    const database = new DatabaseSync(join(hostedStateDirectory(project), 'state.sqlite'), { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));
      assert.deepEqual(tables, ['records', 'storage_objects']);
    } finally { database.close(); }

    // Finishing moves the staging file into place: the object file is the same file.
    const inode = statSync(file).ino;
    const result = await host.finish(uploadId, 'media/take.wav', 'audio/wav');
    assert.equal(result.metadata.size, size);
    const hash = createHash('sha256');
    for (const part of parts) hash.update(part);
    const sha256 = hash.digest('hex');
    assert.equal(statSync(objectFile(project, sha256)).ino, inode);
    assert.equal(existsSync(file), false);
    const blob = await host.persistence.storage.getBlob('media/take.wav', bucket);
    assert.equal(blob?.size, size);
    assert.equal(blob?.type, 'audio/wav');
    const tail = await host.persistence.storage.readRange(bucket, 'media/take.wav', 2 * PART, 1000);
    assert.deepEqual(tail, parts[2]);
  } finally { host.close(); }
}

// Parts are accepted only in order and only up to the declared size.
{
  const host = await open(project);
  try {
    const uploadId = await host.persistence.storage.beginUpload(bucket, 'media/order.bin', 10, 'application/octet-stream');
    await assert.rejects(host.persistence.storage.putPart(uploadId, 1, new Uint8Array(5)), /order/);
    await host.persistence.storage.putPart(uploadId, 0, new Uint8Array(5));
    await assert.rejects(host.persistence.storage.putPart(uploadId, 0, new Uint8Array(5)), /order/);
    await assert.rejects(host.persistence.storage.putPart(uploadId, 1, new Uint8Array(6)), /declared size/);
    await assert.rejects(host.persistence.storage.readUpload(uploadId), /declared size/);
    await host.persistence.storage.abortUpload(uploadId);
    assert.equal(existsSync(join(staging(project), uploadId)), false);
    await assert.rejects(host.persistence.storage.readUpload(uploadId), /not found/);
  } finally { host.close(); }
}

// Staging left by a host that stopped is removed when the next one starts.
{
  mkdirSync(staging(project), { recursive: true });
  writeFileSync(join(staging(project), 'left-by-a-stopped-host'), new Uint8Array(1024));
  const host = await open(project);
  host.close();
  assert.deepEqual(readdirSync(staging(project)), []);
}

// Host memory stays flat for an object many parts long: staging writes each
// part to disk, and finishing reads nothing.
{
  const large = join(root, 'large');
  const host = await open(large);
  try {
    const parts = 64;
    const size = parts * PART;
    const part = new Uint8Array(PART);
    const uploadId = await host.persistence.storage.beginUpload(bucket, 'media/long.wav', size, 'audio/wav');
    global.gc?.();
    const rssBefore = process.memoryUsage().rss;
    let peak = rssBefore;
    for (let index = 0; index < parts; index++) {
      part.fill(index);
      await host.persistence.storage.putPart(uploadId, index, part);
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    const result = await host.finish(uploadId, 'media/long.wav', 'audio/wav');
    peak = Math.max(peak, process.memoryUsage().rss);
    assert.equal(result.metadata.size, size);
    const growth = peak - rssBefore;
    assert.ok(growth < 32 * MiB, `a ${size / MiB} MiB upload grew rss by ${(growth / MiB).toFixed(1)} MiB`);
    const slice = await host.persistence.storage.readRange(bucket, 'media/long.wav', 37 * PART, 16);
    assert.deepEqual(slice, new Uint8Array(16).fill(37));
  } finally { host.close(); }
}

console.log('Upload staging passed');
