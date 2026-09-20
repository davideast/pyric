import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';

const project = process.argv[2];
const persistence = await createHostedPersistence(project);
try {
  const faults = new DatabaseSync(join(project, '.pyric/state/hosted/state.sqlite'));
  try { faults.exec("CREATE TRIGGER fail_storage BEFORE INSERT ON storage_objects BEGIN SELECT RAISE(ABORT, 'injected failure'); END"); }
  finally { faults.close(); }
  const metadata = { bucket: 'first', fullPath: 'file', name: 'file', size: 1,
    generation: '1', metageneration: '1', timeCreated: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
  await assert.rejects(persistence.storage.put('file', new Blob(['a']), metadata), /persistence transaction failed/);
  assert.equal(persistence.status().state, 'unhealthy');
  await assert.rejects(persistence.backend.putRecords('hosted', new Map([['meta', {}]])), /unhealthy/);
  assert.equal(await persistence.backend.getRecord('hosted', 'meta'), null);
  assert.equal(await persistence.storage.getBlob('file', 'first'), undefined);
} finally { persistence.close(); }
console.log('Health passed');
