import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  // 2. Append the bytes, each from where the upload has reached
  const res1 = await storage.appendUpload(uploadId, 0, part1);
  assert.equal(res1.received, part1.length);

  const res2 = await storage.appendUpload(uploadId, part1.length, part2);
  assert.equal(res2.received, totalSize);

  // Object still must NOT exist
  assert.equal(await storage.getBlob(path), undefined);

  // 3. The staged bytes come back whole and in part order; reading them does
  //    not create the object, which the engine writes with its own metadata.
  const staged = await storage.readUpload(uploadId);
  assert.deepEqual(new Uint8Array(await staged.arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  assert.equal(await storage.getBlob(path), undefined);
  const metadata = {
    bucket: 'test-bucket', fullPath: path, name: 'audio.wav', size: totalSize, generation: '1', metageneration: '1',
    timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'audio/wav',
  };
  await storage.put(path, staged, metadata);
  await storage.abortUpload(uploadId);
  await assert.rejects(storage.readUpload(uploadId), /not found/);

  // 4. Stored object is now visible and complete
  const finishedBlob = await storage.getBlob(path);
  assert.ok(finishedBlob);
  assert.equal(finishedBlob.size, totalSize);
  const bytes = new Uint8Array(await finishedBlob.arrayBuffer());
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));

  // 5. The object's file, which the byte route reads ranges from
  const stored = await storage.objectFile('test-bucket', path);
  assert.ok(stored);
  assert.equal(stored.size, totalSize);
  assert.equal(stored.mime, 'audio/wav');
  assert.deepEqual(new Uint8Array(readFileSync(stored.file)), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));

  // 6. Abort upload test
  const abortUploadId = await storage.beginUpload('test-bucket', 'temp.bin', 100);
  await storage.appendUpload(abortUploadId, 0, new Uint8Array([10, 20]));
  await storage.abortUpload(abortUploadId);

  // An aborted upload has nothing left to read
  await assert.rejects(storage.readUpload(abortUploadId), /not found/);
} finally {
  database.close();
}

console.log('Storage chunked passed');
