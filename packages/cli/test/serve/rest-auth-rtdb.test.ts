import { afterEach, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp, type App as AdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import { getDatabase as getAdminDatabase, getDatabaseWithUrl as getAdminDatabaseWithUrl } from 'pyric-admin/database';
import { sandbox as authSandbox } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { encodeJson, getClock } from 'pyric/sandbox/internal';
import type { BridgeMessage, WorkerResFrame, WorkerSnapFrame } from '../../src/bridge/protocol.js';
import { connectRemoteSandbox } from '../../src/remote/index.js';
import { createBridgeMount, type BridgeMount } from '../../src/serve/bridge-mount.js';
import { createRestAuthRtdbHandler } from '../../src/serve/rest-auth-rtdb.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { setDatabaseRules } from '../../src/serve/worker/host/rules.js';
import { ensureAuth, type HostCtx } from '../../src/serve/worker/host.js';
import { useTempDirs } from '../use-temp-dirs.js';

const PROJECT_ID = 'demo-project';
const makeTempDir = useTempDirs('pyric-serve-rest-');

function makeUnsignedOidcJwt(claims: Record<string, unknown>): string {
  return `${encodeJson({ alg: 'none', typ: 'JWT' })}.${encodeJson(claims)}.`;
}

function makeFakeSignedOidcJwt(claims: Record<string, unknown>): string {
  return `${encodeJson({ alg: 'RS256', kid: 'idp-key-1', typ: 'JWT' })}.${encodeJson(claims)}.external_idp_signature`;
}

function postJson(url: string, payload: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders);
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
}

function sendJsonMethod(method: 'PUT' | 'PATCH', url: string, payload: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (extraHeaders !== undefined) Object.assign(headers, extraHeaders);
  return fetch(url, { method, headers, body: JSON.stringify(payload) });
}

function makeInMemoryHostedPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    listByPrefix: async () => [],
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

interface HostedTestRig {
  readonly base: string;
  readonly port: number;
  readonly mount: BridgeMount;
  readonly adminApp: AdminApp;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const next = cleanups.pop();
    if (next !== undefined) await next();
  }
});

async function startHostedRig(options?: { publicDir?: string | null }): Promise<HostedTestRig> {
  const projectDir = makeTempDir();
  const sessionToken = `rest-test-session-${Math.random().toString(36).slice(2)}`;
  const mount = createBridgeMount({
    hosted: true,
    project: PROJECT_ID,
    projectKey: projectDir,
    sessionToken,
    disableAuditLog: true,
  });
  let publicDir: string | null = null;
  if (options?.publicDir !== undefined) publicDir = options.publicDir;
  const server = await startStaticServer({
    publicDir,
    port: 0,
    host: '127.0.0.1',
    sessionToken,
    logger: silentServeLogger(),
    namespaceHandler: async (req, res, url) => {
      if (url.pathname === '/__pyric/init.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ sessionToken, hosted: true, instanceId: mount.instanceId }));
        return true;
      }
      return mount.handler(req, res, url);
    },
    functionsHandler: (req, res) => {
      if (req.url === `/${PROJECT_ID}/us-central1/ping`) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, route: 'function' }));
        return true;
      }
      return false;
    },
  });
  await mount.startHostedSandbox(
    {
      rules: null, rulesHash: null, databaseRules: null, databaseRulesHash: null,
      databaseInstances: { defaultInstance: `${PROJECT_ID}-default-rtdb`, projectId: PROJECT_ID, rules: {} },
      storageRules: null, storageRulesHash: null, bridgeUrl: '/__pyric/sandbox',
      seed: null, capture: false, hosted: true, permissive: false,
      projectKey: projectDir, sessionToken,
    },
    server.url,
    { persistence: makeInMemoryHostedPersistence() as never, record: false },
  );
  const attachment = mount.attachHost({
    servers: server.servers,
    lifecycleServer: server.server,
    projectDir,
    origin: () => ({ host: '127.0.0.1', port: server.port }),
  });
  const remote = await connectRemoteSandbox({ url: server.url });
  const adminApp = initializeAdminApp({ sandbox: remote, projectId: PROJECT_ID }, `admin-rest-${Math.random().toString(36).slice(2)}`);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const serverStop = server.stop();
    await deleteAdminApp(adminApp).catch(() => {});
    remote.close?.();
    await attachment.close();
    await mount.close();
    await serverStop;
  };
  cleanups.push(close);
  return { base: server.url, port: server.port, mount, adminApp, close };
}

