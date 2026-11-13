import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHostedPersistence, hostedStateDirectory } from '../../../src/serve/hosted/persistence.js';
import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { salvageHostedState } from '../../../src/serve/hosted/persistence/salvage.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';

const root = process.argv[2];

const projectDir = join(root, 'maximal-hosted-project');
const salvagedDir = join(root, 'maximal-hosted-salvaged');

const persistence = await createHostedPersistence(projectDir);
const runtime = await createHostedRuntime(
  {
    rules: `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /docs/{docId} { allow read, write: if request.auth != null; }\n  }\n}`,
    rulesHash: null,
    databaseRules: { rules: { '.read': true, '.write': true } },
    databaseRulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    permissive: false,
    projectKey: 'maximal-hosted-standing',
    sessionToken: 'tok-maximal-standing',
    appOptions: { projectId: 'demo-project' },
  },
  'http://127.0.0.1:4400',
  () => {},
  projectDir,
  { persistence, record: false },
);

try {
  // Deploy initial open rules to named RTDB instance
  await runtime.deployRules('database', JSON.stringify({ rules: { '.read': true, '.write': true } }), 'secondary-rtdb');

  // Seed non-anonymous Auth user with nested customClaims + RTDB array & scalar root
  const seedRes = await runtime.runMethod(
    {
      key: 'sandbox.seed',
      args: {
        users: [
          {
            uid: 'u-editor',
            email: 'editor@example.com',
            password: 'password123',
            customClaims: { roles: ['editor'], org: { id: 'o1' } },
          },
        ],
        firestore: { 'docs/d1': { title: 'Hosted Spec' } },
        database: { items: ['alpha', 'beta'] },
      },
      projectDir,
    },
    {},
  );
  assert.equal(seedRes.ok, true);

  // Fork branch, lock down secondary-rtdb + add rules-only-rtdb, promote, and reset
  const forkRes = await runtime.runMethod({ key: 'sandbox.fork', args: { branch: 'lockdown' }, projectDir }, {});
  assert.equal(forkRes.ok, true);
  const branchRulesPath = join(projectDir, '.pyric/state/branches/lockdown/state/rules.json');
  const branchRules = JSON.parse(readFileSync(branchRulesPath, 'utf8'));
  branchRules.database = { rules: { '.read': "data.val() === 'root-banner'", '.write': false } };
  branchRules.databaseInstances = {
    ...(branchRules.databaseInstances ?? {}),
    'secondary-rtdb': { rules: { '.read': false, '.write': false } },
    'rules-only-rtdb': { rules: { users: { $uid: { '.read': 'auth.uid === $uid' } } } },
  };
  writeFileSync(branchRulesPath, JSON.stringify(branchRules, null, 2));

  const promoteRes = await runtime.runMethod(
    { key: 'sandbox.promote', args: { branch: 'lockdown', confirm: true }, projectDir },
    {},
  );
  assert.equal(promoteRes.ok, true);

  // Save a valid checkpoint and two checkpoints to corrupt in distinct ways before reset
  const cpGood = await runtime.runMethod({ key: 'sandbox.checkpoint', args: { name: 'cp-good' }, projectDir }, {});
  assert.equal(cpGood.ok, true);
  const cpBad = await runtime.runMethod({ key: 'sandbox.checkpoint', args: { name: 'cp-corrupt' }, projectDir }, {});
  assert.equal(cpBad.ok, true);
  const cpBadCounts = await runtime.runMethod({ key: 'sandbox.checkpoint', args: { name: 'cp-bad-counts' }, projectDir }, {});
  assert.equal(cpBadCounts.ok, true);

  // Reset preserves promoted named-instance deny rules
  const resetRes = await runtime.runMethod({ key: 'sandbox.reset', args: { confirm: true }, projectDir }, {});
  assert.equal(resetRes.ok, true);

  const simSecondary = await runtime.runMethod(
    {
      key: 'rules.simulate',
      args: { service: 'database', operation: 'read', path: '/items/1', instance: 'secondary-rtdb' },
      projectDir,
    },
    {},
  );
  assert.equal(simSecondary.data?.decision, 'DENY');

  // Set scalar root on default instance and verify rules.simulate evaluates it
  const setScalar = await runtime.runMethod(
    { key: 'database.set', args: { path: '/', value: 'root-banner' }, projectDir },
    {},
  );
  assert.equal(setScalar.ok, true);
  const simScalar = await runtime.runMethod(
    { key: 'rules.simulate', args: { service: 'database', operation: 'read', path: '/' }, projectDir },
    {},
  );
  assert.equal(simScalar.data?.decision, 'ALLOW');
} finally {
  await runtime.close();
  persistence.close();
}

