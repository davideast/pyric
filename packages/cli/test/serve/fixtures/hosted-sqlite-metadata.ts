import assert from 'node:assert/strict';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const database = await openHostedDatabase(process.argv[2]);
const base = { bucket: 'files', fullPath: 'same', name: 'same', size: 3, generation: '1', metageneration: '1',
  timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', contentType: 'text/plain' };
try {
  await database.storage.put('same', new Blob(['old']), base);
  const stale = await database.storage.getMetadata('same', 'files');
  assert.ok(stale);
  await database.storage.put('same', new Blob(['new']), { ...base, generation: '2', contentType: 'application/octet-stream' });
  await assert.rejects(database.storage.putMetadata('same', { ...stale, metageneration: '2', cacheControl: 'no-cache' }, 'files'), /changed while updating metadata/);
  assert.equal((await database.storage.getMetadata('same', 'files'))?.generation, '2');
  assert.equal((await database.storage.getMetadata('same', 'files'))?.contentType, 'application/octet-stream');
  assert.equal(await (await database.storage.getBlob('same', 'files'))?.text(), 'new');
  assert.equal(database.status().state, 'healthy');
} finally { database.close(); }
console.log('Metadata concurrency passed');
