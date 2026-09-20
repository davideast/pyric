import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';

for (const entry of ['seed', 'section'] as const) {
  const project = join(process.argv[2], entry);
  let persistence = await createHostedPersistence(project);
  const metadata = { bucket: 'files', fullPath: 'notes/one', name: 'one', size: 3,
    generation: '1', metageneration: '1', timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
  const uploadedBytes = Promise.withResolvers<void>();
  class PendingBlob extends Blob {
    override async arrayBuffer() {
      await uploadedBytes.promise;
      return super.arrayBuffer();
    }
  }
  const upload = persistence.storage.put(metadata.fullPath, new PendingBlob(['old']), metadata);
  const objects = [{ dataBase64: Buffer.from('new').toString('base64'), blobType: '', metadata }];
  let seeded = false;
  const seed = Promise.resolve(entry === 'seed'
    ? persistence.seed({ version: 1, firestore: null, auth: null, storage: objects })
    : persistence.state.writeSection('storage', objects)).then(() => { seeded = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(seeded, false, `${entry} must await the preceding upload`);
    uploadedBytes.resolve();
    await Promise.all([upload, seed]);
    assert.equal(await (await persistence.storage.getBlob(metadata.fullPath, 'files'))?.text(), 'new',
      'the older upload must not overwrite the later seed');
  } finally {
    uploadedBytes.resolve();
    await Promise.allSettled([upload, seed]);
    persistence.close();
  }
  persistence = await createHostedPersistence(project);
  try {
    assert.equal(await (await persistence.storage.getBlob(metadata.fullPath, 'files'))?.text(), 'new');
    assert.deepEqual(await persistence.storage.getMetadata(metadata.fullPath, 'files'), metadata);
  } finally { persistence.close(); }
}
console.log('Seed ordering passed');
