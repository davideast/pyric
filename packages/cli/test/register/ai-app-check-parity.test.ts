import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryBackend, type PersistenceBackend } from 'pyric/sandbox';
import { useTempDirs } from '../use-temp-dirs.js';
import { startInMemoryRemoteHost } from './remote-host-test-support.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerUrl = pathToFileURL(join(cliRoot, 'dist/register/index.js')).href;
const hostedRuntimeUrl = pathToFileURL(join(cliRoot, 'dist/serve/hosted/runtime.js')).href;
const pyricSandboxUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/sandbox/index.js')).href;
const pyricSandboxInternalUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/sandbox/internal/index.js')).href;
const pyricAppUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/app/index.js')).href;
const pyricAppCheckUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/app-check/index.js')).href;
const pyricAiUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/ai/index.js')).href;
const pyricAiInternalUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/ai/internal.js')).href;
const adminAppUrl = pathToFileURL(join(repoRoot, 'packages/pyric-admin/dist/app/index.js')).href;
const adminAppCheckUrl = pathToFileURL(join(repoRoot, 'packages/pyric-admin/dist/app-check/index.js')).href;

const makeTempDir = useTempDirs('pyric-reg-ai-ac-');

async function startRemoteHostForChildren(projectDir: string, backend: PersistenceBackend) {
  return startInMemoryRemoteHost({
    projectKey: projectDir,
    backend,
    writePointerInDir: projectDir,
  });
}

