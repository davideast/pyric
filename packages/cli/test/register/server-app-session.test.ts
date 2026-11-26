import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryBackend, type PersistenceBackend } from 'pyric/sandbox';
import type { BridgeMessage } from '../../src/bridge/protocol.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime, type HostedRuntime } from '../../src/serve/hosted/runtime.js';
import { useTempDirs } from '../use-temp-dirs.js';

const cliRoot = resolve(import.meta.dir, '../..');
const registerUrl = pathToFileURL(join(cliRoot, 'dist/register/index.js')).href;
const pyricSandboxInternalUrl = pathToFileURL(
  join(cliRoot, '../pyric/dist/sandbox/internal/index.js'),
).href;
const PROJECT_ID = 'demo-server-session-remote';

const makeTempDir = useTempDirs('pyric-reg-server-session-');

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

async function startHostedServer(projectDir: string, firestoreRules: string) {
  const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
  let baseOrigin = 'http://127.0.0.1:0';
  let nextSession = 0;

  const runtime: HostedRuntime = await createHostedRuntime(
    {
      rules: firestoreRules,
      rulesHash: 'rules-server-session',
      databaseRules: null,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      projectKey: projectDir,
      permissive: false,
      appOptions: { projectId: PROJECT_ID },
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
      const sessionId = `srv-sess-${nextSession}`;
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
          return;
        }
        if (msg.type === 'worker-op') {
          runtime.receive({
            ...msg,
            clientSessionId: ws.data.sessionId,
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

describe('@pyric/cli/register remote server-app JWT hardening (PYRIC_SANDBOX=remote)', () => {
  it('enforces host verification for valid, revoked, disabled, deleted, and adversarial JWTs in remote mode', async () => {
    const dir = makeTempDir();
    const rules = `
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /ssr/{uid} {
            allow read, write: if request.auth != null && request.auth.uid == uid;
          }
          match /claims/{uid} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.auth.token.role == 'editor';
          }
          match /tenants/{tenantId}/items/{uid} {
            allow read, write: if request.auth != null
              && request.auth.uid == uid
              && request.auth.token.firebase.tenant == tenantId;
          }
        }
      }
    `;
    const host = await startHostedServer(dir, rules);
    try {
      const scriptPath = join(dir, 'remote-jwt-matrix.mjs');
      writeFileSync(
        scriptPath,
        `import assert from 'node:assert/strict';
import { initializeApp, initializeServerApp, deleteApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, getIdToken } from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import {
  mintIdToken,
  signSandboxJwtSync,
} from ${JSON.stringify(pyricSandboxInternalUrl)};

const OPTIONS = {
  apiKey: 'fake-api-key',
  projectId: ${JSON.stringify(PROJECT_ID)},
  appId: '1:123456789012:web:remotesess01',
};
const ID_TOKEN_KEY = 'pyric-sandbox-id-token-signing-key';
const SANDBOX_JWT_KID = 'pyric-sandbox';

async function waitAuthReady(authHandle) {
  // Node hosted realm intentionally unrefs Auth subscriptions; hold loop briefly while snapshot arrives.
  const hold = setInterval(() => {}, 50);
  try {
    await authHandle.authStateReady();
  } finally {
    clearInterval(hold);
  }
}

const clientApp = initializeApp(OPTIONS);
const adminApp = initAdmin({ projectId: OPTIONS.projectId }, 'remote-admin');
const adminAuth = getAdminAuth(adminApp);

// 1. Valid user + custom-claim token succeeds immediately without races.
const credA = await createUserWithEmailAndPassword(getAuth(clientApp), 'valid@example.com', 'password123');
const validToken = await getIdToken(credA.user);
const validServerApp = initializeServerApp(OPTIONS, { authIdToken: validToken });
await setDoc(doc(getFirestore(validServerApp), 'ssr', credA.user.uid), { ok: true });
const snapA = await getDoc(doc(getFirestore(validServerApp), 'ssr', credA.user.uid));
assert.deepEqual(snapA.data(), { ok: true });
const validServerAuth = getAuth(validServerApp);
await waitAuthReady(validServerAuth);
assert.equal(validServerAuth.currentUser?.uid, credA.user.uid);
await deleteApp(validServerApp);

// 2. Custom claims embedded in minted token are preserved on host rules evaluation.
const nowSec = Math.floor(Date.now() / 1000);
const editorToken = mintIdToken({
  aud: OPTIONS.projectId,
  iss: 'https://securetoken.google.com/' + OPTIONS.projectId,
  sub: credA.user.uid,
  user_id: credA.user.uid,
  auth_time: nowSec,
  iat: nowSec,
  exp: nowSec + 3600,
  role: 'editor',
  firebase: { identities: {}, sign_in_provider: 'password' },
});
const editorApp = initializeServerApp(OPTIONS, { authIdToken: editorToken });
await setDoc(doc(getFirestore(editorApp), 'claims', credA.user.uid), { edited: true });
await deleteApp(editorApp);

// 2b. Tenant claim is preserved end-to-end in remote mode.
const tenantAuth = getAuth(clientApp);
tenantAuth.tenantId = 'tenant-remote';
const credTenant = await createUserWithEmailAndPassword(tenantAuth, 'tenant@example.com', 'password123');
const tenantToken = await getIdToken(credTenant.user);
tenantAuth.tenantId = null;
const tenantServerApp = initializeServerApp(OPTIONS, { authIdToken: tenantToken });
await setDoc(doc(getFirestore(tenantServerApp), 'tenants', 'tenant-remote', 'items', credTenant.user.uid), { scoped: true });
await assert.rejects(() =>
  setDoc(doc(getFirestore(tenantServerApp), 'tenants', 'other-tenant', 'items', credTenant.user.uid), { scoped: false }),
);
await deleteApp(tenantServerApp);

// 3. Adversarial JWTs are rejected on the host and denied by Firestore rules.
const baseClaims = {
  aud: OPTIONS.projectId,
  iss: 'https://securetoken.google.com/' + OPTIONS.projectId,
  sub: credA.user.uid,
  user_id: credA.user.uid,
  auth_time: nowSec,
  iat: nowSec,
  exp: nowSec + 3600,
};
const badTokens = [
  signSandboxJwtSync(ID_TOKEN_KEY, { alg: 'none', kid: SANDBOX_JWT_KID, typ: 'JWT' }, baseClaims),
  signSandboxJwtSync(ID_TOKEN_KEY, { alg: 'RS256', typ: 'JWT' }, baseClaims),
  mintIdToken({ ...baseClaims, iss: 'https://evil.example/' + OPTIONS.projectId }),
  mintIdToken({ ...baseClaims, aud: 'wrong-project' }),
  mintIdToken({ ...baseClaims, nbf: nowSec + 600 }),
  mintIdToken({ ...baseClaims, exp: nowSec - 60 }),
];
for (const badToken of badTokens) {
  const badApp = initializeServerApp(OPTIONS, { authIdToken: badToken });
  await assert.rejects(() => setDoc(doc(getFirestore(badApp), 'ssr', credA.user.uid), { bad: true }));
  await deleteApp(badApp);
}

// 4. Revoked token (auth_time < tokensValidAfterMs, even with newer iat) is denied on the host.
const credRev = await createUserWithEmailAndPassword(getAuth(clientApp), 'rev@example.com', 'password123');
const oldAuthTime = Math.floor(Date.now() / 1000) - 30;
await adminAuth.revokeRefreshTokens(credRev.user.uid);
const revokedToken = mintIdToken({
  aud: OPTIONS.projectId,
  iss: 'https://securetoken.google.com/' + OPTIONS.projectId,
  sub: credRev.user.uid,
  user_id: credRev.user.uid,
  auth_time: oldAuthTime,
  iat: Math.floor(Date.now() / 1000) + 10,
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const revokedApp = initializeServerApp(OPTIONS, { authIdToken: revokedToken });
await assert.rejects(() => setDoc(doc(getFirestore(revokedApp), 'ssr', credRev.user.uid), { revoked: true }));
const revAuth = getAuth(revokedApp);
await waitAuthReady(revAuth);
assert.equal(revAuth.currentUser, null);
await deleteApp(revokedApp);

// 5. Disabled user token is denied on the host.
const credDis = await createUserWithEmailAndPassword(getAuth(clientApp), 'dis@example.com', 'password123');
const disToken = await getIdToken(credDis.user);
await adminAuth.updateUser(credDis.user.uid, { disabled: true });
const disApp = initializeServerApp(OPTIONS, { authIdToken: disToken });
await assert.rejects(() => setDoc(doc(getFirestore(disApp), 'ssr', credDis.user.uid), { disabled: true }));
await deleteApp(disApp);

// 6. Deleted user token is denied on the host.
const credDel = await createUserWithEmailAndPassword(getAuth(clientApp), 'del@example.com', 'password123');
const delToken = await getIdToken(credDel.user);
await adminAuth.deleteUser(credDel.user.uid);
const delApp = initializeServerApp(OPTIONS, { authIdToken: delToken });
await assert.rejects(() => setDoc(doc(getFirestore(delApp), 'ssr', credDel.user.uid), { deleted: true }));
await deleteApp(delApp);

await deleteApp(clientApp);
console.log('REMOTE_JWT_MATRIX_OK');
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
        throw new Error(`remote-jwt-matrix failed (${res.status}): ${res.stderr}\n${res.stdout}`);
      }
      expect(res.stdout).toContain('REMOTE_JWT_MATRIX_OK');
    } finally {
      await host.stop();
    }
  }, 30_000);
});
