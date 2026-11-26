import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryBackend, type PersistenceBackend } from 'pyric/sandbox';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime, type HostedRuntime } from '../../src/serve/hosted/runtime.js';
import { useTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerUrl = pathToFileURL(join(cliRoot, 'dist/register/index.js')).href;
const pyricSandboxUrl = pathToFileURL(join(repoRoot, 'packages/pyric/dist/sandbox/index.js')).href;

const makeTempDir = useTempDirs('pyric-reg-server-app-');

function makeInMemoryHostedPersistence(backend: PersistenceBackend): HostedPersistence {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend,
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    seed: async () => false,
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
  } as unknown as HostedPersistence;
}

interface SocketData {
  readonly sessionId: string;
}

async function startHostedFirestoreServer(projectDir: string, firestoreRules: string) {
  const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
  let baseOrigin = 'http://127.0.0.1:0';
  let nextSession = 0;

  const runtime: HostedRuntime = await createHostedRuntime(
    {
      rules: firestoreRules,
      rulesHash: 'rules-1644',
      databaseRules: null,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      projectKey: projectDir,
      permissive: false,
      appOptions: { projectId: 'demo-server-app-reg' },
    },
    () => baseOrigin,
    (frame) => {
      const forwards =
        frame.type === 'worker-message-result'
        || frame.type === 'worker-res'
        || frame.type === 'worker-snap';
      if (!forwards || typeof frame.clientSessionId !== 'string') return;
      const ws = sockets.get(frame.clientSessionId);
      if (ws !== undefined) {
        ws.send(JSON.stringify(frame));
      }
    },
    projectDir,
    {
      persistence: makeInMemoryHostedPersistence(createMemoryBackend()),
      record: false,
    },
  );

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/__pyric/health') {
        return Response.json({
          ok: true,
          instanceId: runtime.instanceId,
          projectKey: projectDir,
          mode: 'sandbox',
        });
      }
      if (url.pathname === '/__pyric/init.json') {
        return Response.json({
          hosted: true,
          bridgeUrl: '/__pyric/sandbox',
          projectKey: projectDir,
          instanceId: runtime.instanceId,
        });
      }
      nextSession += 1;
      const sessionId = `srv-app-s-${nextSession}`;
      if (srv.upgrade(req, { data: { sessionId } })) return undefined;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.set(ws.data.sessionId, ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as BridgeMessage;
        if (msg.type === 'attach') {
          ws.send(
            JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: ws.data.sessionId,
              projectKey: projectDir,
              hostInstanceId: runtime.instanceId,
              capabilities: ['worker-port', 'worker-relay'],
            } satisfies BridgeMessage),
          );
          return;
        }
        if (msg.type === 'worker-message') {
          runtime.receive({
            type: 'worker-message',
            clientSessionId: ws.data.sessionId,
            message: msg.message,
            platform: 'node',
          });
        }
      },
      close(ws) {
        sockets.delete(ws.data.sessionId);
        runtime.receive({
          type: 'worker-client-disconnect',
          clientSessionId: ws.data.sessionId,
        });
      },
    },
  });
  baseOrigin = `http://127.0.0.1:${server.port}`;

  return {
    origin: baseOrigin,
    instanceId: runtime.instanceId,
    async stop() {
      await runtime.close();
      await server.stop(true);
    },
  };
}

