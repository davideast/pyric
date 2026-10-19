import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { restoreNamedCheckpoint, saveCheckpoint, type Checkpoint } from 'pyric/sandbox/checkpoints';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, installStorageBackend } from 'pyric/storage/internal';
import { deleteObject, ref, uploadBytes } from 'pyric/storage';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';

const root = process.argv[2];
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const objectPath = (dir: string, hash: string): string => join(dir, 'objects', hash.slice(0, 2), hash);

// 1. Salvage recovers valid checkpoints, copies & verifies checkpoint-only object blobs,
//    and excludes corrupt / missing-blob / hash-mismatched checkpoints without losing good state.
{
  const projectDir = join(root, 'damaged-checkpoints');
  const recoveredDir = join(root, 'recovered-checkpoints');

  const keepBlob = new TextEncoder().encode('checkpoint-only-bytes');
  const missingBlob = new TextEncoder().encode('missing-checkpoint-bytes');
  const rottedBlob = new TextEncoder().encode('rotted-checkpoint-bytes');

  const persistence = await createHostedPersistence(projectDir);
  const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(sandbox, persistence.storage);
  const storage = getAdminStorageSandbox(sandbox);
  try {
    await persistence.state.writeSection('auth', {
      users: [{ uid: 'u1', email: 'alice@example.com', emailVerified: false, isAnonymous: false, providerData: [] }],
    });

    // Checkpoint 1: raw checkpoint written directly through checkpoints.write
    await persistence.checkpoints.write('golden-seed', {
      format: 'pyric-checkpoint-v1',
      at: 1700000000000,
      counts: { firestore: 0, database: 0, storage: 0, auth: 0 },
      state: {
        version: 1,
        createdAt: 1700000000000,
        clock: { mode: 'system', currentMs: 1700000000000 },
        auth: { currentUser: null, users: [], providerConfig: {} },
        rules: { firestore: null, database: null, storage: null, crossServiceIam: 'granted' },
        firestore: { documents: [] },
        database: { data: null, priorities: {} },
        storage: [],
        messaging: { registrations: [], delivered: [], topics: {} },
      },
    } as unknown as Checkpoint);

    // Checkpoint 2: full sandbox checkpoint referencing a blob later deleted from live Storage
    await uploadBytes(ref(storage, 'snapshots/keep.txt'), keepBlob, { contentType: 'text/plain' });
    await saveCheckpoint(persistence.checkpoints, 'with-deleted-blob', sandbox);
    await deleteObject(ref(storage, 'snapshots/keep.txt'));

    // Checkpoint 3: checkpoint whose blob file goes missing on disk
    await uploadBytes(ref(storage, 'snapshots/missing.txt'), missingBlob, { contentType: 'text/plain' });
    await saveCheckpoint(persistence.checkpoints, 'missing-blob', sandbox);
    await deleteObject(ref(storage, 'snapshots/missing.txt'));

    // Checkpoint 4: checkpoint whose blob file bit-rots on disk
    await uploadBytes(ref(storage, 'snapshots/rotted.txt'), rottedBlob, { contentType: 'text/plain' });
    await saveCheckpoint(persistence.checkpoints, 'rotted-blob', sandbox);
    await deleteObject(ref(storage, 'snapshots/rotted.txt'));

    // Checkpoint 5: checkpoint whose JSON column is corrupted in SQLite
    await saveCheckpoint(persistence.checkpoints, 'corrupt-json', sandbox);
  } finally {
    sandbox.dispose();
    persistence.close();
  }

  const hostedDir = hostedStateDirectory(projectDir);
  rmSync(objectPath(hostedDir, sha256(missingBlob)));
  const corruptedBytes = Uint8Array.from(rottedBlob);
  corruptedBytes[0] ^= 0xff;
  writeFileSync(objectPath(hostedDir, sha256(rottedBlob)), corruptedBytes);
  const rawDb = new DatabaseSync(join(hostedDir, 'state.sqlite'));
  rawDb.prepare("UPDATE checkpoints SET state='{' WHERE name='corrupt-json'").run();
  rawDb.close();

  const report = await salvageHostedState(hostedDir, recoveredDir);
  assert.equal(report.recoveredCheckpoints, 2);
  assert.deepEqual(
    report.quarantined,
    [{ bucket: 'pyric-default', path: 'snapshots/rotted.txt', sha256: sha256(rottedBlob), file: `quarantine/${sha256(rottedBlob)}` }],
  );
  assert.deepEqual(new Uint8Array(readFileSync(join(recoveredDir, 'quarantine', sha256(rottedBlob)))), corruptedBytes);
  assert.deepEqual(
    report.excluded.filter(item => item.namespace === 'checkpoints').map(item => item.id).sort(),
    ['corrupt-json', 'missing-blob', 'rotted-blob'],
  );

  // Open recovered store read-only and writable: both valid checkpoints exist, keep blob is copied,
  // referencedObjects keeps it across sweeps, and restoreNamedCheckpoint restores the deleted object.
  const recoveredReadOnly = await openHostedDatabase(recoveredDir, { readOnly: true });
  try {
    assert.deepEqual(
      (await recoveredReadOnly.checkpoints.list()).map(entry => entry.name),
      ['golden-seed', 'with-deleted-blob'],
    );
    assert.equal(recoveredReadOnly.referencedObjects().has(sha256(keepBlob)), true);
    assert.equal(existsSync(objectPath(recoveredDir, sha256(keepBlob))), true);
  } finally {
    recoveredReadOnly.close();
  }

  const recoveredWritable = await openHostedDatabase(recoveredDir);
  const targetSandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(targetSandbox, recoveredWritable.storage);
  try {
    const restored = await restoreNamedCheckpoint(recoveredWritable.checkpoints, 'with-deleted-blob', targetSandbox);
    assert.ok(restored !== null);
    assert.equal(await (await recoveredWritable.storage.getBlob('snapshots/keep.txt', 'pyric-default'))?.text(), 'checkpoint-only-bytes');
  } finally {
    targetSandbox.dispose();
    recoveredWritable.close();
  }
}