describe('@pyric/cli/register AI Logic & App Check parity (#1910, #1911, #1912, #1913, #1297)', () => {
  it('verifies #1910, #1911, #1912, and #1913 in a Node child process across sandbox and transport AI', () => {
    const dir = makeTempDir();
    const scriptPath = join(dir, 'node-ai-ac-check.mjs');
    writeFileSync(
      scriptPath,
      `import assert from 'node:assert/strict';
import { initializeSandbox } from ${JSON.stringify(pyricSandboxUrl)};
import { initializeApp, deleteApp } from ${JSON.stringify(pyricAppUrl)};
import { CustomProvider, getToken, initializeAppCheck, onTokenChanged } from ${JSON.stringify(pyricAppCheckUrl)};
import { getAI, getGenerativeModel, GoogleAIBackend } from ${JSON.stringify(pyricAiUrl)};
import { createTransportAI } from ${JSON.stringify(pyricAiInternalUrl)};
import { initializeApp as initAdmin } from ${JSON.stringify(adminAppUrl)};
import { getAppCheck as getAdminAppCheck } from ${JSON.stringify(adminAppCheckUrl)};

const APP_ID = '1:123456789012:web:nodecheck01';
const PROJECT_ID = 'demo-node-ai-ac';
const VALID = { apiKey: 'fake-api-key', projectId: PROJECT_ID, appId: APP_ID };

const adminApp = initAdmin({ sandbox: initializeSandbox(), projectId: PROJECT_ID }, 'mint-helper');
const adminAc = getAdminAppCheck(adminApp);
const mintedOne = await adminAc.createToken(APP_ID);
const mintedTwo = await adminAc.createToken(APP_ID);
const mintedThree = await adminAc.createToken(APP_ID);

// #1911: initializeAppCheck on a deleted app throws app/app-deleted
const deletedApp = initializeApp(VALID, 'deleted-app');
await deleteApp(deletedApp);
assert.throws(
  () => initializeAppCheck(deletedApp, { provider: new CustomProvider({ getToken: async () => ({ token: mintedOne.token, expireTimeMillis: Date.now() + 60000 }) }) }),
  (err) => err && err.code === 'app/app-deleted',
);

// #1913: plain synchronous token return and synchronous throw
const syncApp = initializeApp(VALID, 'sync-provider');
let syncCalls = 0;
const syncAc = initializeAppCheck(syncApp, {
  provider: new CustomProvider({
    getToken: () => {
      syncCalls += 1;
      let tok = mintedThree.token;
      if (syncCalls === 1) {
        tok = mintedOne.token;
      } else if (syncCalls === 2) {
        tok = mintedTwo.token;
      }
      return {
        token: tok,
        expireTimeMillis: Date.now() + 60000,
      };
    },
  }),
  isTokenAutoRefreshEnabled: false,
});
const firstTok = await getToken(syncAc);
assert.equal(firstTok.token, mintedOne.token);

// #1910: latest getAI call governs options on both sandboxAI and createTransportAI on Node
const aiDefault = getAI(syncApp);
assert.deepEqual(aiDefault.options, { useLimitedUseAppCheckTokens: false });
const cachedModel = getGenerativeModel(aiDefault, { model: 'gemini-flash-lite-latest' });

const aiLimited = getAI(syncApp, { useLimitedUseAppCheckTokens: true });
assert.equal(aiLimited, aiDefault);
assert.deepEqual(aiLimited.options, { useLimitedUseAppCheckTokens: true });
const limitedModel = getGenerativeModel(aiLimited, { model: 'gemini-flash-lite-latest' });

await cachedModel.generateContent('hello');
assert.equal(syncCalls, 1);
await limitedModel.generateContent('hello limited');
assert.equal(syncCalls, 2);

const fakeTransport = {
  async generateContent() {
    return {
      candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ok' }] } }],
    };
  },
  async *generateContentStream() {},
  async countTokens() {
    return { totalTokens: 1 };
  },
};
const transportDefault = createTransportAI(syncApp, undefined, fakeTransport);
assert.deepEqual(transportDefault.options, { useLimitedUseAppCheckTokens: false });
const transportLimited = createTransportAI(
  syncApp,
  { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true },
  fakeTransport,
);
assert.equal(transportLimited, transportDefault);
assert.deepEqual(transportLimited.options, { useLimitedUseAppCheckTokens: true });
const transportLimitedModel = getGenerativeModel(transportLimited, { model: 'gemini-flash-lite-latest' });
await transportLimitedModel.generateContent('hello transport');
assert.equal(syncCalls, 3);

const syncThrowApp = initializeApp(VALID, 'sync-throw');
const syncThrowAc = initializeAppCheck(syncThrowApp, {
  provider: new CustomProvider({
    getToken: () => {
      throw new Error('node sync throw');
    },
  }),
  isTokenAutoRefreshEnabled: false,
});
const seenErrors = [];
onTokenChanged(syncThrowAc, () => {}, (err) => seenErrors.push(err.message));
await assert.rejects(() => getToken(syncThrowAc), /node sync throw/);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(seenErrors, ['node sync throw']);

console.log('NODE_PARITY_OK');
process.exit(0);
`,
    );

    const res = spawnSync('node', [scriptPath], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`node-ai-ac-check failed (${res.status}): ${res.stderr}\n${res.stdout}`);
    }
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('NODE_PARITY_OK');

    // #1912: each incomplete FirebaseOptions config throws its exact AIErrorCode before any request
    const incompleteCases = [
      {
        options: { projectId: 'demo-node-ai-ac', appId: '1:123456789012:web:nodecheck01' },
        expectedCode: 'no-api-key',
        expectedSnippet: 'The "apiKey" field is empty in the local Firebase config.',
      },
      {
        options: { apiKey: 'fake-api-key', appId: '1:123456789012:web:nodecheck01' },
        expectedCode: 'no-project-id',
        expectedSnippet: 'The "projectId" field is empty in the local Firebase config.',
      },
      {
        options: { apiKey: 'fake-api-key', projectId: 'demo-node-ai-ac' },
        expectedCode: 'no-app-id',
        expectedSnippet: 'The "appId" field is empty in the local Firebase config.',
      },
    ];
    for (const c of incompleteCases) {
      const checkScript = [
        "import assert from 'node:assert/strict';",
        `import { initializeApp } from ${JSON.stringify(pyricAppUrl)};`,
        `import { getAI, getGenerativeModel } from ${JSON.stringify(pyricAiUrl)};`,
        `const app = initializeApp(${JSON.stringify(c.options)});`,
        'assert.throws(',
        "  () => getGenerativeModel(getAI(app), { model: 'gemini-flash-lite-latest' }),",
        `  (err) => err && err.code === ${JSON.stringify(c.expectedCode)} && String(err.message).includes(${JSON.stringify(c.expectedSnippet)}),`,
        ');',
        "console.log('MISSING_CONFIG_OK');",
      ].join('\n');
      const caseRes = spawnSync('node', ['--input-type=module', '-e', checkScript], {
        cwd: dir,
        encoding: 'utf8',
      });
      if (caseRes.status !== 0) {
        throw new Error(`#1912 case ${c.expectedCode} failed: ${caseRes.stderr}\n${caseRes.stdout}`);
      }
      expect(caseRes.stdout).toContain('MISSING_CONFIG_OK');
    }

    // Also verify firebase/* imports rewritten by node --import @pyric/cli/register (PYRIC_SANDBOX=local)
    const regLocalSource = `import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { CustomProvider, getToken, initializeAppCheck } from 'firebase/app-check';
import { getAI, getGenerativeModel } from 'firebase/ai';
import { mintAppCheckToken } from ${JSON.stringify(pyricSandboxInternalUrl)};

const APP_ID = '1:123456789012:web:reglocal01';
const PROJECT_ID = 'demo-reg-local';
const VALID = { apiKey: 'fake-api-key', projectId: PROJECT_ID, appId: APP_ID };

const t1 = await mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 3600);
const t2 = await mintAppCheckToken({ appId: APP_ID, projectId: PROJECT_ID }, 3600);

const deleted = initializeApp(VALID, 'reg-deleted');
await deleteApp(deleted);
assert.throws(
  () => initializeAppCheck(deleted, { provider: new CustomProvider({ getToken: async () => t1 }) }),
  (err) => err && err.code === 'app/app-deleted',
);

const app = initializeApp(VALID, 'reg-live');
let calls = 0;
const ac = initializeAppCheck(app, {
  provider: new CustomProvider({
    getToken: () => {
      calls += 1;
      if (calls === 1) return t1;
      return t2;
    },
  }),
  isTokenAutoRefreshEnabled: false,
});
await getToken(ac);

const ai = getAI(app);
assert.deepEqual(ai.options, { useLimitedUseAppCheckTokens: false });
const sameAi = getAI(app, { useLimitedUseAppCheckTokens: true });
assert.equal(sameAi, ai);
assert.deepEqual(sameAi.options, { useLimitedUseAppCheckTokens: true });
const model = getGenerativeModel(sameAi, { model: 'gemini-flash-lite-latest' });
await model.generateContent('hello register local');
assert.equal(calls, 2);
console.log('REG_LOCAL_OK');
`;
    const regLocalRes = spawnSync(
      'node',
      ['--import', registerUrl, '--input-type=module', '-e', regLocalSource],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'development', PYRIC_SANDBOX: 'local' },
      },
    );
    if (regLocalRes.status !== 0) {
      throw new Error(`reg-local-ai-ac failed (${regLocalRes.status}): ${regLocalRes.stderr}\n${regLocalRes.stdout}`);
    }
    expect(regLocalRes.stdout).toContain('REG_LOCAL_OK');
  }, 25_000);

  it(
    'shares verifyToken(..., { consume: true }) across two sibling registered Node processes and real SQLite HostedRuntime restart (#1297)',
    async () => {
    const projectDir = makeTempDir();
    const durableBackend = createMemoryBackend();
    const consumerScript = join(projectDir, 'consume-worker.mjs');
    writeFileSync(
      consumerScript,
      `import { initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';

const action = process.argv[2];
const arg = process.argv[3];
const app = initializeApp({ projectId: 'demo-reg-remote' });
const ac = getAppCheck(app);

if (action === 'mint-and-consume') {
  const { token } = await ac.createToken(arg);
  const res = await ac.verifyToken(token, { consume: true });
  console.log(JSON.stringify({ token, alreadyConsumed: res.alreadyConsumed }));
} else if (action === 'consume') {
  const res = await ac.verifyToken(arg, { consume: true });
  console.log(JSON.stringify({ alreadyConsumed: res.alreadyConsumed }));
}
process.exit(0);
`,
    );

    const runConsumer = async (origin: string, instanceId: string, args: string[]) => {
      const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolveChild, rejectChild) => {
          const child = spawn(
            'node',
            ['--import', registerUrl, consumerScript, ...args],
            {
              cwd: projectDir,
              env: {
                ...process.env,
                NODE_ENV: 'development',
                PYRIC_SANDBOX: `remote:${origin}`,
                PYRIC_SANDBOX_INSTANCE: instanceId,
              },
            },
          );
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.on('error', rejectChild);
          child.on('close', (status) => {
            resolveChild({ status, stdout, stderr });
          });
        },
      );
      if (res.status !== 0) {
        throw new Error(`child failed (${res.status}): ${res.stderr}\n${res.stdout}`);
      }
      const lines = res.stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      return JSON.parse(lastLine) as {
        token?: string;
        alreadyConsumed: boolean;
      };
    };

    const host1 = await startRemoteHostForChildren(projectDir, durableBackend);
    let mintedToken = '';
    try {
      const firstProc = await runConsumer(host1.origin, host1.instanceId, [
        'mint-and-consume',
        '1:123456789012:web:sibproc01',
      ]);
      expect(firstProc.alreadyConsumed).toBe(false);
      if (firstProc.token === undefined) {
        throw new Error('expected firstProc to return minted token');
      }
      mintedToken = firstProc.token;

      const secondProc = await runConsumer(host1.origin, host1.instanceId, [
        'consume',
        mintedToken,
      ]);
      expect(secondProc.alreadyConsumed).toBe(true);
    } finally {
      await host1.stop();
    }

    const host2 = await startRemoteHostForChildren(projectDir, durableBackend);
    try {
      const thirdProcAfterRestart = await runConsumer(host2.origin, host2.instanceId, [
        'consume',
        mintedToken,
      ]);
      expect(thirdProcAfterRestart.alreadyConsumed).toBe(true);
    } finally {
      await host2.stop();
    }

    // Also verify real Node SQLite HostedRuntime persistence across disk restart.
    const sqliteDir = makeTempDir();
    const sqliteCheck = join(sqliteDir, 'sqlite-restart-check.mjs');
    writeFileSync(
      sqliteCheck,
      `import assert from 'node:assert/strict';
import { createHostedRuntime } from ${JSON.stringify(hostedRuntimeUrl)};

const dir = process.argv[2];
const payload = {
  rules: null,
  rulesHash: null,
  databaseRules: null,
  databaseRulesHash: null,
  databaseInstances: {
    defaultInstance: 'demo-sqlite-default-rtdb',
    projectId: 'demo-sqlite',
    rules: {},
  },
  storageRules: null,
  storageRulesHash: null,
  bridgeUrl: null,
  seed: null,
  capture: false,
  hosted: true,
  projectKey: dir,
  permissive: true,
};

const replies1 = [];
let runtime = await createHostedRuntime(
  payload,
  () => 'http://127.0.0.1:1',
  (msg) => replies1.push(msg),
  dir,
  { record: false },
);
runtime.receive({
  type: 'worker-message',
  clientSessionId: 'sqlite-s1',
  message: { t: 'op', id: 'op-1', method: 'appCheck.consumeToken', tokenId: 'sqlite-jti-99' },
});
while (replies1.length === 0) await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(replies1[0].message, {
  t: 'res',
  id: 'op-1',
  ok: true,
  value: { alreadyConsumed: false },
});
await runtime.close();

const replies2 = [];
runtime = await createHostedRuntime(
  payload,
  () => 'http://127.0.0.1:1',
  (msg) => replies2.push(msg),
  dir,
  { record: false },
);
runtime.receive({
  type: 'worker-message',
  clientSessionId: 'sqlite-s2',
  message: { t: 'op', id: 'op-2', method: 'appCheck.consumeToken', tokenId: 'sqlite-jti-99' },
});
while (replies2.length === 0) await new Promise((r) => setTimeout(r, 10));
assert.deepEqual(replies2[0].message, {
  t: 'res',
  id: 'op-2',
  ok: true,
  value: { alreadyConsumed: true },
});
await runtime.close();
console.log('SQLITE_RESTART_OK');
`,
    );

    const sqliteRes = spawnSync('node', [sqliteCheck, sqliteDir], {
      cwd: sqliteDir,
      encoding: 'utf8',
    });
    if (sqliteRes.status !== 0) {
      throw new Error(`sqlite-restart-check failed (${sqliteRes.status}): ${sqliteRes.stderr}\n${sqliteRes.stdout}`);
    }
    expect(sqliteRes.status).toBe(0);
    expect(sqliteRes.stdout).toContain('SQLITE_RESTART_OK');
    },
    20_000,
  );
});