describe('@pyric/cli/register initializeServerApp & settings.appCheckToken parity (#1644)', () => {
  it('admits a createToken-minted settings.appCheckToken and refuses an invalid token in a registered Node process (PYRIC_SANDBOX=local)', () => {
    const dir = makeTempDir();
    const scriptPath = join(dir, 'server-app-local.mjs');
    writeFileSync(
      scriptPath,
      `import assert from 'node:assert/strict';
import { initializeSandbox } from ${JSON.stringify(pyricSandboxUrl)};
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAppCheck as getAdminAppCheck } from 'firebase-admin/app-check';
import { initializeServerApp, getApps, deleteApp } from 'firebase/app';
import { getAI, getGenerativeModel } from 'firebase/ai';

const APP_ID = '1:123456789012:web:regserverapp01';
const PROJECT_ID = 'demo-server-app-local';
const OPTIONS = { apiKey: 'fake-api-key', projectId: PROJECT_ID, appId: APP_ID };

const adminApp = initAdmin({ sandbox: initializeSandbox(), projectId: PROJECT_ID }, 'mint-helper');
const minted = await getAdminAppCheck(adminApp).createToken(APP_ID);

const validServerApp = initializeServerApp(OPTIONS, { appCheckToken: minted.token });
assert.equal(typeof initializeServerApp, 'function');
assert.equal(getApps().length, 0);
assert.equal(validServerApp.settings.appCheckToken, minted.token);

const validModel = getGenerativeModel(getAI(validServerApp), { model: 'gemini-flash-lite-latest' });
const answer = await validModel.generateContent('hello from registered server app');
assert.ok(answer.response.text().length > 0);

const invalidServerApp = initializeServerApp(OPTIONS, { appCheckToken: 'not-a-valid-app-check-jwt' });
const invalidModel = getGenerativeModel(getAI(invalidServerApp), { model: 'gemini-flash-lite-latest' });
await assert.rejects(
  () => invalidModel.generateContent('must be refused'),
  (err) => err && err.customErrorData && err.customErrorData.status === 401 && String(err.message).includes('Firebase App Check token is invalid.'),
);

await deleteApp(validServerApp);
await deleteApp(invalidServerApp);
assert.throws(
  () => validServerApp.name,
  (err) => err && err.code === 'app/server-app-deleted',
);

console.log('SERVER_APP_LOCAL_OK');
process.exit(0);
`,
    );

    const res = spawnSync('node', ['--import', registerUrl, scriptPath], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development', PYRIC_SANDBOX: 'local' },
    });
    if (res.status !== 0) {
      throw new Error(`server-app-local failed (${res.status}): ${res.stderr}\n${res.stdout}`);
    }
    expect(res.stdout).toContain('SERVER_APP_LOCAL_OK');
  }, 20_000);

  it('forwards settings.authIdToken on initializeServerApp in a registered Node process against a remote host (PYRIC_SANDBOX=remote)', async () => {
    const dir = makeTempDir();
    const rules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /ssr/{uid} {
            allow read, write: if request.auth != null && request.auth.uid == uid;
          }
        }
      }
    `;
    const host = await startHostedFirestoreServer(dir, rules);
    try {
      const scriptPath = join(dir, 'server-app-remote.mjs');
      writeFileSync(
        scriptPath,
        `import assert from 'node:assert/strict';
import { initializeApp, initializeServerApp, deleteApp, getApps } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, getIdToken } from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

const OPTIONS = {
  apiKey: 'fake-api-key',
  projectId: 'demo-server-app-reg',
  appId: '1:123456789012:web:regserverapp02',
};

const clientApp = initializeApp(OPTIONS);
const cred = await createUserWithEmailAndPassword(getAuth(clientApp), 'ssr@example.com', 'password123');
const idToken = await getIdToken(cred.user);

const serverApp = initializeServerApp(OPTIONS, { authIdToken: idToken });
assert.equal(getApps().length, 1);

const serverDb = getFirestore(serverApp);
await setDoc(doc(serverDb, 'ssr', cred.user.uid), { fromServerApp: true });
const snap = await getDoc(doc(serverDb, 'ssr', cred.user.uid));
assert.deepEqual(snap.data(), { fromServerApp: true });

const anonServerApp = initializeServerApp(OPTIONS, { automaticDataCollectionEnabled: false });
await assert.rejects(() => setDoc(doc(getFirestore(anonServerApp), 'ssr', cred.user.uid), { denied: true }));

await deleteApp(serverApp);
await deleteApp(anonServerApp);
await deleteApp(clientApp);
console.log('SERVER_APP_REMOTE_OK');
process.exit(0);
`,
      );

      const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolveChild, rejectChild) => {
          const child = spawn('node', ['--import', registerUrl, scriptPath], {
            cwd: dir,
            env: {
              ...process.env,
              NODE_ENV: 'development',
              PYRIC_SANDBOX: `remote:${host.origin}`,
              PYRIC_SANDBOX_INSTANCE: host.instanceId,
            },
          });
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
        throw new Error(`server-app-remote failed (${res.status}): ${res.stderr}\n${res.stdout}`);
      }
      expect(res.stdout).toContain('SERVER_APP_REMOTE_OK');
    } finally {
      await host.stop();
    }
  }, 25_000);
});
