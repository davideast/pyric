/**
 * Live-mode own-write refusal covers non-persisted mutating worker operations
 * (such as Storage upload sessions, RTDB onDisconnect hooks, Auth mail/session
 * mutations, Messaging delivery/send, AI calls, and runtime retirement) as well
 * as direct HTTP byte-route uploads, while keeping reads and presence alive.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { portWriteOf, type PyricWrite } from '../../src/serve/hosted/own-writes.js';
import { createStorageByteRoute } from '../../src/serve/hosted/storage-byte-route.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { operationPersistence } from '../../src/serve/worker/operation-persistence.js';
import type { InboundMessage, OpMessage } from '../../src/serve/worker/protocol.js';
import { resolveNodeExecutable } from './require-node-on-path.js';

const cliDist = resolve(import.meta.dir, '../../dist');
const liveDist = resolve(import.meta.dir, '../../../live/dist');

const SCENARIO = `
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedRuntime } from ${JSON.stringify(pathToFileURL(join(cliDist, 'serve/hosted/runtime.js')).href)};
import { liveWriteRefusal } from ${JSON.stringify(pathToFileURL(join(liveDist, 'refusal.js')).href)};

const OPEN_RULES = "rules_version = '2';\\nservice cloud.firestore { match /databases/{db}/documents { match /{p=**} { allow read, write: if true; } } }";
const OPEN_STORAGE_RULES = "rules_version = '2';\\nservice firebase.storage { match /b/{b}/o { match /{p=**} { allow read, write: if true; } } }";

const dir = mkdtempSync(join(tmpdir(), 'pyric-live-write-policy-'));
const frames = [];
const waiters = new Set();
const payload = {
  rules: OPEN_RULES,
  rulesHash: null,
  storageRules: OPEN_STORAGE_RULES,
  storageRulesHash: null,
  bridgeUrl: null,
  seed: null,
  capture: false,
  hosted: true,
  projectKey: dir,
  sessionToken: 'live-policy-token',
  permissive: false,
  appOptions: { projectId: 'demo-live-policy', storageBucket: 'demo-live-policy.appspot.com' },
};

const runtime = await createHostedRuntime(
  payload,
  'http://127.0.0.1:1',
  (frame) => {
    frames.push(frame);
    for (const waiter of [...waiters]) waiter();
  },
  dir,
  { ownWriteRefusal: liveWriteRefusal },
);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  void runtime.storageHttp(req, res, url).then((handled) => {
    if (!handled) res.writeHead(404).end();
  });
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const addr = server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

const waitFor = (match) => new Promise((done) => {
  const check = () => {
    const found = frames.find(match);
    if (found) {
      waiters.delete(check);
      done(found);
    }
  };
  waiters.add(check);
  check();
});

let seq = 0;
const sendOp = async (session, message) => {
  const id = 'op-' + (++seq);
  runtime.receive({ type: 'worker-message', clientSessionId: session, message: { t: 'op', id, ...message } });
  const frame = await waitFor((m) => m.type === 'worker-message-result' && m.message.t === 'res' && m.message.id === id);
  return frame.message;
};

const sendSub = async (session, sub) => {
  const subId = 'sub-' + (++seq);
  runtime.receive({ type: 'worker-message', clientSessionId: session, message: { t: 'sub', subId, ...sub } });
  const frame = await waitFor((m) => m.type === 'worker-message-result' && m.message.t === 'snap' && m.message.subId === subId);
  return frame.message;
};

const codeOf = (res) => (res.ok ? 'ok' : (res.error?.code ?? 'unknown'));

try {
  const refusedOps = {
    createUploadSession: codeOf(await sendOp('p1', {
      method: 'storage.createUploadSession',
      path: 'items/session.txt',
      bucket: 'demo-live-policy.appspot.com',
      actAs: { mode: 'admin' },
    })),
    onDisconnectSet: codeOf(await sendOp('p1', {
      method: 'rtdb.onDisconnectSet',
      path: 'items/dc-set',
      value: { written: true },
    })),
    onDisconnectUpdate: codeOf(await sendOp('p1', {
      method: 'rtdb.onDisconnectUpdate',
      path: 'items/dc-update',
      values: { written: true },
    })),
    onDisconnectRemove: codeOf(await sendOp('p1', {
      method: 'rtdb.onDisconnectRemove',
      path: 'items/dc-remove',
    })),
    onDisconnectCancel: codeOf(await sendOp('p1', {
      method: 'rtdb.onDisconnectCancel',
      path: 'items/dc-set',
    })),
    rtdbGoOnline: codeOf(await sendOp('p1', { method: 'rtdb.goOnline' })),
    authSendPasswordResetEmail: codeOf(await sendOp('p1', {
      method: 'auth.sendPasswordResetEmail',
      email: 'user@example.com',
    })),
    authTakeMail: codeOf(await sendOp('p1', { method: 'auth.takeMail' })),
    authSignOut: codeOf(await sendOp('p1', { method: 'auth.signOut' })),
    authSetPersistence: codeOf(await sendOp('p1', { method: 'auth.setPersistence', persistence: 'local' })),
    authSetTenantId: codeOf(await sendOp('p1', { method: 'auth.setTenantId', tenantId: 'tenant-a' })),
    authMockSignInResult: codeOf(await sendOp('p1', { method: 'auth.mockSignInResult', result: null })),
    messagingSend: codeOf(await sendOp('p1', { method: 'messaging.send', message: { token: 'tok-1' } })),
    messagingSetVisibility: codeOf(await sendOp('p1', { method: 'messaging.setVisibility', state: 'visible' })),
    aiCountTokens: codeOf(await sendOp('p1', {
      method: 'ai.countTokens',
      model: 'gemini-2.5-flash',
      request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    })),
    retireRuntime: codeOf(await sendOp('p1', { method: 'retireRuntime' })),
  };

  const aiStreamSnap = await sendSub('p1', {
    target: { service: 'ai', op: 'streamGenerateContent' },
    model: 'gemini-2.5-flash',
    request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
  });
  const aiStreamCode = aiStreamSnap.value?.__error?.code ?? 'ok';

  // Disconnect p1 and confirm no RTDB onDisconnect write ran.
  runtime.receive({ type: 'worker-client-disconnect', clientSessionId: 'p1' });
  await new Promise((r) => setTimeout(r, 100));
  const rtdbSnap = await sendOp('p2', { method: 'rtdb.get', path: 'items/dc-set', actAs: { mode: 'admin' } });

  // Presence and pure reads stay allowed on a live host.
  const presenceRegister = codeOf(await sendOp('p2', {
    method: 'presence.register',
    clientId: 'client-1',
    kind: 'app',
    route: '/',
    visibility: 'visible',
  }));
  const activeRules = codeOf(await sendOp('p2', { method: 'getActiveRules', service: 'firestore' }));

  // Direct byte-route uploads are refused with PYRIC_LIVE_REFUSED.
  const uploadUrl = 'http://127.0.0.1:' + port + '/__pyric/storage/v0/b/demo-live-policy.appspot.com/o?name=items%2Fdirect.txt&upload_id=u1&upload_token=t1';
  const putRes = await fetch(uploadUrl, { method: 'PUT', body: 'payload' });
  const putBody = await putRes.text();
  const postRes = await fetch(uploadUrl, { method: 'POST', body: 'payload' });
  const postBody = await postRes.text();

  console.log('OUTCOME ' + JSON.stringify({
    refusedOps,
    aiStreamCode,
    rtdbEmpty: rtdbSnap.ok && rtdbSnap.value?.exists === false,
    presenceRegister,
    activeRules,
    putStatus: putRes.status,
    putHasRefused: putBody.includes('PYRIC_LIVE_REFUSED'),
    postStatus: postRes.status,
    postHasRefused: postBody.includes('PYRIC_LIVE_REFUSED'),
  }));
} finally {
  server.close();
  await runtime.close();
  rmSync(dir, { recursive: true, force: true });
}
`;

describe('live host non-persisted write and byte-route upload refusal', () => {
  it('refuses non-persisted mutating ops, AI streams, and byte-route uploads while allowing presence and reads', () => {
    for (const built of [join(cliDist, 'serve/hosted/runtime.js'), join(liveDist, 'refusal.js')]) {
      if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'pyric-live-write-policy-test-'));
    try {
      const nodeBin = resolveNodeExecutable();
      const file = join(dir, 'scenario.mjs');
      writeFileSync(file, SCENARIO);
      const result = spawnSync(nodeBin, [file], { encoding: 'utf8', timeout: 60_000 });
      const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME '));
      expect(line, `${result.stdout}\n${result.stderr}`).toBeDefined();
      const outcome = JSON.parse((line ?? '').slice('OUTCOME '.length)) as {
        refusedOps: Record<string, string>;
        aiStreamCode: string;
        rtdbEmpty: boolean;
        presenceRegister: string;
        activeRules: string;
        putStatus: number;
        putHasRefused: boolean;
        postStatus: number;
        postHasRefused: boolean;
      };
      for (const [name, code] of Object.entries(outcome.refusedOps)) {
        expect(code, `op ${name}`).toBe('PYRIC_LIVE_REFUSED');
      }
      expect(outcome.aiStreamCode).toBe('PYRIC_LIVE_REFUSED');
      expect(outcome.rtdbEmpty).toBe(true);
      expect(outcome.presenceRegister).toBe('ok');
      expect(outcome.activeRules).toBe('ok');
      expect(outcome.putStatus).toBe(403);
      expect(outcome.putHasRefused).toBe(true);
      expect(outcome.postStatus).toBe(403);
      expect(outcome.postHasRefused).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  const handles: ServeHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle !== undefined) await handle.stop();
    }
  });

  it('classifies every persisted and non-persisted worker op and AI stream in portWriteOf', () => {
    const allowedMethods = new Set<string>([
      'getDoc',
      'getDocs',
      'count',
      'aggregate',
      'getActiveRules',
      'getRulesStatus',
      'admin.getDocument',
      'admin.listDocuments',
      'admin.readState',
      'rtdb.get',
      'sandbox.clock',
      'rtdb.adminSnapshot',
      'listRootCollections',
      'listSubcollections',
      'auth.getIdToken',
      'auth.getIdTokenResult',
      'auth.getCurrentUser',
      'auth.reload',
      'auth.checkActionCode',
      'auth.verifyPasswordResetCode',
      'auth.listUsers',
      'auth.adminGetAccountStanding',
      'auth.getProviderConfig',
      'storage.listAll',
      'storage.getMetadata',
      'storage.getBlob',
      'storage.getBytes',
      'getRuntimeEpoch',
      'getVersion',
      'exportState',
      'listCheckpoints',
      'getSnapshot',
      'presence.register',
      'presence.heartbeat',
      'presence.update',
      'presence.disconnect',
      'crashlytics.checkForUnsentReports',
      'crashlytics.getState',
    ]);

    for (const method of Object.keys(operationPersistence) as Array<OpMessage['method']>) {
      const frame = { t: 'op', id: 'op-1', method } as InboundMessage;
      const expected = allowedMethods.has(method) ? null : method;
      expect(portWriteOf(frame), `portWriteOf(${method})`).toBe(expected);
    }

    const aiStream: InboundMessage = {
      t: 'sub',
      subId: 'sub-1',
      target: { service: 'ai', op: 'streamGenerateContent' },
      model: 'gemini-2.5-flash',
      request: { contents: [] },
    };
    expect(portWriteOf(aiStream)).toBe('ai.streamGenerateContent');
    expect(portWriteOf({ t: 'tool', id: 't-1', name: 'firestore_create_document', args: {} })).toBe('firestore_create_document');
    expect(portWriteOf({ t: 'tool', id: 't-2', name: 'firestore_get_document', args: {} })).toBeNull();
  });

  it('refuses PUT, POST, OPTIONS, and cross-origin upload sessions on createStorageByteRoute when ownWriteRefusal is set', async () => {
    let touchedStorage = false;
    const refusal = (write: PyricWrite) =>
      Object.assign(new Error(`@pyric/live: ${write.action} refused (${write.writer})`), { code: 'PYRIC_LIVE_REFUSED' });
    const route = createStorageByteRoute({
      storage: {
        async objectFile() {
          return undefined;
        },
        async appendUpload() {
          touchedStorage = true;
          throw new Error('appendUpload must not run');
        },
        async uploadProgress() {
          touchedStorage = true;
          return undefined;
        },
      },
      sessionToken: 'live-secret',
      uploadToken: () => 'valid-upload-token',
      sessions: {
        get: () => ({ token: 'valid-upload-token', origin: 'http://localhost:5173' }),
        open: async () => {
          touchedStorage = true;
          throw new Error('open must not run');
        },
        finish: async () => {
          touchedStorage = true;
          throw new Error('finish must not run');
        },
      },
      ownWriteRefusal: refusal,
    });

    const sessionUrl = new URL(
      'http://127.0.0.1:4000/__pyric/storage/v0/b/bucket-a/o?name=items%2Fa.txt&upload_id=s1&upload_token=valid-upload-token',
    );
    expect(route.allowsOrigin(sessionUrl, 'http://localhost:5173')).toBe(false);

    const server = await startStaticServer({
      publicDir: null,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: (req, res, url) => route(req, res, url),
      logger: silentServeLogger(),
    });
    handles.push(server);

    const uploadPath = '/__pyric/storage/v0/b/bucket-a/o?name=items%2Fa.txt&upload_id=s1&upload_token=valid-upload-token';
    for (const method of ['PUT', 'POST', 'OPTIONS'] as const) {
      const answer = await new Promise<{ status: number; body: string }>((resolveReq, rejectReq) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: server.port,
            method,
            path: uploadPath,
            headers: {
              host: `127.0.0.1:${server.port}`,
              origin: 'http://localhost:5173',
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolveReq({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', rejectReq);
        if (method !== 'OPTIONS') req.write('payload');
        req.end();
      });
      expect(answer.status, `${method} upload status`).toBe(403);
      expect(answer.body, `${method} upload body`).toContain('PYRIC_LIVE_REFUSED');
    }
    expect(touchedStorage).toBe(false);
  });
});