function createDirectHostServer(options?: {
  stagedIdentities?: Map<string, { uid: string; providerId: string; email?: string | null; displayName?: string | null; photoURL?: string | null; emailVerified?: boolean }>;
  refuseWrites?: boolean;
}): Promise<{ server: ServeHandle; ctx: HostCtx; sandbox: LocalSandbox }> {
  const sandbox = initializeSandbox();
  const ctx: HostCtx = {
    sandbox,
    flushPersistence: async () => {},
    db: getFirestore(sandbox),
    instanceId: 'direct-rest-ctx',
    rtdbProjectId: PROJECT_ID,
    defaultRtdbInstance: `${PROJECT_ID}-default-rtdb`,
    subs: new Map(),
  };
  ensureAuth(ctx);
  let ownWriteRefusal: ((write: { action: string }) => Error) | undefined;
  if (options?.refuseWrites === true) ownWriteRefusal = (write) => new Error(`Write refused in live mode: ${write.action}`);
  const restHandler = createRestAuthRtdbHandler({ ctx, ownWriteRefusal, stagedIdentities: options?.stagedIdentities });
  return startStaticServer({ publicDir: null, port: 0, host: '127.0.0.1', logger: silentServeLogger(), restHandler }).then((server) => {
    cleanups.push(async () => {
      await server.stop();
      sandbox.dispose();
    });
    return { server, ctx, sandbox };
  });
}

