import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function runNodeSqliteScript(scriptLines: readonly string[]): string {
  const dir = makeTempDir('pyric-named-db-sqlite-');
  symlinkSync(
    new URL('../../../../node_modules', import.meta.url).pathname,
    join(dir, 'node_modules'),
    'dir',
  );
  const scriptPath = join(dir, 'check.mjs');
  writeFileSync(scriptPath, scriptLines.join('\n'));
  const result = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [scriptPath, dir], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Node SQLite named-db check failed (${String(result.status)}):\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

describe('Hosted SQLite schema v7 and multi-database persistence (#1318)', () => {
  it('upgrades a schema v6 SQLite store to v7 without storage_generations collision or row loss', () => {
    const persistenceDist = new URL('../../../dist/serve/hosted/persistence/', import.meta.url).href;
    const sandboxDist = new URL('../../../../pyric/dist/sandbox/index.js', import.meta.url).href;

    const output = runNodeSqliteScript([
      `import assert from 'node:assert/strict';`,
      `import { mkdirSync } from 'node:fs';`,
      `import { DatabaseSync } from 'node:sqlite';`,
      `import { serializeToBuckets } from '${sandboxDist}';`,
      `import { HOSTED_SCHEMA_VERSION, openHostedDatabase } from '${persistenceDist}database.js';`,
      `import { validateHostedDatabase } from '${persistenceDist}validate.js';`,
      `const root = process.argv[2];`,
      `const stateDir = root + '/v6-store';`,
      `mkdirSync(stateDir, { recursive: true });`,
      `const raw = new DatabaseSync(stateDir + '/state.sqlite');`,
      `raw.exec(\`PRAGMA journal_mode=WAL;`,
      `  CREATE TABLE records (namespace TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (namespace, id)) STRICT;`,
      `  CREATE TABLE storage_objects (bucket TEXT NOT NULL, path TEXT NOT NULL, metadata TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (bucket, path)) STRICT;`,
      `  CREATE TABLE storage_generations (bucket TEXT NOT NULL, path TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY (bucket, path)) STRICT;`,
      `  CREATE TABLE checkpoints (name TEXT PRIMARY KEY, at INTEGER NOT NULL, counts TEXT NOT NULL, state TEXT NOT NULL) STRICT;`,
      `  CREATE TABLE checkpoint_objects (name TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (name, sha256)) STRICT;`,
      `  INSERT INTO storage_generations VALUES ('b', 'obj.txt', '42');`,
      `  PRAGMA user_version=6;\`);`,
      `const v6Buckets = serializeToBuckets({ 'legacy/doc1': { kept: true } }, {}, 1000);`,
      `const insertRec = raw.prepare('INSERT INTO records VALUES (?, ?, ?)');`,
      `for (const [id, val] of v6Buckets) insertRec.run('hosted', id, JSON.stringify(val));`,
      `raw.close();`,
      `assert.equal(HOSTED_SCHEMA_VERSION, 7);`,
      `const db = await openHostedDatabase(stateDir);`,
      `try {`,
      `  assert.equal(db.schemaVersion(), 6);`,
      `  validateHostedDatabase(db);`,
      `  db.activate();`,
      `  assert.equal(db.schemaVersion(), 7);`,
      `  const userVer = db.connection.prepare('PRAGMA user_version').get().user_version;`,
      `  assert.equal(Number(userVer), 7);`,
      `  const gen = db.connection.prepare('SELECT generation FROM storage_generations WHERE bucket=? AND path=?').get('b', 'obj.txt');`,
      `  assert.equal(gen.generation, '42');`,
      `} finally {`,
      `  db.close();`,
      `}`,
      `const v8Dir = root + '/v8-store';`,
      `mkdirSync(v8Dir, { recursive: true });`,
      `const v8Raw = new DatabaseSync(v8Dir + '/state.sqlite');`,
      `v8Raw.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=8;');`,
      `v8Raw.close();`,
      `await assert.rejects(() => openHostedDatabase(v8Dir), /Unsupported hosted database version 8\\./);`,
      `console.log('UPGRADE_OK');`,
    ]);

    expect(output).toBe('UPGRADE_OK');
  });

  it('isolates two databases across Node host restarts, reset + restart, and clearPersistence', () => {
    const persistenceDist = new URL('../../../dist/serve/hosted/persistence/', import.meta.url).href;
    const workerHostUrl = new URL('../../../dist/serve/worker/host.js', import.meta.url).href;
    const serveInitUrl = new URL('../../../dist/serve/worker/serve-init.js', import.meta.url).href;
    const pyricFirestoreUrl = new URL('../../../../pyric/dist/firestore/index.js', import.meta.url).href;
    const pyricFirestoreInternalUrl = new URL('../../../../pyric/dist/firestore/internal/index.js', import.meta.url).href;
    const pyricSandboxInternalUrl = new URL('../../../../pyric/dist/sandbox/internal/index.js', import.meta.url).href;

    const output = runNodeSqliteScript([
      `import assert from 'node:assert/strict';`,
      `import { openHostedDatabase } from '${persistenceDist}database.js';`,
      `import { validateHostedDatabase } from '${persistenceDist}validate.js';`,
      `import { handleMessage } from '${workerHostUrl}';`,
      `import { applyServeInit } from '${serveInitUrl}';`,
      `import { getFirestore } from '${pyricFirestoreUrl}';`,
      `import { isFirestoreDatabaseDeclared, undeclareFirestoreDatabase } from '${pyricFirestoreInternalUrl}';`,
      `import { createSandboxRoot } from '${pyricSandboxInternalUrl}';`,
      `const root = process.argv[2];`,
      `const stateDir = root + '/node-host-state';`,
      `const OPEN_RULES = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }";`,
      `async function bootHost() {`,
      `  const database = await openHostedDatabase(stateDir);`,
      `  validateHostedDatabase(database);`,
      `  database.activate();`,
      `  const sandbox = createSandboxRoot();`,
      `  await sandbox.enablePersistence({ key: 'hosted', injectedBackend: database.records });`,
      `  const ctx = {`,
      `    db: getFirestore(sandbox),`,
      `    sandbox,`,
      `    instanceId: 'host-test',`,
      `    subs: new Map(),`,
      `    checkpointBackend: database.checkpoints,`,
      `    flushPersistence: () => sandbox.flush(),`,
      `  };`,
      `  applyServeInit(ctx, { activityToken: 't', rules: OPEN_RULES, rulesHash: null, storageRules: null, storageRulesHash: null, bridgeUrl: null, seed: null });`,
      `  return { database, sandbox, ctx };`,
      `}`,
      `async function sendOp(ctx, op) {`,
      `  const replies = [];`,
      `  const port = { postMessage: (m) => replies.push(m) };`,
      `  await handleMessage(ctx, port, { t: 'op', id: 'op-1', ...op });`,
      `  assert.equal(replies.length, 1);`,
      `  return replies[0];`,
      `}`,
      // Session 1: declare `reports` and `archive`, write distinct data at identical path `items/one`.
      `{`,
      `  const host = await bootHost();`,
      `  try {`,
      `    assert.equal((await sendOp(host.ctx, { method: 'setRules', source: OPEN_RULES, databaseId: 'reports' })).ok, true);`,
      `    assert.equal((await sendOp(host.ctx, { method: 'setRules', source: OPEN_RULES, databaseId: 'archive' })).ok, true);`,
      `    assert.equal((await sendOp(host.ctx, { method: 'setDoc', path: 'items/one', data: { from: 'default' } })).ok, true);`,
      `    assert.equal((await sendOp(host.ctx, { method: 'setDoc', path: 'items/one', data: { from: 'reports' }, databaseId: 'reports' })).ok, true);`,
      `    assert.equal((await sendOp(host.ctx, { method: 'setDoc', path: 'items/one', data: { from: 'archive' }, databaseId: 'archive' })).ok, true);`,
      `    const namespaces = host.database.connection.prepare('SELECT DISTINCT namespace FROM records ORDER BY namespace').all().map((r) => r.namespace);`,
      `    assert.deepEqual(namespaces, ['hosted', 'hosted/firestore/archive', 'hosted/firestore/reports']);`,
      `    assert.equal(host.database.readRecord('hosted/firestore/reports', 'meta'), null);`,
      `    const meta = host.database.readRecord('hosted', 'meta');`,
      `    assert.deepEqual(meta.firestoreDeclared, ['archive', 'reports']);`,
      `  } finally {`,
      `    host.sandbox.dispose();`,
      `    host.database.close();`,
      `  }`,
      `}`,
      // Session 2: restart Node host -> verify isolation across databases, then run resetAll + close!
      `{`,
      `  const host = await bootHost();`,
      `  try {`,
      `    assert.equal(isFirestoreDatabaseDeclared(host.sandbox, 'reports'), true);`,
      `    assert.equal(isFirestoreDatabaseDeclared(host.sandbox, 'archive'), true);`,
      `    const defSnap = await sendOp(host.ctx, { method: 'admin.getDocument', path: 'items/one' });`,
      `    const repSnap = await sendOp(host.ctx, { method: 'admin.getDocument', path: 'items/one', databaseId: 'reports' });`,
      `    const arcSnap = await sendOp(host.ctx, { method: 'admin.getDocument', path: 'items/one', databaseId: 'archive' });`,
      `    assert.deepEqual(defSnap.value, { from: 'default' });`,
      `    assert.deepEqual(repSnap.value, { from: 'reports' });`,
      `    assert.deepEqual(arcSnap.value, { from: 'archive' });`,
      `    // Undeclare archive before reset: its record space stays as leftover until clearPersistence!`,
      `    undeclareFirestoreDatabase(host.sandbox, 'archive');`,
      `    await host.sandbox.flush();`,
      `    const resetReply = await sendOp(host.ctx, { method: 'resetAll' });`,
      `    assert.equal(resetReply.ok, true);`,
      `  } finally {`,
      `    host.sandbox.dispose();`,
      `    host.database.close();`,
      `  }`,
      `}`,
      // Session 3 (ADR-0021 Section 10 required evidence): restart after reset -> both `(default)` and `reports` come back empty, `reports` stays declared, and clearPersistence removes leftover `hosted/firestore/archive`!
      `{`,
      `  const host = await bootHost();`,
      `  try {`,
      `    assert.equal(isFirestoreDatabaseDeclared(host.sandbox, 'reports'), true);`,
      `    assert.equal(isFirestoreDatabaseDeclared(host.sandbox, 'archive'), false);`,
      `    const defAfterReset = await sendOp(host.ctx, { method: 'admin.getDocument', path: 'items/one' });`,
      `    const repAfterReset = await sendOp(host.ctx, { method: 'admin.getDocument', path: 'items/one', databaseId: 'reports' });`,
      `    assert.equal(defAfterReset.value, null);`,
      `    assert.equal(repAfterReset.value, null);`,
      `    // Undeclared leftover 'hosted/firestore/archive' still holds its rows until clearPersistence.`,
      `    assert.equal(host.database.hasRecords('hosted/firestore/archive'), true);`,
      `    await host.sandbox.clearPersistence();`,
      `    const remaining = host.database.connection.prepare('SELECT count(*) AS n FROM records').get().n;`,
      `    assert.equal(Number(remaining), 0);`,
      `  } finally {`,
      `    host.sandbox.dispose();`,
      `    host.database.close();`,
      `  }`,
      `}`,
      `console.log('RESTART_RESET_CLEAR_OK');`,
    ]);

    expect(output).toBe('RESTART_RESET_CLEAR_OK');
  });

  it('round-trips firestoreDatabases in state-view, validates namespaces, and salvages multi-db stores', () => {
    const persistenceDist = new URL('../../../dist/serve/hosted/persistence/', import.meta.url).href;
    const pyricFirestoreInternalUrl = new URL('../../../../pyric/dist/firestore/internal/index.js', import.meta.url).href;
    const sandboxDist = new URL('../../../../pyric/dist/sandbox/index.js', import.meta.url).href;

    const output = runNodeSqliteScript([
      `import assert from 'node:assert/strict';`,
      `import { openHostedDatabase } from '${persistenceDist}database.js';`,
      `import { createHostedStateView } from '${persistenceDist}state-view.js';`,
      `import { validateHostedDatabase } from '${persistenceDist}validate.js';`,
      `import { salvageHostedState } from '${persistenceDist}salvage.js';`,
      `import { serializeToBuckets } from '${sandboxDist}';`,
      `import { serializeNamedFirestoreDocsToBuckets, stampFirestoreDeclaredOnMeta } from '${pyricFirestoreInternalUrl}';`,
      `const root = process.argv[2];`,
      `const stateDir = root + '/view-state';`,
      `const db = await openHostedDatabase(stateDir);`,
      `try {`,
      `  db.activate();`,
      `  const view = createHostedStateView(root, stateDir, db, 'hosted');`,
      `  const defaultOnlyBuckets = serializeToBuckets({ 'Only/d1': { x: 1 } }, {}, 10);`,
      `  await db.records.putRecords('hosted', defaultOnlyBuckets);`,
      `  const defaultView = view.readSection('firestore');`,
      `  assert.equal('firestoreDatabases' in defaultView, false);`,
      `  const withDeclared = new Map(defaultOnlyBuckets);`,
      `  withDeclared.set('meta', stampFirestoreDeclaredOnMeta(withDeclared.get('meta'), ['reports']));`,
      `  const reportsBuckets = serializeNamedFirestoreDocsToBuckets({ 'Only/d1': { x: 2 }, 'Reports/r1': { ok: true } });`,
      `  await db.records.putRecords('hosted', withDeclared);`,
      `  await db.records.putRecords('hosted/firestore/reports', reportsBuckets);`,
      `  validateHostedDatabase(db);`,
      `  const multiView = view.readSection('firestore');`,
      `  assert.equal(typeof multiView.firestoreDatabases.reports, 'object');`,
      `  // Auth section write preserves meta.firestoreDeclared and named namespaces.`,
      `  await view.writeSection('auth', { users: [{ uid: 'u1', email: 'u1@example.test', password: 'secret-password' }] });`,
      `  assert.deepEqual(db.readRecord('hosted', 'meta').firestoreDeclared, ['reports']);`,
      `  assert.equal(db.hasRecords('hosted/firestore/reports'), true);`,
      `  // Invalid database id in firestoreDatabases is rejected.`,
      `  await assert.rejects(() => view.writeSection('firestore', { ...multiView, firestoreDatabases: { Bad_Id: {} } }), /Invalid Firestore database id/);`,
      `  // Corrupt one bucket in reports and add one valid bucket in archive, then salvage!`,
      `  db.connection.prepare('INSERT INTO records VALUES (?, ?, ?)').run('hosted/firestore/reports', 'ff', '{not-json');`,
      `  // Also check validateHostedDatabase rejects invalid namespace before removing it.`,
      `  db.connection.prepare('INSERT INTO records VALUES (?, ?, ?)').run('hosted/firestore/Bad_Id', '00', '{}');`,
      `  assert.throws(() => validateHostedDatabase(db), /Unsupported hosted persistence namespace/);`,
      `  db.connection.prepare('DELETE FROM records WHERE namespace=?').run('hosted/firestore/Bad_Id');`,
      `} finally {`,
      `  db.close();`,
      `}`,
      `const salvagedDir = root + '/salvaged-state';`,
      `const report = await salvageHostedState(stateDir, salvagedDir);`,
      `assert.equal(report.recoveredDocuments, 3);`,
      `assert.equal(report.excluded.some((e) => e.namespace === 'hosted/firestore/reports' && e.id === 'ff'), true);`,
      `const reopened = await openHostedDatabase(salvagedDir, { readOnly: true });`,
      `try {`,
      `  validateHostedDatabase(reopened);`,
      `  assert.equal(reopened.hasRecords('hosted/firestore/reports'), true);`,
      `} finally {`,
      `  reopened.close();`,
      `}`,
      `console.log('VIEW_VALIDATE_SALVAGE_OK');`,
    ]);

    expect(output).toBe('VIEW_VALIDATE_SALVAGE_OK');
  });
});
