import assert from 'node:assert/strict';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const directory = process.argv[2];
const metadata = { bucket: 'first', fullPath: 'a_%/image', name: 'image', size: 4,
  generation: '9', metageneration: '2', timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z', contentType: 'application/octet-stream' };
let database = await openHostedDatabase(directory);
try {
  await database.storage.put(metadata.fullPath, new Blob([new Uint8Array([0, 255, 128, 17])]), metadata);
  await database.storage.put(metadata.fullPath, new Blob(['other']), { ...metadata, bucket: 'second', size: 5 });
} finally { database.close(); }
database = await openHostedDatabase(directory);
try {
  const storage = database.storage.scoped('first');
  const blob = await storage.getBlob(metadata.fullPath);
  assert.ok(blob);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array([0, 255, 128, 17]));
  assert.deepEqual(await storage.getMetadata(metadata.fullPath), metadata);
  assert.equal((await storage.listByPrefix('a_%/')).length, 1);
  assert.equal((await storage.listByPrefix('a__/')).length, 0);
  await storage.delete(metadata.fullPath);
  assert.equal(await storage.getBlob(metadata.fullPath), undefined);
  assert.equal(await database.storage.scoped('second').getBlob(metadata.fullPath).then(blob => blob?.text()), 'other');
} finally { database.close(); }
console.log('Storage restart passed');
