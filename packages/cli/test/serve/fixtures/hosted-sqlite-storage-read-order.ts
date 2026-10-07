import assert from 'node:assert/strict';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';

const database = await openHostedDatabase(process.argv[2]);
const metadata = { bucket: 'files', fullPath: 'notes/one', name: 'one', size: 3,
  generation: '1', metageneration: '1', timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
const storage = database.storage.scoped('files');
try {
  // Upload enters through one view; reads through another share its queue.
  const upload = database.storage.put(metadata.fullPath, new Blob(['new']), metadata);
  const bytes = storage.getBlob(metadata.fullPath);
  const details = storage.getMetadata(metadata.fullPath);
  const listing = storage.listByPrefix('notes/');
  const object = storage.getObject(metadata.fullPath);
  await upload;
  assert.equal(await (await bytes)?.text(), 'new');
  assert.deepEqual(await details, metadata);
  assert.deepEqual(await listing, [metadata]);
  const pair = await object;
  assert.equal(await pair?.blob.text(), 'new');
  assert.deepEqual(pair?.metadata, metadata);

  // An overwrite queued behind a capture's listing is read as one pair.
  const longer = { ...metadata, size: 6, generation: '2' };
  const listed = storage.listByPrefix('notes/');
  const overwrite = storage.put(metadata.fullPath, new Blob(['longer']), longer);
  const overwritten = storage.getObject(metadata.fullPath);
  assert.deepEqual(await listed, [metadata]);
  await overwrite;
  const overwrittenPair = await overwritten;
  assert.equal(await overwrittenPair?.blob.text(), 'longer');
  assert.deepEqual(overwrittenPair?.metadata, longer);
  await storage.put(metadata.fullPath, new Blob(['new']), metadata);

  const deletion = storage.delete(metadata.fullPath);
  const deletedBytes = storage.getBlob(metadata.fullPath);
  const deletedDetails = storage.getMetadata(metadata.fullPath);
  const deletedListing = storage.listByPrefix('notes/');
  await deletion;
  assert.equal(await deletedBytes, undefined);
  assert.equal(await deletedDetails, undefined);
  assert.deepEqual(await deletedListing, []);

  await storage.put(metadata.fullPath, new Blob(['new']), metadata);
  const reset = storage.reset();
  const resetBytes = storage.getBlob(metadata.fullPath);
  const resetListing = storage.listByPrefix('notes/');
  await reset;
  assert.equal(await resetBytes, undefined);
  assert.deepEqual(await resetListing, []);
} finally { database.close(); }
console.log('Storage read order passed');
