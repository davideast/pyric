/**
 * The live host's observed session data routes on a real bridge mount with a
 * hosted sandbox: observed data stays in memory until a confirmed
 * `POST /__pyric/live/seed-sandbox`, Live mode keeps refusing ordinary reads
 * and writes, and `merge` and `replace` persist to `.pyric/state/hosted` for a
 * later offline sandbox. It runs the built packages in a Node process, since
 * the hosted runtime persists through `node:sqlite`.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliDist = resolve(import.meta.dir, '../../dist');
const liveDist = resolve(import.meta.dir, '../../../live/dist');

const NODE_E2E_SCENARIO = `
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeMount } from ${JSON.stringify(pathToFileURL(join(cliDist, 'serve/bridge-mount.js')).href)};
import { createLiveHostState } from ${JSON.stringify(pathToFileURL(join(cliDist, 'serve/live-host-state.js')).href)};
import { liveWriteRefusal } from ${JSON.stringify(pathToFileURL(join(liveDist, 'refusal.js')).href)};

const OPEN_RULES = "rules_version = '2';\\nservice cloud.firestore { match /databases/{db}/documents { match /{p=**} { allow read, write: if true; } } }";
const dir = mkdtempSync(join(tmpdir(), 'pyric-live-seed-e2e-'));

// 0. Pre-seed one local-only document ('rooms/stale') in an offline sandbox so we can verify:
//    (a) Live mode never mixes local sandbox docs into /__pyric/live/session-data,
//    (b) Live mode never writes observed docs onto disk until explicit confirm:true,
//    (c) mode:'merge' keeps 'rooms/stale' + adds 'rooms/alpha',
//    (d) mode:'replace' removes 'rooms/stale' leaving only 'rooms/alpha'.
const preMount = createBridgeMount({
  hosted: true,
  project: 'demo-e2e',
  projectKey: dir,
  disableAuditLog: true,
  upgradeGuard: { boundHost: '127.0.0.1' },
});
const preServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  preMount.handler(req, res, url).then((h) => { if (!h) res.writeHead(404).end(); });
});
await new Promise((resolve) => preServer.listen(0, '127.0.0.1', resolve));
const prePort = preServer.address().port;
const preUrl = 'http://127.0.0.1:' + prePort;
await preMount.startHostedSandbox(
  {
    rules: OPEN_RULES,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: preMount.wsUrl({ host: '127.0.0.1', port: prePort }),
    seed: null,
    capture: false,
    hosted: true,
    projectKey: dir,
    sessionToken: 'pre-token',
    permissive: false,
    appOptions: { projectId: 'demo-e2e' },
  },
  preUrl,
);
await fetch(preUrl + '/__pyric/hosted/method', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: preMount.instanceId, projectDir: dir, key: 'firestore.setDoc', args: { path: 'rooms/stale', data: { stale: true } }, allowProduction: false }),
});
await preMount.close();
await new Promise((resolve) => preServer.close(resolve));

const liveHost = createLiveHostState({
  configProjectId: 'demo-e2e',
  configSource: 'firebaserc',
  optionName: '--project',
  warn: () => {},
});

const mount = createBridgeMount({
  hosted: true,
  project: 'demo-e2e',
  projectKey: dir,
  disableAuditLog: true,
  upgradeGuard: { boundHost: '127.0.0.1' },
  liveHost,
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  mount.handler(req, res, url).then((handled) => {
    if (!handled) {
      res.writeHead(404).end();
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = 'http://127.0.0.1:' + port;
const attachment = mount.attachHost({
  servers: [server],
  projectDir: dir,
  origin: () => ({ host: '127.0.0.1', port }),
});

await mount.startHostedSandbox(
  {
    rules: OPEN_RULES,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: mount.wsUrl({ host: '127.0.0.1', port }),
    seed: null,
    capture: false,
    hosted: true,
    projectKey: dir,
    sessionToken: 'live-seed-token',
    permissive: false,
    appOptions: { projectId: 'demo-e2e' },
  },
  baseUrl,
  { ownWriteRefusal: liveWriteRefusal },
);

// 1. Accepted observe frame populates in-memory sessionData; failed observe frame is ignored.
liveHost.inbound({
  type: 'worker-message',
  clientSessionId: 'tab-1',
  message: {
    t: 'observe',
    id: 'obs-ok',
    call: { service: 'firestore', method: 'getDoc', path: 'rooms/alpha', projectId: 'demo-e2e', at: 1, outcome: { status: 'ok' } },
    sessionData: {
      firestore: [{ kind: 'set', path: 'rooms/alpha', data: { title: 'Alpha', count: 5 } }],
      rtdb: [{ kind: 'set', instance: 'demo-e2e-default-rtdb', path: '/status/alpha', value: 'active' }],
    },
  },
});
liveHost.outbound({
  type: 'worker-message-result',
  clientSessionId: 'tab-1',
  message: { t: 'res', id: 'obs-ok', ok: true, value: undefined },
});

liveHost.inbound({
  type: 'worker-message',
  clientSessionId: 'tab-1',
  message: {
    t: 'observe',
    id: 'obs-err',
    call: { service: 'firestore', method: 'getDoc', path: 'rooms/denied', projectId: 'demo-e2e', at: 2, outcome: { status: 'error', code: 'permission-denied' } },
    sessionData: {
      firestore: [{ kind: 'set', path: 'rooms/denied', data: { secret: 'nope' } }],
    },
  },
});
liveHost.outbound({
  type: 'worker-message-result',
  clientSessionId: 'tab-1',
  message: { t: 'res', id: 'obs-err', ok: true, value: undefined },
});

// 2. Session-data HTTP GET shows ONLY observed data while local hosted sqlite still has ONLY the 1 pre-seeded doc.
const sessionRes = await fetch(baseUrl + '/__pyric/live/session-data');
const sessionSnap = await sessionRes.json();

const callHostedMethod = async (key, args) => {
  const res = await fetch(baseUrl + '/__pyric/hosted/method', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: mount.instanceId, projectDir: dir, key, args, allowProduction: false }),
  });
  return res.json();
};

const inspectBefore = await callHostedMethod('sandbox.inspect', {});
const liveReadBefore = await callHostedMethod('firestore.getDoc', { path: 'rooms/alpha' });
const directWriteBefore = await callHostedMethod('firestore.setDoc', { path: 'rooms/beta', data: { x: 1 } });
const gitignoreBefore = existsSync(join(dir, '.gitignore'));

// 3. Seed route WITHOUT confirm:true is refused with 400 PYRIC_SEED_CONFIRM_REQUIRED; disk doc count stays 1.
const unconfirmedRes = await fetch(baseUrl + '/__pyric/live/seed-sandbox', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'merge' }),
});
const unconfirmedBody = await unconfirmedRes.json();
const inspectAfterUnconfirmed = await callHostedMethod('sandbox.inspect', {});

// 4. Explicit opt-in seed WITH confirm:true (mode: 'merge') adds rooms/alpha alongside rooms/stale (total 2 docs).
const mergeRes = await fetch(baseUrl + '/__pyric/live/seed-sandbox', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirm: true, mode: 'merge', instanceId: mount.instanceId, projectDir: dir }),
});
const mergeBody = await mergeRes.json();
const inspectAfterMerge = await callHostedMethod('sandbox.inspect', {});

// 5. Explicit opt-in seed WITH confirm:true (mode: 'replace') replaces local sandbox with ONLY observed data (total 1 doc).
const replaceRes = await fetch(baseUrl + '/__pyric/live/seed-sandbox', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ confirm: true, mode: 'replace', instanceId: mount.instanceId, projectDir: dir }),
});
const replaceBody = await replaceRes.json();
const inspectAfterReplace = await callHostedMethod('sandbox.inspect', {});

// Normal Live-mode reads (without a connected tab) and writes MUST STILL be refused with PYRIC_LIVE_REFUSED!
const liveReadAfter = await callHostedMethod('firestore.getDoc', { path: 'rooms/alpha' });
const directWriteAfter = await callHostedMethod('firestore.setDoc', { path: 'rooms/gamma', data: { x: 2 } });
const gitignore = existsSync(join(dir, '.gitignore')) ? readFileSync(join(dir, '.gitignore'), 'utf8') : '';

await attachment.close();
await mount.close();
await new Promise((resolve) => server.close(resolve));

// 6. Re-open a fresh offline sandbox runtime (without Live refusal) on the same projectDir to prove .pyric/state/hosted persisted Firestore + RTDB and cleared rooms/stale!
const verifyMount = createBridgeMount({
  hosted: true,
  project: 'demo-e2e',
  projectKey: dir,
  disableAuditLog: true,
  upgradeGuard: { boundHost: '127.0.0.1' },
});
const verifyServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  verifyMount.handler(req, res, url).then((h) => { if (!h) res.writeHead(404).end(); });
});
await new Promise((resolve) => verifyServer.listen(0, '127.0.0.1', resolve));
const verifyPort = verifyServer.address().port;
const verifyUrl = 'http://127.0.0.1:' + verifyPort;
await verifyMount.startHostedSandbox(
  {
    rules: OPEN_RULES,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: verifyMount.wsUrl({ host: '127.0.0.1', port: verifyPort }),
    seed: null,
    capture: false,
    hosted: true,
    projectKey: dir,
    sessionToken: 'verify-token',
    permissive: false,
    appOptions: { projectId: 'demo-e2e' },
  },
  verifyUrl,
);
const callVerifyMethod = async (key, args) => {
  const res = await fetch(verifyUrl + '/__pyric/hosted/method', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: verifyMount.instanceId, projectDir: dir, key, args, allowProduction: false }),
  });
  return res.json();
};
const persistedAlpha = await callVerifyMethod('firestore.getDoc', { path: 'rooms/alpha' });
const persistedStale = await callVerifyMethod('firestore.getDoc', { path: 'rooms/stale' });
const persistedRtdb = await callVerifyMethod('database.get', { path: 'status/alpha', instance: 'demo-e2e-default-rtdb' });
const nonLiveSessionRoute = await fetch(verifyUrl + '/__pyric/live/session-data');

await verifyMount.close();
await new Promise((resolve) => verifyServer.close(resolve));
rmSync(dir, { recursive: true, force: true });

console.log('E2E_OUTCOME ' + JSON.stringify({
  sessionFirestoreKeys: Object.keys(sessionSnap.firestore),
  sessionRtdb: sessionSnap.rtdb,
  docsBeforeSeed: inspectBefore.data?.documents?.totalCount ?? null,
  docsAfterUnconfirmed: inspectAfterUnconfirmed.data?.documents?.totalCount ?? null,
  docsAfterMerge: inspectAfterMerge.data?.documents?.totalCount ?? null,
  docsAfterReplace: inspectAfterReplace.data?.documents?.totalCount ?? null,
  gitignoreBefore,
  liveReadBeforeCode: liveReadBefore.data?.code ?? null,
  liveReadAfterCode: liveReadAfter.data?.code ?? null,
  directWriteBeforeCode: directWriteBefore.data?.code ?? null,
  directWriteAfterCode: directWriteAfter.data?.code ?? null,
  unconfirmedStatus: unconfirmedRes.status,
  unconfirmedCode: unconfirmedBody.code,
  mergeBody,
  replaceBody,
  gitignoreHasPyric: gitignore.includes('.pyric/'),
  persistedAlphaData: persistedAlpha.data?.data ?? null,
  persistedStaleExists: persistedStale.data?.exists ?? null,
  persistedRtdbData: persistedRtdb.data ?? null,
  nonLiveSessionStatus: nonLiveSessionRoute.status,
}));
`;

describe('Live host observed-session-data & opt-in seeding end-to-end (Node sqlite)', () => {
  it('keeps observed data memory-only until explicit confirm:true seed, preserves PYRIC_LIVE_REFUSED on normal reads/writes, and persists merge/replace for offline sandbox use', () => {
    for (const built of [join(cliDist, 'serve/bridge-mount.js'), join(liveDist, 'refusal.js')]) {
      if (!existsSync(built)) {
        throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), 'pyric-live-seed-runner-'));
    try {
      const script = join(dir, 'scenario.mjs');
      writeFileSync(script, NODE_E2E_SCENARIO);
      const result = spawnSync('node', [script], { encoding: 'utf8', timeout: 60_000 });
      if (result.status !== 0) {
        throw new Error(`Node scenario failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
      }
      const line = result.stdout
        .split('\n')
        .find((entry) => entry.startsWith('E2E_OUTCOME '));
      expect(line).toBeDefined();
      const outcome = JSON.parse(line!.slice('E2E_OUTCOME '.length));

      expect(outcome.sessionFirestoreKeys).toEqual(['rooms/alpha']);
      expect(outcome.sessionRtdb).toEqual({
        'demo-e2e-default-rtdb': { status: { alpha: 'active' } },
      });
      // Before explicit opt-in seeding: hosted sqlite still holds only the 1 pre-existing doc, and .gitignore is untouched.
      expect(outcome.docsBeforeSeed).toBe(1);
      expect(outcome.docsAfterUnconfirmed).toBe(1);
      expect(outcome.gitignoreBefore).toBe(false);
      // Normal Live-mode service reads (without a connected tab) and writes remain refused with PYRIC_LIVE_REFUSED before AND after seeding.
      expect(outcome.liveReadBeforeCode).toBe('PYRIC_LIVE_REFUSED');
      expect(outcome.liveReadAfterCode).toBe('PYRIC_LIVE_REFUSED');
      expect(outcome.directWriteBeforeCode).toBe('PYRIC_LIVE_REFUSED');
      expect(outcome.directWriteAfterCode).toBe('PYRIC_LIVE_REFUSED');
      // Unconfirmed POST is rejected.
      expect(outcome.unconfirmedStatus).toBe(400);
      expect(outcome.unconfirmedCode).toBe('PYRIC_SEED_CONFIRM_REQUIRED');
      // Confirmed merge adds rooms/alpha alongside rooms/stale (2 docs); confirmed replace removes rooms/stale (1 doc).
      expect(outcome.mergeBody).toMatchObject({
        ok: true,
        mode: 'merge',
        seededFirestoreDocs: 1,
        seededRtdbInstances: ['demo-e2e-default-rtdb'],
      });
      expect(outcome.docsAfterMerge).toBe(2);
      expect(outcome.replaceBody).toMatchObject({
        ok: true,
        mode: 'replace',
        seededFirestoreDocs: 1,
        seededRtdbInstances: ['demo-e2e-default-rtdb'],
      });
      expect(outcome.docsAfterReplace).toBe(1);
      expect(outcome.gitignoreHasPyric).toBe(true);
      // Subsequent offline `pyric sandbox` run hydrates rooms/alpha + RTDB from .pyric/state/hosted and sees rooms/stale removed!
      expect(outcome.persistedAlphaData).toEqual({ title: 'Alpha', count: 5 });
      expect(outcome.persistedStaleExists).toBe(false);
      expect(outcome.persistedRtdbData).toEqual({ exists: true, value: 'active' });
      // Non-live sandbox host returns 404 on /__pyric/live/session-data.
      expect(outcome.nonLiveSessionStatus).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