// Inject both a corrupt RTDB instance ruleset and a corrupt checkpoint into SQLite, then run salvage
const hostedDir = hostedStateDirectory(projectDir);
const rawDb = new DatabaseSync(join(hostedDir, 'state.sqlite'));
rawDb.prepare("INSERT OR REPLACE INTO records (namespace, id, payload) VALUES ('hosted', 'rtdb:i:corrupt-rtdb', ?)").run(
  JSON.stringify({
    version: 1,
    instance: 'corrupt-rtdb',
    priorities: {},
    rules: { rules: { '.unknownDirective': true } },
  }),
);
const badCpRow = rawDb.prepare("SELECT state FROM checkpoints WHERE name = 'cp-corrupt'").get() as { state: string };
const badCpState = JSON.parse(badCpRow.state);
badCpState.rules.databaseInstances = { 'secondary-rtdb': { rules: { '.read': 'auth.uid ===' } } };
rawDb.prepare("UPDATE checkpoints SET state = ? WHERE name = 'cp-corrupt'").run(JSON.stringify(badCpState));
rawDb.prepare("UPDATE checkpoints SET counts = '{}' WHERE name = 'cp-bad-counts'").run();

// Also seed a Storage row with a stale recorded size to verify failed startup validation does NOT mutate SQLite beforehand
const contentBytes = Buffer.from('standing-blob-bytes');
const sha256 = (await import('node:crypto')).createHash('sha256').update(contentBytes).digest('hex');
const blobStore = (await import('../../../src/serve/hosted/persistence/blob-store.js')).createBlobStore(join(hostedDir, 'objects'));
blobStore.write(contentBytes);
const staleMeta = JSON.stringify({
  bucket: 'pyric-default',
  fullPath: 'items/stale-size.txt',
  name: 'stale-size.txt',
  size: 999,
  generation: '1',
  metageneration: '1',
  timeCreated: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  contentDisposition: 'inline',
  contentType: 'text/plain',
});
rawDb
  .prepare(
    "INSERT INTO storage_objects (bucket, path, sha256, size, mime, metadata) VALUES ('pyric-default', 'items/stale-size.txt', ?, ?, 'text/plain', ?)",
  )
  .run(sha256, contentBytes.byteLength, staleMeta);
rawDb.close();

// Un-salvaged corrupt store fails strict startup validation WITHOUT mutating storage_objects before checkpoint failure
await assert.rejects(() => createHostedPersistence(projectDir));
const checkDb = new DatabaseSync(join(hostedDir, 'state.sqlite'), { readOnly: true });
const postFailMeta = JSON.parse(
  (checkDb.prepare("SELECT metadata FROM storage_objects WHERE path = 'items/stale-size.txt'").get() as { metadata: string }).metadata,
) as { size: number };
checkDb.close();
assert.equal(postFailMeta.size, 999);

const report = await salvageHostedState(hostedDir, salvagedDir);
assert.equal(report.recoveredCheckpoints, 1);
assert.equal(report.excluded.some((e) => e.id === 'rtdb:i:corrupt-rtdb'), true);
assert.equal(report.excluded.some((e) => e.namespace === 'checkpoints' && e.id === 'cp-corrupt'), true);
assert.equal(report.excluded.some((e) => e.namespace === 'checkpoints' && e.id === 'cp-bad-counts'), true);

const reopenedSalvaged = await openHostedDatabase(salvagedDir, { readOnly: true });
try {
  assert.deepEqual((await reopenedSalvaged.checkpoints.list()).map((c) => c.name), ['cp-good']);
  assert.equal(reopenedSalvaged.readRecord('hosted', 'rtdb:i:corrupt-rtdb'), null);
  assert.notEqual(reopenedSalvaged.readRecord('hosted', 'rtdb:i:secondary-rtdb'), null);
} finally {
  reopenedSalvaged.close();
}

console.log('Maximal hosted state roundtrip passed');