// 2. Salvage succeeds when records table is empty and only checkpoints exist.
{
  const checkpointOnlyProject = join(root, 'checkpoint-only');
  const checkpointOnlyOut = join(root, 'checkpoint-only-out');
  const persistence = await createHostedPersistence(checkpointOnlyProject);
  const sandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(sandbox, persistence.storage);
  try {
    await saveCheckpoint(persistence.checkpoints, 'only-checkpoint', sandbox);
  } finally {
    sandbox.dispose();
    persistence.close();
  }
  const report = await salvageHostedState(hostedStateDirectory(checkpointOnlyProject), checkpointOnlyOut);
  assert.equal(report.recoveredCheckpoints, 1);
  const opened = await openHostedDatabase(checkpointOnlyOut, { readOnly: true });
  try {
    assert.deepEqual((await opened.checkpoints.list()).map(entry => entry.name), ['only-checkpoint']);
  } finally {
    opened.close();
  }
}

// 3. Salvage tolerates earlier hosted schema versions (v4) that predate checkpoint tables.
{
  const v4Out = join(root, 'schema-v4-out');
  const v4Seed = join(root, 'schema-v4-seed');
  const seeded = await createHostedPersistence(v4Seed);
  try {
    await seeded.state.writeSection('auth', {
      users: [{ uid: 'u4', email: 'v4@example.com', emailVerified: false, isAnonymous: false, providerData: [] }],
    });
  } finally {
    seeded.close();
  }
  const seededDir = hostedStateDirectory(v4Seed);
  const seededDb = new DatabaseSync(join(seededDir, 'state.sqlite'));
  seededDb.exec('DROP TABLE checkpoint_objects; DROP TABLE checkpoints; PRAGMA user_version = 4;');
  seededDb.close();
  const v4Report = await salvageHostedState(seededDir, v4Out);
  assert.equal(v4Report.recoveredServices, 1);
  assert.equal(v4Report.recoveredCheckpoints, 0);
  const openedV4 = await openHostedDatabase(v4Out, { readOnly: true });
  try {
    assert.deepEqual(await openedV4.checkpoints.list(), []);
  } finally {
    openedV4.close();
  }
}

console.log('Checkpoint salvage passed');
