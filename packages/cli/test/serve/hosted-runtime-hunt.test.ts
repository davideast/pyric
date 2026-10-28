import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Hosted SQLite persistence deliberately refuses in-process Bun execution
 * (`sqlite.ts`: `Hosted SQLite persistence requires Node >=22.15`).
 * Mirror `hosted-sqlite.test.ts`: bundle scenarios against `@pyric/cli` `dist/`
 * once in `beforeAll` and execute each scenario deterministically under `node`.
 */
const SCENARIO_SOURCE = /* ts */ `
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedRuntime } from '@dist/serve/hosted/runtime.js';
import { mcpProjectError } from '@dist/serve/mcp-project.js';
import { replayRepro } from '@dist/serve/repro/replay.js';

const tempDirs = [];
const httpServers = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function cleanupAll() {
  await Promise.all(
    httpServers.splice(0).map((server) => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    }),
  );
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createHarness(dir, payloadOverrides = {}, options = {}) {
  const frames = [];
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const payload = {
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    projectKey: dir,
    sessionToken: 'test-session-token',
    permissive: false,
    appOptions: { projectId: 'demo-hunt', storageBucket: 'demo-hunt.appspot.com' },
    ...payloadOverrides,
  };

  function waitForFrame(predicate, timeoutMs = 4000) {
    const existing = frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(\`Timed out after \${timeoutMs}ms waiting for matching bridge frame.\`));
      }, timeoutMs);
      const check = () => {
        const match = frames.find(predicate);
        if (match !== undefined) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(match);
        }
      };
      listeners.add(check);
    });
  }

  let seq = 0;

  return {
    frames,
    waitForFrame,
    async start() {
      const runtime = await createHostedRuntime(
        payload,
        options.baseUrl ?? 'http://127.0.0.1:4400',
        (msg) => {
          frames.push(msg);
          notify();
        },
        dir,
        options.reproWindow !== undefined ? { reproWindow: options.reproWindow } : {},
      );
      return {
        runtime,
        async sendOp(session, op) {
          const id = typeof op.id === 'string' ? op.id : \`op-\${++seq}\`;
          runtime.receive({
            type: 'worker-message',
            clientSessionId: session,
            message: { t: 'op', id, ...op },
          });
          const frame = await waitForFrame(
            (m) =>
              m.type === 'worker-message-result' &&
              m.clientSessionId === session &&
              m.message.t === 'res' &&
              m.message.id === id,
          );
          return frame.message;
        },
        snapsFor(session, subId) {
          return frames
            .filter(
              (m) =>
                m.type === 'worker-message-result' &&
                m.clientSessionId === session &&
                m.message.t === 'snap' &&
                m.message.subId === subId,
            )
            .map((m) => m.message);
        },
        async waitForSnap(session, subId, predicate) {
          const frame = await waitForFrame(
            (m) =>
              m.type === 'worker-message-result' &&
              m.clientSessionId === session &&
              m.message.t === 'snap' &&
              m.message.subId === subId &&
              predicate(m.message),
          );
          return frame.message;
        },
      };
    },
  };
}

const scenarios = {
  async 'sw-hst-1'() {
    const dir = realpathSync(makeTempDir('sw-hst-1-'));
    const adminOnlyFirestoreRules = \`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null && (request.auth.uid == 'admin' || request.auth.uid == 'alice');
    }
  }
}\`;
    const allowAuthRtdbRules = {
      rules: {
        '.read': 'auth != null',
        '.write': 'auth != null',
      },
    };

    const harness = createHarness(dir, {
      rules: adminOnlyFirestoreRules,
      databaseInstances: {
        defaultInstance: 'demo-hunt-default-rtdb',
        rules: { 'demo-hunt-default-rtdb': allowAuthRtdbRules },
      },
    });
    const { runtime, sendOp, waitForSnap } = await harness.start();

    try {
      assert.equal((await sendOp('admin-tab', { method: 'setDoc', path: 'items/a', data: { v: 1 }, actAs: { mode: 'as', uid: 'admin' } })).ok, true);
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'tab-1',
        message: {
          t: 'sub',
          subId: 'sub-items-a',
          target: { __ref: 'doc', path: 'items/a' },
          actAs: { mode: 'as', uid: 'admin' },
        },
      });
      await waitForSnap('tab-1', 'sub-items-a', (snap) => snap.value?.exists === true && JSON.parse(snap.value.data.json).v === 1);

      assert.equal((await sendOp('tab-alice', {
        method: 'auth.adminCreateUser',
        request: { uid: 'alice', email: 'alice@example.com' },
      })).ok, true);
      assert.equal((await sendOp('tab-alice', {
        method: 'auth.restorePortSession',
        uid: 'alice',
        tenantId: null,
      })).ok, true);
      assert.equal((await sendOp('tab-alice', { method: 'setDoc', path: 'items/alice', data: { owned: true } })).ok, true);

      assert.equal((await sendOp('anon', { method: 'getDoc', path: 'items/a' })).ok, false);
      assert.equal((await sendOp('rtdb-client', { method: 'rtdb.set', path: 'secret', value: 'ok', actAs: { mode: 'as', uid: 'admin' } })).ok, true);

      const scopedReset = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.reset', args: { scope: 'firestore', confirm: true }, projectDir: dir, allowProduction: true },
        {},
      );
      assert.equal(scopedReset.ok, true);

      // 1a/1b: Unauthenticated Firestore write stays denied (never fail-open DEFAULT_OPEN_RULES)
      assert.equal((await sendOp('anon', { method: 'setDoc', path: 'items/a', data: { leaked: true } })).ok, false);

      // 1a: Authenticated RTDB write still succeeds (RTDB rules preserved)
      assert.equal((await sendOp('rtdb-client', { method: 'rtdb.set', path: 'secret', value: 'ok2', actAs: { mode: 'as', uid: 'admin' } })).ok, true);

      // 1b: Live Firestore listener emitted deletion snapshot on reset AND emits subsequent write snapshots
      await waitForSnap('tab-1', 'sub-items-a', (snap) => snap.value?.exists === false);
      assert.equal((await sendOp('admin-tab', { method: 'setDoc', path: 'items/a', data: { v: 2 }, actAs: { mode: 'as', uid: 'admin' } })).ok, true);
      const updatedSnap = await waitForSnap('tab-1', 'sub-items-a', (snap) => snap.value?.exists === true && JSON.parse(snap.value.data.json).v === 2);
      assert.equal(JSON.parse(updatedSnap.value.data.json).v, 2);

      // 1c: Full reset reconciles stale port sessions for deleted users
      const fullReset = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.reset', args: { confirm: true }, projectDir: dir, allowProduction: true },
        {},
      );
      assert.equal(fullReset.ok, true);
      const currentUser = await sendOp('tab-alice', { method: 'auth.getCurrentUser' });
      assert.equal(currentUser.ok, true);
      assert.equal(currentUser.value, null);
      assert.equal((await sendOp('tab-alice', { method: 'setDoc', path: 'items/alice', data: { bypass: true } })).ok, false);
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-3'() {
    const dir = realpathSync(makeTempDir('sw-hst-3-'));
    const harness = createHarness(dir, { permissive: true });
    const { waitForFrame } = harness;
    const { runtime } = await harness.start();

    try {
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'session-a',
        message: { t: 'op', id: 'op-1', method: 'getDoc', path: 'items/a' },
      });
      const op1 = await waitForFrame((m) => m.type === 'worker-message-result' && m.message.t === 'res' && m.message.id === 'op-1');
      assert.equal(op1.message.ok, true);

      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'session-a',
        message: { t: 'disconnect', id: 'disc-1' },
      });
      await waitForFrame((m) => m.type === 'worker-message-result' && m.message.t === 'res' && m.message.id === 'disc-1');

      // Non-resumed op after disconnect stays rejected with app/app-deleted
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'session-a',
        message: { t: 'op', id: 'op-closed', method: 'getDoc', path: 'items/a' },
      });
      const closedReply = await waitForFrame((m) => m.type === 'worker-message-result' && m.message.t === 'res' && m.message.id === 'op-closed');
      assert.equal(closedReply.message.ok, false);
      assert.equal(closedReply.message.error.code, 'app/app-deleted');

      // Resumed op with resumeSession: true succeeds
      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'session-a',
        message: { t: 'op', id: 'op-resumed', method: 'getDoc', path: 'items/a', resumeSession: true },
      });
      const resumedReply = await waitForFrame((m) => m.type === 'worker-message-result' && m.message.t === 'res' && m.message.id === 'op-resumed');
      assert.equal(resumedReply.message.ok, true);

      // Cross-transport replies route on the transport of each message
      runtime.receive({
        type: 'worker-op',
        clientSessionId: 'session-b',
        id: 'relay-1',
        op: { method: 'getDoc', path: 'items/b' },
      });
      const relayReply = await waitForFrame((m) => m.type === 'worker-res' && m.id === 'relay-1');
      assert.equal(relayReply.ok, true);

      runtime.receive({
        type: 'worker-message',
        clientSessionId: 'session-b',
        message: { t: 'op', id: 'port-2', method: 'getDoc', path: 'items/b' },
      });
      const portReply = await waitForFrame((m) => m.type === 'worker-message-result' && m.message.t === 'res' && m.message.id === 'port-2');
      assert.equal(portReply.message.ok, true);

      const repro = await runtime.captureRepro(dir);
      const report = await replayRepro(repro);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.deepEqual(report.planeDifferences, []);
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-4'() {
    const dir = realpathSync(makeTempDir('sw-hst-4-'));
    const harness = createHarness(dir, { permissive: true });
    const { runtime, sendOp } = await harness.start();

    try {
      assert.equal((await sendOp('tab-1', { method: 'getDoc', path: 'items/a' })).ok, true);

      await assert.rejects(runtime.deployRules('firestore', null));
      await assert.rejects(runtime.deployRules('firestore', 'THIS IS NOT VALID FIRESTORE RULES {{{'));
      await assert.rejects(
        runtime.deployRules('firestore', \`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o { allow read: if true; }
}\`),
        /Expected 'service cloud\\.firestore'/,
      );
      await assert.rejects(runtime.deployRules('database', '{ broken json'));

      const validRules = \`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}\`;
      const setRes = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'rules.set', args: { service: 'firestore', rules: validRules }, projectDir: dir, allowProduction: false },
        {},
      );
      assert.equal(setRes.ok, true);
      assert.equal((await sendOp('tab-1', { method: 'getDoc', path: 'items/a' })).ok, false);

      await assert.rejects(runtime.deployRules('firestore', null));
      await assert.rejects(runtime.deployRules('firestore', 'THIS IS NOT VALID FIRESTORE RULES {{{'));
      await assert.rejects(runtime.deployRules('firestore', \`rules_version = '2+modules';
import { missingHelper } from './missing';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read: if missingHelper();
    }
  }
}\`));

      const active = await sendOp('tab-1', { method: 'getActiveRules', service: 'firestore' });
      assert.equal(active.ok, true);
      assert.equal(active.value.status, 'active');
      assert.equal(active.value.source, validRules);
      assert.equal((await sendOp('tab-1', { method: 'getDoc', path: 'items/a' })).ok, false);

      const repro = await runtime.captureRepro(dir);
      assert.deepEqual(
        repro.entries.filter((e) => e.kind === 'rules').map((e) => [e.service, e.source]),
        [['firestore', validRules]],
      );
      const report = await replayRepro(repro);
      assert.equal(report.ok, true, JSON.stringify(report));
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-5'() {
    const dir = realpathSync(makeTempDir('sw-hst-5-'));
    let serverUrl = 'http://127.0.0.1:0';
    const harness = createHarness(
      dir,
      {
        storageRules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }",
        permissive: true,
      },
      { baseUrl: () => serverUrl },
    );
    const { runtime, sendOp } = await harness.start();

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', serverUrl);
      const handled = await runtime.storageHttp(req, res, url);
      if (!handled) res.writeHead(404).end();
    });
    httpServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    serverUrl = \`http://127.0.0.1:\${server.address().port}\`;

    try {
      const begin = await sendOp('tab-1', { method: 'storage.beginUpload', path: 'files/direct.bin', size: 4 });
      assert.equal(begin.ok, true);
      const directUrl = new URL(begin.value.uploadUrl, serverUrl);

      assert.equal((await fetch(directUrl, { method: 'PUT', headers: { 'content-range': 'bytes 0-999/999999' }, body: new Uint8Array([1, 2, 3, 4]) })).status, 400);
      assert.equal((await fetch(directUrl, { method: 'PUT', headers: { 'content-range': 'bytes 3-1/4' }, body: new Uint8Array([1, 2, 3]) })).status, 400);
      assert.equal((await fetch(directUrl, { method: 'PUT', headers: { 'content-range': 'bytes 0-3/4' }, body: new Uint8Array([1, 2]) })).status, 400);
      assert.equal((await fetch(directUrl, { method: 'PUT', headers: { 'content-range': 'bytes 0-3/4' }, body: new Uint8Array([1, 2, 3, 4]) })).status, 200);

      const session = await sendOp('tab-1', { method: 'storage.createUploadSession', path: 'files/session.bin', actAs: { mode: 'admin' } });
      assert.equal(session.ok, true);
      const sessionUrl = new URL(session.value.uploadUrl, serverUrl);

      assert.equal((await fetch(sessionUrl, { method: 'PUT', headers: { 'content-range': 'bytes 0-999/4' }, body: new Uint8Array([10, 20]) })).status, 400);
      assert.equal((await fetch(sessionUrl, { method: 'PUT', headers: { 'content-range': 'bytes 2-0/4' }, body: new Uint8Array([30, 40]) })).status, 400);
      assert.equal((await fetch(sessionUrl, { method: 'PUT', headers: { 'content-range': 'bytes 0-1/4' }, body: new Uint8Array([10, 20]) })).status, 308);
      assert.equal((await fetch(sessionUrl, { method: 'PUT', headers: { 'content-range': 'bytes 2-3/4' }, body: new Uint8Array([30, 40]) })).status, 200);
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-7b'() {
    const dir = realpathSync(makeTempDir('sw-hst-7b-'));
    const authRules = { rules: { '.read': 'auth != null', '.write': 'auth != null' } };
    const harness = createHarness(
      dir,
      {
        databaseInstances: {
          defaultInstance: 'primary-db',
          rules: { 'primary-db': authRules, 'secondary-db': authRules },
        },
      },
      { reproWindow: 4 },
    );
    const { runtime, sendOp } = await harness.start();

    try {
      assert.equal((await sendOp('tab-1', {
        method: 'rtdb.setWithPriority',
        instance: 'secondary-db',
        path: 'ranked/item1',
        value: 'alpha',
        priority: 99,
        actAs: { mode: 'as', uid: 'alice' },
      })).ok, true);

      for (let i = 0; i < 6; i++) {
        await sendOp('tab-1', { method: 'getDoc', path: 'noop/doc' });
      }

      const read = await sendOp('tab-1', {
        method: 'rtdb.get',
        instance: 'secondary-db',
        path: 'ranked/item1',
        actAs: { mode: 'as', uid: 'alice' },
      });
      assert.equal(read.ok, true);
      assert.equal(read.value.priority, 99);

      const repro = await runtime.captureRepro(dir);
      assert.equal(repro.truncated, true);

      const report = await replayRepro(repro);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(report.planes.node?.ok, true);
      assert.equal(report.planes.worker?.ok, true);
      assert.deepEqual(report.planeDifferences, []);
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-8'() {
    const dirA = realpathSync(makeTempDir('sw-hst-8a-'));
    const harnessA = createHarness(dirA, { permissive: true });
    const hostA = await harnessA.start();

    try {
      assert.equal((await hostA.sendOp('presence-1', { method: 'rtdb.onDisconnectSet', path: 'presence/alice', value: 'offline' })).ok, true);
      hostA.runtime.receive({ type: 'worker-client-disconnect', clientSessionId: 'presence-1' });

      assert.equal((await hostA.sendOp('presence-2', { method: 'rtdb.onDisconnectSet', path: 'presence/bob', value: 'interrupted' })).ok, true);
      hostA.runtime.receive({ type: 'worker-client-interrupted', clientSessionId: 'presence-2' });

      assert.equal((await hostA.sendOp('observer', { method: 'rtdb.get', path: 'presence/alice' })).value.value, 'offline');
      assert.equal((await hostA.sendOp('observer', { method: 'rtdb.get', path: 'presence/bob' })).value.value, 'interrupted');

      const reproA = await hostA.runtime.captureRepro(dirA);
      const reportA = await replayRepro(reproA);
      assert.equal(reportA.ok, true, JSON.stringify(reportA));
      assert.deepEqual(reportA.planeDifferences, []);
    } finally {
      await hostA.runtime.close();
    }

    const dirB = realpathSync(makeTempDir('sw-hst-8b-'));
    let serverUrl = 'http://127.0.0.1:0';
    const harnessB = createHarness(
      dirB,
      {
        storageRules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }",
        permissive: true,
      },
      { baseUrl: () => serverUrl },
    );
    const hostB = await harnessB.start();

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', serverUrl);
      const handled = await hostB.runtime.storageHttp(req, res, url);
      if (!handled) res.writeHead(404).end();
    });
    httpServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    serverUrl = \`http://127.0.0.1:\${server.address().port}\`;

    try {
      const begin = await hostB.sendOp('uploader', { method: 'storage.beginUpload', path: 'docs/hello.txt', size: 5 });
      assert.equal(begin.ok, true);
      const { uploadId, uploadUrl } = begin.value;
      const putRes = await fetch(new URL(uploadUrl, serverUrl), {
        method: 'PUT',
        body: new TextEncoder().encode('hello'),
      });
      assert.equal(putRes.status, 200);

      const finish = await hostB.sendOp('uploader', { method: 'storage.finishUpload', uploadId });
      assert.equal(finish.ok, true);

      const reproB = await hostB.runtime.captureRepro(dirB);
      const reportB = await replayRepro(reproB);
      assert.equal(reportB.ok, true, JSON.stringify(reportB));
      assert.equal(reportB.planes.node?.ok, true);
      assert.equal(reportB.planes.worker?.ok, true);
      assert.deepEqual(reportB.planeDifferences, []);
    } finally {
      await hostB.runtime.close();
    }
  },

  async 'sw-hst-9'() {
    const dir = realpathSync(makeTempDir('sw-hst-9-'));
    const customProviderRules = \`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /customOnly/{docId} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.sign_in_provider == 'custom'
        && request.auth.token.role == 'service';
    }
    match /noop/{docId} {
      allow read: if true;
    }
  }
}\`;
    const harness = createHarness(dir, { rules: customProviderRules }, { reproWindow: 4 });
    const { runtime, sendOp } = await harness.start();

    try {
      assert.equal((await sendOp('tab-custom', {
        method: 'auth.adminCreateUser',
        request: { uid: 'carol', email: 'carol@example.com', customClaims: { role: 'service' } },
      })).ok, true);

      assert.equal((await sendOp('tab-custom', {
        method: 'auth.signInWithCustomToken',
        customToken: JSON.stringify({ uid: 'carol', claims: { role: 'service' } }),
      })).ok, true);

      for (let i = 0; i < 6; i++) {
        await sendOp('tab-custom', { method: 'getDoc', path: 'noop/doc' });
      }

      assert.equal((await sendOp('tab-custom', {
        method: 'setDoc',
        path: 'customOnly/item1',
        data: { ok: true },
      })).ok, true);

      const repro = await runtime.captureRepro(dir);
      assert.equal(repro.truncated, true);
      assert.equal(repro.base.sessions['tab-custom']?.signInProvider, 'custom');

      const report = await replayRepro(repro);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(report.planes.node?.ok, true);
      assert.equal(report.planes.worker?.ok, true);
      assert.deepEqual(report.planeDifferences, []);
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-10'() {
    const base = makeTempDir('sw-hst-10-');
    const realDir = join(base, 'real-project');
    const linkDir = join(base, 'symlink-project');
    const otherDir = join(base, 'other-project');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    symlinkSync(realDir, linkDir, 'dir');

    const harness = createHarness(linkDir);
    const { runtime } = await harness.start();

    try {
      assert.equal((await runtime.runMethod(
        { instanceId: runtime.instanceId, projectDir: linkDir, key: 'firestore.getDoc', args: { path: 'items/a' }, allowProduction: false },
        {},
      )).ok, true);

      assert.equal((await runtime.runMethod(
        { instanceId: runtime.instanceId, projectDir: realDir, key: 'firestore.getDoc', args: { path: 'items/a' }, allowProduction: false },
        {},
      )).ok, true);

      const viaOther = await runtime.runMethod(
        { instanceId: runtime.instanceId, projectDir: otherDir, key: 'firestore.getDoc', args: { path: 'items/a' }, allowProduction: false },
        {},
      );
      assert.equal(viaOther.ok, false);
      assert.match(viaOther.summary, /belongs to another project/);

      assert.equal((await runtime.captureRepro(linkDir)).schema, 'pyric.repro.v1');
      assert.equal((await runtime.captureRepro(realDir)).schema, 'pyric.repro.v1');
      await assert.rejects(runtime.captureRepro(otherDir), /belongs to another project/);

      assert.equal(mcpProjectError(encodeURIComponent(linkDir), linkDir), null);
      assert.equal(mcpProjectError(encodeURIComponent(linkDir), realDir), null);
      assert.equal(mcpProjectError(encodeURIComponent(realDir), linkDir), null);
      assert.equal(mcpProjectError(encodeURIComponent(otherDir), linkDir), 'The selected sandbox belongs to another project.');
    } finally {
      await runtime.close();
    }
  },

  async 'sw-hst-11'() {
    const dir = realpathSync(makeTempDir('sw-hst-11-'));
    let activeRuntime = null;
    let serverUrl = '';
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', serverUrl);
      const handled = await activeRuntime.storageHttp(req, res, url);
      if (!handled) res.writeHead(404).end();
    });
    httpServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    serverUrl = \`http://127.0.0.1:\${server.address().port}\`;

    const harness = createHarness(
      dir,
      { appOptions: { projectId: 'digchatapp' } },
      { baseUrl: () => serverUrl },
    );

    const host1 = await harness.start();
    activeRuntime = host1.runtime;
    try {
      const begin = await host1.sendOp('admin-uploader', {
        method: 'storage.beginUpload',
        bucket: 'digchatapp.firebasestorage.app',
        defaultBucket: 'digchatapp.firebasestorage.app',
        path: 'spaces/s1/pixel.bin',
        size: 5,
        downloadTokens: 'tok-persist-1',
        actAs: { mode: 'admin' },
      });
      assert.equal(begin.ok, true);
      const putRes = await fetch(new URL(begin.value.uploadUrl, serverUrl), {
        method: 'PUT',
        body: new TextEncoder().encode('hello'),
      });
      assert.equal(putRes.status, 200);
      const finish = await host1.sendOp('admin-uploader', {
        method: 'storage.finishUpload',
        uploadId: begin.value.uploadId,
        actAs: { mode: 'admin' },
      });
      assert.equal(finish.ok, true);
    } finally {
      await host1.runtime.close();
    }

    const host2 = await harness.start();
    activeRuntime = host2.runtime;
    try {
      const okRes = await fetch(\`\${serverUrl}/__pyric/storage/v0/b/digchatapp.firebasestorage.app/o/spaces%2Fs1%2Fpixel.bin?alt=media&token=tok-persist-1\`);
      assert.equal(okRes.status, 200);
      assert.equal(await okRes.text(), 'hello');

      const badTokenRes = await fetch(\`\${serverUrl}/__pyric/storage/v0/b/digchatapp.firebasestorage.app/o/spaces%2Fs1%2Fpixel.bin?alt=media&token=wrong\`);
      assert.equal(badTokenRes.status, 403);

      const otherBucketRes = await fetch(\`\${serverUrl}/__pyric/storage/v0/b/unrelated-secondary-bucket/o/spaces%2Fs1%2Fpixel.bin?alt=media&token=tok-persist-1\`);
      assert.equal(otherBucketRes.status, 404);
    } finally {
      await host2.runtime.close();
    }
  },
  async 'sw-hst-12'() {
    const dir = realpathSync(makeTempDir('sw-hst-12-'));
    const firestoreRules = (matchPath) => [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match ' + matchPath + ' { allow read, write: if true; }',
      '  }',
      '}',
    ].join('\\n');
    const openOnly = firestoreRules('/open/{id}');
    const storageAllowAll = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{allPaths=**} { allow read, write: if true; }',
      '  }',
      '}',
    ].join('\\n');
    const unparseable = openOnly.replace('if true;', 'if true');
    const serviceReason = "Firestore rules did not compile: Expected 'service cloud.firestore', got 'service firebase.storage'.";

    const harness = createHarness(dir, { rules: openOnly });
    const { runtime, sendOp } = await harness.start();
    let toolSeq = 0;
    async function callTool(name, args) {
      const id = 'tool-' + (++toolSeq);
      runtime.receive({ type: 'tool-call', callerId: 'agent', id, name, args });
      const frame = await harness.waitForFrame((m) => m.type === 'tool-result' && m.id === id);
      assert.equal(frame.ok, true, JSON.stringify(frame));
      return frame.result;
    }
    const activeRules = async () => (await sendOp('tab-1', { method: 'getActiveRules', service: 'firestore' })).value;
    async function expectRulesInForce(openPath, lockedPath) {
      assert.equal((await sendOp('tab-1', { method: 'setDoc', path: openPath, data: { v: 1 } })).ok, true);
      assert.equal((await sendOp('tab-1', { method: 'setDoc', path: lockedPath, data: { v: 1 } })).ok, false);
    }

    try {
      await expectRulesInForce('open/a', 'locked/a');
      const before = await activeRules();
      assert.equal(before.status, 'active');
      assert.equal(before.source, openOnly);

      // FS2-ENF-3a: a Storage ruleset is refused with the shared reason.
      const storage = await callTool('firestore_simulator_create', { rules: storageAllowAll, documents: { 'locked/b': { v: 1 } } });
      assert.equal(storage.ok, false, JSON.stringify(storage));
      assert.equal(storage.summary, serviceReason);
      assert.equal(storage.data.code, 'RULES_REFUSED');
      assert.deepEqual(await activeRules(), before);
      await expectRulesInForce('open/b', 'locked/c');
      assert.equal((await sendOp('tab-1', { method: 'getDoc', path: 'open/a' })).ok, true);

      // FS2-ENF-3b: a source that does not parse is refused too.
      const broken = await callTool('firestore_simulator_create', { rules: unparseable });
      assert.equal(broken.ok, false, JSON.stringify(broken));
      assert.match(broken.summary, /^Firestore rules did not parse at line 4, column \\d+: /);
      assert.deepEqual(await activeRules(), before);
      await expectRulesInForce('open/c', 'locked/d');

      // A source production loads still seeds and reports active.
      const otherOnly = firestoreRules('/other/{id}');
      const loaded = await callTool('firestore_simulator_create', { rules: otherOnly });
      assert.equal(loaded.ok, true, JSON.stringify(loaded));
      const after = await activeRules();
      assert.equal(after.status, 'active');
      assert.equal(after.source, otherOnly);
      await expectRulesInForce('other/a', 'open/d');

      // A path that installs rules without the tool (a branch forked with
      // candidate rules, then promoted) never reports a refused source active.
      const forked = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.fork', args: { branch: 'storage-rules', candidateRules: storageAllowAll }, projectDir: dir, allowProduction: false },
        {},
      );
      assert.equal(forked.ok, true, JSON.stringify(forked));
      const promoted = await runtime.runMethod(
        { instanceId: runtime.instanceId, key: 'sandbox.promote', args: { branch: 'storage-rules', confirm: true }, projectDir: dir, allowProduction: false },
        {},
      );
      assert.equal(promoted.ok, true, JSON.stringify(promoted));
      const promotedRules = await activeRules();
      assert.equal(promotedRules.status, 'error', JSON.stringify(promotedRules));
      assert.equal(promotedRules.source, storageAllowAll);
      assert.equal(promotedRules.lastKnownGood, otherOnly);
      assert.deepEqual(promotedRules.messages.map((m) => m.text), [serviceReason]);
      assert.equal((await sendOp('tab-1', { method: 'setDoc', path: 'other/b', data: { v: 1 } })).ok, false);
    } finally {
      await runtime.close();
    }
  },
};

const target = process.argv[2];
try {
  await scenarios[target]();
} finally {
  await cleanupAll();
}
`;