describe('pyric serve HTTP REST Auth and sharded RTDB adapters', () => {
  it('exchanges Google OIDC JWTs, rotates refresh tokens, revokes sessions, and interoperates with pyric-admin', async () => {
    const rig = await startHostedRig();
    const adminAuth = getAdminAuth(rig.adminApp);
    const googleJwt = makeFakeSignedOidcJwt({
      sub: 'google-sub-ava', email: 'ava@example.com', name: 'Ava Chen',
      picture: 'https://example.com/ava.png', email_verified: true,
    });
    const idpRes = await postJson(`${rig.base}/v1/accounts:signInWithIdp?key=demo-api-key`, {
      postBody: `id_token=${encodeURIComponent(googleJwt)}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnIdpCredential: true,
      returnSecureToken: true,
    });
    expect(idpRes.status).toBe(200);
    const idpJson = (await idpRes.json()) as {
      kind: string; localId: string; email: string; displayName: string; photoUrl: string;
      emailVerified: boolean; idToken: string; refreshToken: string; expiresIn: string;
      providerId: string; federatedId: string; isNewUser: boolean; registered: boolean;
    };
    expect(idpJson.kind).toBe('identitytoolkit#VerifyAssertionResponse');
    expect(idpJson.localId).toBe('google-sub-ava');
    expect(idpJson.federatedId).toBe('google-sub-ava');
    expect(idpJson.providerId).toBe('google.com');
    expect(idpJson.email).toBe('ava@example.com');
    expect(idpJson.displayName).toBe('Ava Chen');
    expect(idpJson.photoUrl).toBe('https://example.com/ava.png');
    expect(idpJson.emailVerified).toBe(true);
    expect(idpJson.expiresIn).toBe('3600');
    expect(idpJson.isNewUser).toBe(true);
    expect(idpJson.registered).toBe(true);

    const decodedInitial = await adminAuth.verifyIdToken(idpJson.idToken, true);
    expect(decodedInitial.uid).toBe('google-sub-ava');
    expect(decodedInitial.email).toBe('ava@example.com');
    expect(decodedInitial.firebase.sign_in_provider).toBe('google.com');

    const repeatRes = await postJson(`${rig.base}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp`, {
      postBody: `id_token=${encodeURIComponent(makeUnsignedOidcJwt({ sub: 'google-sub-ava', email: 'ava@example.com' }))}&providerId=google.com`,
    });
    expect(repeatRes.status).toBe(200);
    const repeatJson = (await repeatRes.json()) as { localId: string; isNewUser: boolean };
    expect(repeatJson.localId).toBe('google-sub-ava');
    expect(repeatJson.isNewUser).toBe(false);

    await adminAuth.setCustomUserClaims('google-sub-ava', { tier: 'gold' });
    const refreshFormRes = await fetch(`${rig.base}/v1/token?key=demo-api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(idpJson.refreshToken)}`,
    });
    expect(refreshFormRes.status).toBe(200);
    const refresh1 = (await refreshFormRes.json()) as {
      access_token: string; expires_in: string; token_type: string;
      refresh_token: string; id_token: string; user_id: string; project_id: string;
    };
    expect(refresh1.token_type).toBe('Bearer');
    expect(refresh1.expires_in).toBe('3600');
    expect(refresh1.user_id).toBe('google-sub-ava');
    expect(refresh1.project_id).toBe(PROJECT_ID);
    expect(refresh1.access_token).toBe(refresh1.id_token);
    expect(refresh1.id_token).not.toBe(idpJson.idToken);
    expect(refresh1.refresh_token).not.toBe(idpJson.refreshToken);
    expect((await adminAuth.verifyIdToken(refresh1.id_token, true)).tier).toBe('gold');

    const replayRotatedRes = await postJson(`${rig.base}/v1/token`, {
      grant_type: 'refresh_token',
      refresh_token: idpJson.refreshToken,
    });
    expect(replayRotatedRes.status).toBe(400);
    expect(await replayRotatedRes.json()).toEqual({
      error: { code: 400, message: 'INVALID_REFRESH_TOKEN', status: 'INVALID_ARGUMENT' },
    });

    const refreshJsonRes = await postJson(`${rig.base}/securetoken.googleapis.com/v1/token`, {
      grantType: 'refresh_token',
      refreshToken: refresh1.refresh_token,
    });
    expect(refreshJsonRes.status).toBe(200);
    const refresh2 = (await refreshJsonRes.json()) as { refresh_token: string; id_token: string };
    expect(refresh2.refresh_token).not.toBe(refresh1.refresh_token);

    await new Promise((r) => setTimeout(r, 1100));
    await adminAuth.revokeRefreshTokens('google-sub-ava');
    const afterRevokeRes = await fetch(`${rig.base}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh2.refresh_token)}`,
    });
    expect(afterRevokeRes.status).toBe(400);
    expect(await afterRevokeRes.json()).toEqual({
      error: { code: 400, message: 'INVALID_REFRESH_TOKEN', status: 'INVALID_ARGUMENT' },
    });
  });

  it('redeems custom tokens via POST /v1/accounts:signInWithCustomToken and rejects malformed Auth REST payloads', async () => {
    const rig = await startHostedRig();
    const adminAuth = getAdminAuth(rig.adminApp);
    const customToken = await adminAuth.createCustomToken('custom-worker-1', { role: 'moderator' });
    const customRes = await postJson(`${rig.base}/v1/accounts:signInWithCustomToken`, {
      token: customToken,
      returnSecureToken: true,
    });
    expect(customRes.status).toBe(200);
    const customJson = (await customRes.json()) as {
      kind: string; idToken: string; refreshToken: string; expiresIn: string; isNewUser: boolean;
    };
    expect(customJson.kind).toBe('identitytoolkit#VerifyCustomTokenResponse');
    expect(customJson.expiresIn).toBe('3600');
    expect(customJson.isNewUser).toBe(true);
    const verified = await adminAuth.verifyIdToken(customJson.idToken, true);
    expect(verified.uid).toBe('custom-worker-1');
    expect(verified.role).toBe('moderator');
    expect(verified.firebase.sign_in_provider).toBe('custom');

    const badCustomRes = await postJson(`${rig.base}/v1/accounts:signInWithCustomToken`, { token: 'not-a-valid-custom-token' });
    expect(badCustomRes.status).toBe(400);
    expect(await badCustomRes.json()).toEqual({ error: { code: 400, message: 'INVALID_CUSTOM_TOKEN' } });

    const malformedPayloads = [
      '{broken',
      '{}',
      JSON.stringify({ postBody: 'providerId=google.com' }),
      JSON.stringify({ postBody: 'id_token=bad.jwt&providerId=google.com' }),
    ];
    for (const badBody of malformedPayloads) {
      const badIdp = await fetch(`${rig.base}/v1/accounts:signInWithIdp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: badBody,
      });
      expect(badIdp.status).toBe(400);
      const errPayload = (await badIdp.json()) as { error: { code: number; message: string } };
      expect(errPayload.error.code).toBe(400);
      expect(typeof errPayload.error.message).toBe('string');
    }

    const unknownRefresh = await fetch(`${rig.base}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=unknown-token-value',
    });
    expect(unknownRefresh.status).toBe(400);
    expect(await unknownRefresh.json()).toEqual({
      error: { code: 400, message: 'INVALID_REFRESH_TOKEN', status: 'INVALID_ARGUMENT' },
    });
  });

  it('serves sharded RTDB REST across main and shard-00..09 with independent rules, 401/403 isolation, and WS + pyric-admin sync', async () => {
    const rig = await startHostedRig();
    const adminAuth = getAdminAuth(rig.adminApp);
    const avaLogin = (await (
      await postJson(`${rig.base}/v1/accounts:signInWithIdp`, {
        postBody: `id_token=${encodeURIComponent(makeUnsignedOidcJwt({ sub: 'uid-ava', email: 'ava@example.com' }))}&providerId=google.com`,
      })
    ).json()) as { idToken: string; localId: string };

    const modCustomToken = await adminAuth.createCustomToken('uid-mod', { role: 'moderator' });
    const modLogin = (await (
      await postJson(`${rig.base}/v1/accounts:signInWithCustomToken`, { token: modCustomToken })
    ).json()) as { idToken: string };

    await rig.mount.deployHostedRules('database', JSON.stringify({
      rules: {
        items: {
          $itemId: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            '.validate': "newData.hasChild('owner') && newData.child('owner').val() == auth.uid",
          },
        },
      },
    }));
    await rig.mount.deployHostedRules('database', JSON.stringify({
      rules: {
        rooms: {
          $roomId: {
            '.read': "auth != null && (auth.uid == 'uid-ava' || auth.token.role == 'moderator')",
            '.write': "auth != null && auth.uid == 'uid-ava'",
          },
        },
      },
    }), 'shard-00');
    await rig.mount.deployHostedRules('database', JSON.stringify({
      rules: {
        rooms: {
          $roomId: {
            '.read': "auth != null && auth.token.role == 'moderator'",
            '.write': "auth != null && auth.token.role == 'moderator'",
          },
        },
      },
    }), 'shard-01');
    for (let index = 2; index <= 8; index += 1) {
      await rig.mount.deployHostedRules('database', JSON.stringify({
        rules: { slots: { '.read': 'auth != null', '.write': 'auth != null' } },
      }), `shard-0${index}`);
    }

    const badTokenRes = await fetch(`${rig.base}/items/doc1.json?auth=forged.jwt.token`);
    expect(badTokenRes.status).toBe(401);
    expect(await badTokenRes.json()).toEqual({ error: 'Could not parse auth token.' });

    const badHeaderRes = await fetch(`${rig.base}/items/doc1.json`, { headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    expect(badHeaderRes.status).toBe(401);
    expect(await badHeaderRes.json()).toEqual({ error: 'Could not parse auth token.' });

    const unauthReadMain = await fetch(`${rig.base}/items/doc1.json`);
    expect(unauthReadMain.status).toBe(403);
    expect(await unauthReadMain.json()).toEqual({ error: 'Permission denied' });

    const missingMain = await fetch(`${rig.base}/items/doc1.json?auth=${encodeURIComponent(avaLogin.idToken)}`);
    expect(missingMain.status).toBe(200);
    expect(await missingMain.json()).toBeNull();

    const invalidOwnerMain = await sendJsonMethod('PUT', `${rig.base}/items/doc1.json?auth=${encodeURIComponent(avaLogin.idToken)}`, {
      owner: 'someone-else',
      title: 'Draft',
    });
    expect(invalidOwnerMain.status).toBe(403);
    expect(await invalidOwnerMain.json()).toEqual({ error: 'Permission denied' });

    const putMain = await sendJsonMethod('PUT', `${rig.base}/items/doc1.json?auth=${encodeURIComponent(avaLogin.idToken)}`, {
      owner: 'uid-ava',
      title: 'Main Item',
      updatedAt: { '.sv': 'timestamp' },
    });
    expect(putMain.status).toBe(200);
    const putMainBody = (await putMain.json()) as { owner: string; title: string; updatedAt: number };
    expect(putMainBody.owner).toBe('uid-ava');
    expect(putMainBody.title).toBe('Main Item');
    expect(typeof putMainBody.updatedAt).toBe('number');

    const socket = new WebSocket(`ws://127.0.0.1:${rig.port}/__pyric/sandbox`);
    cleanups.push(async () => { socket.terminate(); });
    const snaps: WorkerSnapFrame[] = [];
    const wsReplies = new Map<string, (frame: WorkerResFrame) => void>();
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as BridgeMessage;
      if (frame.type === 'worker-res') wsReplies.get(frame.id)?.(frame);
      if (frame.type === 'worker-snap') snaps.push(frame);
    });
    await once(socket, 'open');
    const acked = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'ws-shard-observer', clientInfo: { platform: 'kotlin' } } satisfies BridgeMessage));
    await acked;

    const signInReply = new Promise<WorkerResFrame>((resolveReply) => wsReplies.set('ws-auth-1', resolveReply));
    socket.send(JSON.stringify({ type: 'worker-op', id: 'ws-auth-1', op: { method: 'auth.signInWithCustomToken', customToken: modCustomToken } } as BridgeMessage));
    expect((await signInReply).ok).toBe(true);

    socket.send(JSON.stringify({
      type: 'worker-sub',
      subId: 'sub-shard00-r1',
      sub: { target: { service: 'rtdb', instance: 'shard-00', path: 'rooms/r1', event: 'value' } },
    } as BridgeMessage));
    const waitForSnapValue = async (expectedStep: string) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const matched = snaps.find((entry) => {
          const val = (entry.value as { value?: { step?: string } } | null)?.value;
          return entry.subId === 'sub-shard00-r1' && val?.step === expectedStep;
        });
        if (matched !== undefined) return matched;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Timed out waiting for WS snapshot step=${expectedStep}`);
    };

    const putShard00 = await sendJsonMethod(
      'PUT',
      `${rig.base}/rooms/r1.json?ns=shard-00`,
      { step: 'created', count: 1 },
      { authorization: `Bearer ${avaLogin.idToken}` },
    );
    expect(putShard00.status).toBe(200);
    expect(await putShard00.json()).toEqual({ step: 'created', count: 1 });
    await waitForSnapValue('created');

    const patchShard00 = await sendJsonMethod(
      'PATCH',
      `${rig.base}/rooms/r1.json`,
      { step: 'patched', extra: true },
      { 'x-pyric-database-instance': 'https://shard-00.firebaseio.com', authorization: `Bearer ${avaLogin.idToken}` },
    );
    expect(patchShard00.status).toBe(200);
    expect(await patchShard00.json()).toEqual({ step: 'patched', extra: true });
    await waitForSnapValue('patched');

    const shallowShard00 = await fetch(`${rig.base}/rooms/r1.json?ns=shard-00&shallow=true&auth=${encodeURIComponent(avaLogin.idToken)}`);
    expect(shallowShard00.status).toBe(200);
    expect(await shallowShard00.json()).toEqual({ step: true, count: true, extra: true });

    const avaDeniedOnShard01 = await sendJsonMethod(
      'PUT',
      `${rig.base}/rooms/r1.json?ns=shard-01&auth=${encodeURIComponent(avaLogin.idToken)}`,
      { step: 'forbidden' },
    );
    expect(avaDeniedOnShard01.status).toBe(403);
    expect(await avaDeniedOnShard01.json()).toEqual({ error: 'Permission denied' });

    const modPutShard01 = await sendJsonMethod(
      'PUT',
      `${rig.base}/rooms/r1.json?ns=shard-01`,
      { step: 'mod-owned' },
      { authorization: `Bearer ${modLogin.idToken}` },
    );
    expect(modPutShard01.status).toBe(200);

    const undeployedShard09 = await fetch(`${rig.base}/rooms/r1.json?ns=shard-09&auth=${encodeURIComponent(modLogin.idToken)}`);
    expect(undeployedShard09.status).toBe(403);

    expect((await getAdminDatabaseWithUrl('https://shard-00.firebaseio.com', rig.adminApp).ref('rooms/r1').get()).val()).toEqual({
      step: 'patched', count: 1, extra: true,
    });
    expect((await getAdminDatabaseWithUrl('https://shard-01.firebaseio.com', rig.adminApp).ref('rooms/r1').get()).val()).toEqual({
      step: 'mod-owned',
    });
    expect((await getAdminDatabase(rig.adminApp).ref('rooms/r1').get()).exists()).toBe(false);

    const deleteShard00 = await fetch(`${rig.base}/rooms/r1.json?ns=shard-00`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${avaLogin.idToken}` },
    });
    expect(deleteShard00.status).toBe(200);
    expect(await deleteShard00.json()).toBeNull();
    expect((await getAdminDatabaseWithUrl('https://shard-00.firebaseio.com', rig.adminApp).ref('rooms/r1').get()).exists()).toBe(false);
  });

  it('enforces token expiry, staged identities, live-mode refusal, and never shadows /__pyric, functions, or static .json files', async () => {
    const staged = new Map([
      ['google.com', { uid: 'staged-uid-1', providerId: 'google.com', email: 'staged@example.com', displayName: 'Staged User', emailVerified: true }],
    ]);
    const direct = await createDirectHostServer({ stagedIdentities: staged });
    setDatabaseRules(direct.ctx, undefined, JSON.stringify({ rules: { '.read': 'auth != null', '.write': 'auth != null' } }));

    const stagedRes = await postJson(`${direct.server.url}/v1/accounts:signInWithIdp`, {
      postBody: 'access_token=mock-access-tok&providerId=google.com',
    });
    expect(stagedRes.status).toBe(200);
    const stagedLogin = (await stagedRes.json()) as { idToken: string; refreshToken: string; localId: string };
    expect(stagedLogin.localId).toBe('staged-uid-1');
    expect((await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(stagedLogin.idToken)}`)).status).toBe(200);

    getClock(direct.sandbox).advance(3601 * 1000);
    const expiredRes = await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(stagedLogin.idToken)}`);
    expect(expiredRes.status).toBe(401);
    expect(await expiredRes.json()).toEqual({ error: 'Could not parse auth token.' });

    const refreshed = (await (
      await fetch(`${direct.server.url}/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(stagedLogin.refreshToken)}`,
      })
    ).json()) as { id_token: string };
    expect((await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(refreshed.id_token)}`)).status).toBe(200);

    authSandbox.updateUser(ensureAuth(direct.ctx), 'staged-uid-1', { disabled: true });
    expect((await fetch(`${direct.server.url}/probe.json?auth=${encodeURIComponent(refreshed.id_token)}`)).status).toBe(401);

    const readOnlyHost = await createDirectHostServer({ refuseWrites: true });
    const refusedWrite = await sendJsonMethod('PUT', `${readOnlyHost.server.url}/items/doc1.json`, { ok: false });
    expect(refusedWrite.status).toBe(403);

    const siteDir = makeTempDir();
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, 'manifest.json'), JSON.stringify({ short_name: 'demo-site' }));
    writeFileSync(join(siteDir, 'firebase.json'), JSON.stringify({ secret: 'ignored-by-hosting' }));

    const staticRig = await startHostedRig({ publicDir: siteDir });
    await staticRig.mount.deployHostedRules('database', JSON.stringify({ rules: { '.read': true, '.write': true } }), 'shard-00');

    expect((await fetch(`${staticRig.base}/__pyric/health`)).status).toBe(200);
    const initRes = await fetch(`${staticRig.base}/__pyric/init.json`);
    expect(initRes.status).toBe(200);
    expect(((await initRes.json()) as { hosted: boolean }).hosted).toBe(true);

    const fnRes = await fetch(`${staticRig.base}/${PROJECT_ID}/us-central1/ping`);
    expect(fnRes.status).toBe(200);
    expect(await fnRes.json()).toEqual({ ok: true, route: 'function' });

    const staticManifestRes = await fetch(`${staticRig.base}/manifest.json`);
    expect(staticManifestRes.status).toBe(200);
    expect(await staticManifestRes.json()).toEqual({ short_name: 'demo-site' });

    expect((await fetch(`${staticRig.base}/firebase.json`)).status).toBe(404);

    const explicitShardManifestRes = await fetch(`${staticRig.base}/manifest.json?ns=shard-00`);
    expect(explicitShardManifestRes.status).toBe(200);
    expect(await explicitShardManifestRes.json()).toBeNull();

    const crossOriginRes = await postJson(
      `${staticRig.base}/v1/token`,
      { grant_type: 'refresh_token', refresh_token: 'any' },
      { origin: 'https://evil.example' },
    );
    expect(crossOriginRes.status).toBe(403);

    const siblingPortRes = await postJson(
      `${staticRig.base}/v1/token`,
      { grant_type: 'refresh_token', refresh_token: 'any' },
      { origin: `http://127.0.0.1:${staticRig.port + 1}` },
    );
    expect(siblingPortRes.status).toBe(403);

    const crossSiteFetchRes = await fetch(`${staticRig.base}/manifest.json?ns=shard-00`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSiteFetchRes.status).toBe(403);

    const rootNavRes = await fetch(`${staticRig.base}/`, {
      redirect: 'manual',
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    expect(rootNavRes.status).toBe(302);
  });
});
