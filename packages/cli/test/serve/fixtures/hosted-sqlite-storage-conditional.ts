import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

// Generation-checked writes on the Node host's SQLite store: `put` returns the
// object it replaced, and `deleteIfGeneration` / `replaceIfGeneration` check and
// write in one queued mutation, so a write issued meanwhile is kept.
const directory = process.argv[2];
const path = 'media/clip.bin';
const bucket = 'pyric-default';
const metadataFor = (generation: string, size: number) => ({
  bucket, fullPath: path, name: 'clip.bin', size, generation, metageneration: '1',
  timeCreated: '2030-01-01T00:00:00Z', updated: '2030-01-01T00:00:00Z', contentType: 'application/octet-stream',
});
const bytes = (...values: number[]) => new Blob([new Uint8Array(values)], { type: 'application/octet-stream' });

const database = await openHostedDatabase(directory);
try {
  const storage = database.storage.scoped(bucket);
  const bytesAt = async () => {
    const object = await storage.getObject(path);
    return object === undefined ? undefined : [...new Uint8Array(await object.blob.arrayBuffer())];
  };

  assert.equal(await storage.put(path, bytes(1), metadataFor('1', 1)), undefined);
  const prior = await storage.put(path, bytes(2, 2), metadataFor('2', 2));
  assert.equal(prior?.metadata.generation, '1');
  assert.deepEqual([...new Uint8Array(await prior!.blob.arrayBuffer())], [1]);

  // A restore over another generation is refused; over its own it puts the prior object back.
  assert.equal(await storage.replaceIfGeneration(path, '1', prior), false);
  assert.deepEqual(await bytesAt(), [2, 2]);
  assert.equal(await storage.replaceIfGeneration(path, '2', prior), true);
  assert.deepEqual(await bytesAt(), [1]);
  assert.equal((await storage.getMetadata(path))?.generation, '1');

  // A delete over another generation is refused; over its own it deletes.
  assert.equal(await storage.deleteIfGeneration(path, '2'), false);
  assert.equal(await storage.deleteIfGeneration(path, '1'), true);
  assert.equal(await bytesAt(), undefined);

  // A write issued while a delete or a restore is checking is kept.
  await storage.put(path, bytes(1), metadataFor('3', 1));
  await Promise.all([storage.deleteIfGeneration(path, '3'), storage.put(path, bytes(5, 5), metadataFor('4', 2))]);
  assert.deepEqual(await bytesAt(), [5, 5]);
  const replaced = await storage.put(path, bytes(6), metadataFor('5', 1));
  await Promise.all([storage.replaceIfGeneration(path, '5', replaced), storage.put(path, bytes(7, 7), metadataFor('6', 2))]);
  assert.deepEqual(await bytesAt(), [7, 7]);

  // A write issued before a delete is not deleted by it.
  await storage.put(path, bytes(3), metadataFor('13', 1));
  const writing = storage.put(path, bytes(4, 4), metadataFor('14', 2));
  const deleting = storage.deleteIfGeneration(path, '13');
  await writing;
  assert.equal(await deleting, false);
  assert.deepEqual(await bytesAt(), [4, 4]);

  // Concurrent writes each get the object they replaced.
  const [first, second] = await Promise.all([
    storage.put(path, bytes(1), metadataFor('15', 1)),
    storage.put(path, bytes(2), metadataFor('16', 1)),
  ]);
  assert.equal(first?.metadata.generation, '14');
  assert.equal(second?.metadata.generation, '15');
  assert.equal(await storage.replaceIfGeneration(path, '16', { blob: bytes(7, 7), metadata: metadataFor('6', 2) }), true);

  // A prior object for another path is refused.
  const elsewhere = { blob: bytes(8), metadata: { ...metadataFor('0', 1), fullPath: 'media/other.bin' } };
  await assert.rejects(storage.replaceIfGeneration(path, '6', elsewhere), /its own bucket and path/);

  // A row whose file is gone is overwritten, and gives back no replaced object.
  const broken = await storage.objectFile(bucket, path);
  rmSync(broken!.file);
  assert.equal(await storage.put(path, bytes(9, 9, 9), metadataFor('17', 3)), undefined);
  assert.deepEqual(await bytesAt(), [9, 9, 9]);
  await storage.put(path, bytes(7, 7), metadataFor('6', 2));

  // A prior object from elsewhere is written from its bytes.
  const foreign = { blob: bytes(9, 9, 9), metadata: metadataFor('1', 3) };
  assert.equal(await storage.replaceIfGeneration(path, '6', foreign), true);
  assert.deepEqual(await bytesAt(), [9, 9, 9]);
} finally { database.close(); }
console.log('Storage conditional writes passed');
