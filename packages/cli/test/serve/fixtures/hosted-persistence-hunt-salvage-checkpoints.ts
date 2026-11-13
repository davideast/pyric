import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureCheckpoint, restoreNamedCheckpoint, saveCheckpoint } from 'pyric/sandbox/checkpoints';
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
    await persistence.checkpoints.write('golden-seed', await captureCheckpoint(sandbox));

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

// 4. Salvage recovers rules-only RTDB stores and excludes invalid RTDB instance rules and corrupt checkpoint states.
{
  const rulesOnlySeed = join(root, 'rules-only-rtdb-seed');
  const rulesOnlyOut = join(root, 'rules-only-rtdb-out');
  const seeded = await createHostedPersistence(rulesOnlySeed);
  seeded.close();

  const rulesOnlyDir = hostedStateDirectory(rulesOnlySeed);
  const rulesOnlyDb = new DatabaseSync(join(rulesOnlyDir, 'state.sqlite'));
  rulesOnlyDb.prepare("INSERT OR REPLACE INTO records (namespace, id, payload) VALUES ('hosted', 'meta', ?)").run(
    JSON.stringify({ version: 4, savedAt: 1000, services: {} }),
  );
  rulesOnlyDb.prepare("INSERT OR REPLACE INTO records (namespace, id, payload) VALUES ('hosted', 'rtdb:i:(default)', ?)").run(
    JSON.stringify({
      version: 1,
      instance: '(default)',
      priorities: {},
      rules: {
        rules: {
          users: {
            $uid: {
              '.read': 'auth.uid === $uid',
              '.write': 'auth.uid === $uid',
            },
          },
        },
      },
    }),
  );
  rulesOnlyDb.close();

  const rulesOnlyReport = await salvageHostedState(rulesOnlyDir, rulesOnlyOut);
  assert.equal(rulesOnlyReport.recoveredServices, 1);
  assert.deepEqual(rulesOnlyReport.excluded, []);

  // Corrupt both rtdb:i:(default) rules and checkpoint state, and verify salvage excludes both
  // while validateHostedDatabase (via createHostedPersistence) refuses un-salvaged corrupt checkpoint rows.
  const corruptSeed = join(root, 'corrupt-rtdb-and-checkpoint-seed');
  const corruptOut = join(root, 'corrupt-rtdb-and-checkpoint-out');
  const corruptPersistence = await createHostedPersistence(corruptSeed);
  const sb = createSandboxRoot({ mutations: 100, spans: 100 });
  installStorageBackend(sb, corruptPersistence.storage);
  try {
    await corruptPersistence.state.writeSection('auth', {
      users: [{ uid: 'u-ok', email: 'ok@example.com', emailVerified: false, isAnonymous: false, providerData: [] }],
    });
    await saveCheckpoint(corruptPersistence.checkpoints, 'cp-bad', sb);
  } finally {
    sb.dispose();
    corruptPersistence.close();
  }

  const corruptDir = hostedStateDirectory(corruptSeed);
  const corruptDb = new DatabaseSync(join(corruptDir, 'state.sqlite'));
  corruptDb.prepare("INSERT OR REPLACE INTO records (namespace, id, payload) VALUES ('hosted', 'rtdb:i:(default)', ?)").run(
    JSON.stringify({
      version: 1,
      instance: '(default)',
      priorities: {},
      rules: { rules: { '.unknownDirective': true, '.read': 'auth.uid ===' } },
    }),
  );
  const cpRow = corruptDb.prepare("SELECT state FROM checkpoints WHERE name = 'cp-bad'").get() as { state: string };
  const cpState = JSON.parse(cpRow.state) as { rules: { database: unknown } };
  cpState.rules.database = { rules: { '.unknownDirective': true } };
  corruptDb.prepare("UPDATE checkpoints SET state = ? WHERE name = 'cp-bad'").run(JSON.stringify(cpState));
  corruptDb.close();

  await assert.rejects(() => createHostedPersistence(corruptSeed));

  const corruptReport = await salvageHostedState(corruptDir, corruptOut);
  assert.equal(corruptReport.recoveredServices, 1);
  assert.equal(corruptReport.recoveredCheckpoints, 0);
  assert.equal(corruptReport.excluded.some((e) => e.id === 'rtdb:i:(default)'), true);
  assert.equal(corruptReport.excluded.some((e) => e.namespace === 'checkpoints' && e.id === 'cp-bad'), true);
}

console.log('Checkpoint salvage passed');
