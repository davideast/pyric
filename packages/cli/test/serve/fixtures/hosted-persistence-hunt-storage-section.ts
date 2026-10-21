import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';

const root = process.argv[2];

function makeMetadata(bucket: string, fullPath: string, size: number, contentType = 'text/plain') {
  const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
  return {
    fullPath,
    name,
    bucket,
    generation: '1',
    metageneration: '1',
    timeCreated: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    size,
    contentType,
  };
}

// 1. writeSection('storage', []) deletes all existing objects across buckets.
{
  const project = join(root, 'clear-all');
  const persistence = await createHostedPersistence(project);
  try {
    await persistence.storage.put(
      'docs/readme.txt',
      new Blob(['hello-storage'], { type: 'text/plain' }),
      makeMetadata('pyric-default', 'docs/readme.txt', 13),
    );
    await persistence.storage.put(
      'assets/banner.txt',
      new Blob(['other-bucket'], { type: 'text/plain' }),
      makeMetadata('secondary-bucket', 'assets/banner.txt', 12),
    );
    assert.equal((persistence.state.readSection('storage') as unknown[]).length, 2);

    await persistence.state.writeSection('storage', []);
    assert.deepEqual(persistence.state.readSection('storage'), []);
    assert.equal(await persistence.storage.getMetadata('docs/readme.txt', 'pyric-default'), undefined);
    assert.equal(await persistence.storage.getMetadata('assets/banner.txt', 'secondary-bucket'), undefined);
  } finally {
    persistence.close();
  }

  const reopened = await createHostedPersistence(project);
  try {
    assert.deepEqual(reopened.state.readSection('storage'), []);
  } finally {
    reopened.close();
  }
}

// 2. writeSection('storage', [subset]) removes omitted objects and rolls back on invalid input.
{
  const project = join(root, 'replace-subset');
  const persistence = await createHostedPersistence(project);
  try {
    const keepBytes = Buffer.from('keep-me');
    const dropBytes = Buffer.from('drop-me-later');
    await persistence.state.writeSection('storage', [
      {
        dataBase64: keepBytes.toString('base64'),
        blobType: 'text/plain',
        metadata: makeMetadata('pyric-default', 'notes/keep.txt', keepBytes.length),
      },
      {
        dataBase64: dropBytes.toString('base64'),
        blobType: 'text/plain',
        metadata: makeMetadata('secondary-bucket', 'notes/drop.txt', dropBytes.length),
      },
    ]);
    assert.equal((persistence.state.readSection('storage') as unknown[]).length, 2);

    const replacementBytes = Buffer.from('updated-keep');
    await persistence.state.writeSection('storage', [
      {
        dataBase64: replacementBytes.toString('base64'),
        blobType: 'text/plain',
        metadata: makeMetadata('pyric-default', 'notes/keep.txt', replacementBytes.length),
      },
    ]);
    const remaining = persistence.state.readSection('storage') as Array<{ metadata: { bucket: string; fullPath: string } }>;
    assert.deepEqual(remaining.map(item => `${item.metadata.bucket}/${item.metadata.fullPath}`), ['pyric-default/notes/keep.txt']);
    assert.equal(await persistence.storage.getMetadata('notes/drop.txt', 'secondary-bucket'), undefined);
    assert.equal(await (await persistence.storage.getBlob('notes/keep.txt', 'pyric-default'))?.text(), 'updated-keep');

    // A rejected writeSection('storage', ...) rolls back without losing 'notes/keep.txt'.
    await assert.rejects(
      Promise.resolve(persistence.state.writeSection('storage', [
        {
          dataBase64: 'not valid base64!',
          blobType: 'text/plain',
          metadata: makeMetadata('pyric-default', 'notes/broken.txt', 3),
        },
      ])),
      /base64/,
    );
    assert.equal(await (await persistence.storage.getBlob('notes/keep.txt', 'pyric-default'))?.text(), 'updated-keep');
  } finally {
    persistence.close();
  }
}

console.log('Storage section replacement passed');