describe('hosted Node runtime & repro hunt regressions (SW-HST-1..10)', () => {
  let bundleDir = '';
  let scenarioPath = '';

  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), 'pyric-hosted-hunt-bundle-'));
    symlinkSync(new URL('../../../../node_modules', import.meta.url).pathname, join(bundleDir, 'node_modules'), 'dir');
    const distUrl = new URL('../../dist', import.meta.url).href;
    const entry = join(bundleDir, 'entry.ts');
    writeFileSync(entry, SCENARIO_SOURCE.replaceAll('@dist/', `${distUrl}/`));
    const build = await Bun.build({
      entrypoints: [entry],
      outdir: bundleDir,
      target: 'node',
      packages: 'external',
      naming: 'scenario.mjs',
    });
    expect(build.success).toBe(true);
    scenarioPath = join(bundleDir, 'scenario.mjs');
  });

  afterAll(() => {
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  });

  function runScenario(id: string): void {
    const result = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [scenarioPath, id], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0) {
      throw new Error(`Scenario ${id} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
  }

  test('SW-HST-1: sandbox.reset preserves active rules, RTDB rules, live subscriptions, and reconciles cleared sessions', () => {
    runScenario('sw-hst-1');
  }, 30_000);

  test('SW-HST-3: resumeSession revives disconnected sessions while keeping non-resumed disconnects closed, and routes replies per message transport', () => {
    runScenario('sw-hst-3');
  }, 30_000);

  test('SW-HST-4: deployRules rejects invalid Firestore/RTDB rules without poisoning repro entries, and rules.set updates activeRules', () => {
    runScenario('sw-hst-4');
  }, 30_000);

  test('SW-HST-5: storage byte route rejects out-of-bounds, backwards, and mismatched-length Content-Range requests with 400', () => {
    runScenario('sw-hst-5');
  }, 30_000);

  test('SW-HST-7b: captureReproBase preserves RTDB priorities on non-default instances across window rollovers', () => {
    runScenario('sw-hst-7b');
  }, 30_000);

  test('SW-HST-8: repro records worker-client-disconnect / worker-client-interrupted and Storage HTTP byte-route uploads across both planes', () => {
    runScenario('sw-hst-8');
  }, 30_000);

  test('SW-HST-9: custom-token signInProvider and customClaims survive repro window rollover on replay', () => {
    runScenario('sw-hst-9');
  }, 30_000);

  test('SW-HST-10: runMethod, captureRepro, and mcpProjectError accept symlinked project directories while rejecting outside directories', () => {
    runScenario('sw-hst-10');
  }, 30_000);

  test('SW-HST-11: caller defaultBucket aliases persist across Node host restarts so download URLs resolve on cold boot', () => {
    runScenario('sw-hst-11');
  }, 30_000);

  test('SW-HST-12: firestore_simulator_create refuses rules production would not load, and the host never reports a refused source active (FS2-ENF-3a, FS2-ENF-3b)', () => {
    runScenario('sw-hst-12');
  }, 30_000);
});
