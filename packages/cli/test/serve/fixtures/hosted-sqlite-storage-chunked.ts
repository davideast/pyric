import assert from 'node:assert/strict';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
let database = await openHostedDatabase(directory);

try {
  const storage = database.storage.scoped('test-bucket');
  const path = 'media/audio.wav';
  const part1 = new Uint8Array([1, 2, 3, 4]);
  const part2 = new Uint8Array([5, 6, 7, 8, 9]);
  const totalSize = part1.length + part2.length;

  // 1. Begin upload
  const uploadId = await storage.beginUpload('test-bucket', path, totalSize, 'audio/wav', { custom: 'tag' });
  assert.ok(typeof uploadId === 'string' && uploadId.length > 0);

  // Before finishUpload, object must NOT exist in storage
  const initialBlob = await storage.getBlob(path);
  assert.equal(initialBlob, undefined);

  // 2. Put parts
  const res1 = await storage.putPart(uploadId, 0, part1);
  assert.equal(res1.bytesReceived, part1.length);

  const res2 = await storage.putPart(uploadId, 1, part2);
  assert.equal(res2.bytesReceived, totalSize);

  // Object still must NOT exist
  assert.equal(await storage.getBlob(path), undefined);

  // 3. The staged bytes come back whole and in part order; reading them does
  //    not create the object, which the engine writes with its own metadata.
  const staged = await storage.readUpload(uploadId);
  assert.deepEqual(staged, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  assert.equal(await storage.getBlob(path), undefined);
  const metadata = {
    bucket: 'test-bucket', fullPath: path, name: 'audio.wav', size: totalSize, generation: '1', metageneration: '1',
    timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'audio/wav',
  };
  await storage.put(path, new Blob([staged], { type: 'audio/wav' }), metadata);
  await storage.abortUpload(uploadId);
  await assert.rejects(storage.readUpload(uploadId), /not found/);

  // 4. Stored object is now visible and complete
  const finishedBlob = await storage.getBlob(path);
  assert.ok(finishedBlob);
  assert.equal(finishedBlob.size, totalSize);
  const bytes = new Uint8Array(await finishedBlob.arrayBuffer());
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));

  // 5. Ranged reads via readRange
  const slice1 = await storage.readRange('test-bucket', path, 0, 4, metadata.generation);
  assert.ok(slice1);
  assert.deepEqual(slice1, part1);

  const slice2 = await storage.readRange('test-bucket', path, 4, 5, metadata.generation);
  assert.ok(slice2);
  assert.deepEqual(slice2, part2);

  // Mismatched generation refuses read with storage/object-changed
  let caughtError: unknown = null;
  try {
    await storage.readRange('test-bucket', path, 0, 4, 'stale-generation-999');
  } catch (err) {
    caughtError = err;
  }
  assert.ok(caughtError);

  // 6. Abort upload test
  const abortUploadId = await storage.beginUpload('test-bucket', 'temp.bin', 100);
  await storage.putPart(abortUploadId, 0, new Uint8Array([10, 20]));
  await storage.abortUpload(abortUploadId);

  // An aborted upload has nothing left to read
  await assert.rejects(storage.readUpload(abortUploadId), /not found/);
} finally {
  database.close();
}

console.log('Storage chunked passed');
