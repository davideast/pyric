import { WebSocket } from 'ws';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import { deleteApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { EmailAuthProvider } from 'pyric/auth';
import { getFirestore as getInPageFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { getStorageSandbox } from 'pyric/storage';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createRemoteSandboxCore, createRemoteSandboxHandle } from '../../../../src/remote/index.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';
import * as clientAuth from '../../../../src/serve/worker/client/auth.js';
import * as clientActionCodes from '../../../../src/serve/worker/client/auth-action-codes.js';
import { reauthenticateWithCredential as clientReauthWithCredential } from '../../../../src/serve/worker/client/auth-reauthentication.js';
import { doc as clientDoc } from '../../../../src/serve/worker/client/firestore-refs.js';
import { setDoc as clientSetDoc } from '../../../../src/serve/worker/client/firestore-writes.js';
import type { ClientDb } from '../../../../src/serve/worker/client/handles.js';
import { rtdbGetDatabase, rtdbRef } from '../../../../src/serve/worker/client/rtdb-references.js';
import { rtdbSet } from '../../../../src/serve/worker/client/rtdb-writes.js';
import * as clientStorage from '../../../../src/serve/worker/client/storage.js';
import { getHostedFirestore } from '../../../../src/serve/worker/client/websocket-connection.js';
import { ensureAuth, handleMessage, type HostCtx, type PortLike } from '../../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../../src/serve/worker/protocol.js';
import { type FakePort, portPair, until } from '../integration-support.js';

export const PROJECT_ID = 'demo-auth-68c';
let activeHostCtx: HostCtx | null = null;
let appSeq = 0;

const RTDB_TOKEN_CLAIMS_RULES = {
  rules: {
    claims: {
      '.write':
        "auth != null && auth.uid == auth.token.sub && auth.uid == auth.token.user_id && auth.provider == auth.token.firebase.sign_in_provider && auth.token.iss == 'https://securetoken.google.com/' + auth.token.aud && auth.token.exp - auth.token.iat == 3600 && auth.token.auth_time <= auth.token.iat && auth.token.foo == 'token' && auth.token.key1 == 'kept' && auth.token.key2 == 'added' && auth.token.admin == true",
    },
    afterPassword: {
      '.write':
        "auth != null && auth.provider == 'password' && auth.token.firebase.sign_in_provider == 'password' && auth.token.foo == 'api' && auth.token.key1 == 'kept' && auth.token.key2 == null && auth.token.admin == null",
    },
  },
};

const FIRESTORE_TOKEN_CLAIMS_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /claims/{id} {
      allow write: if request.auth != null
        && request.auth.uid == request.auth.token.sub
        && request.auth.uid == request.auth.token.user_id
        && request.auth.token.iss == 'https://securetoken.google.com/' + request.auth.token.aud
        && request.auth.token.exp - request.auth.token.iat == 3600
        && request.auth.token.auth_time <= request.auth.token.iat
        && request.auth.token.foo == 'token'
        && request.auth.token.key1 == 'kept'
        && request.auth.token.key2 == 'added'
        && request.auth.token.admin == true;
    }
    match /afterPassword/{id} {
      allow write: if request.auth != null
        && request.auth.token.firebase.sign_in_provider == 'password'
        && request.auth.token.foo == 'api'
        && request.auth.token.key1 == 'kept'
        && !('key2' in request.auth.token)
        && !('admin' in request.auth.token);
    }
  }
}`;

const STORAGE_TOKEN_CLAIMS_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /claims/{allPaths=**} {
      allow read, write: if request.auth.uid == request.auth.token.sub
        && request.auth.uid == request.auth.token.user_id
        && request.auth.token.iss == 'https://securetoken.google.com/' + request.auth.token.aud
        && request.auth.token.exp - request.auth.token.iat == 3600
        && request.auth.token.auth_time <= request.auth.token.iat
        && request.auth.token.foo == 'token'
        && request.auth.token.key1 == 'kept'
        && request.auth.token.key2 == 'added'
        && request.auth.token.admin == true;
    }
    match /afterPassword/{allPaths=**} {
      allow read, write: if request.auth.token.firebase.sign_in_provider == 'password'
        && request.auth.token.foo == 'api'
        && request.auth.token.key1 == 'kept'
        && !('key2' in request.auth.token)
        && !('admin' in request.auth.token);
    }
  }
}`;

export interface MultiPlane68cSession {
  signInAnonymously(): Promise<{ uid: string; claims: Record<string, unknown>; signInProvider: string | null }>;
  signInWithCustomToken(token: string): Promise<{ uid: string; claims: Record<string, unknown>; signInProvider: string | null }>;
  signInWithEmailAndPassword(email: string, password: string): Promise<{ uid: string; claims: Record<string, unknown>; signInProvider: string | null }>;
  reauthCurrentWithPassword(email: string, password: string): Promise<{ claims: Record<string, unknown>; signInProvider: string | null }>;
  reloadCurrent(): Promise<{ claims: Record<string, unknown>; signInProvider: string | null }>;
  forceRefreshCurrent(): Promise<{ claims: Record<string, unknown>; signInProvider: string | null }>;
  signInWithEmailLinkRoundTrip(email: string): Promise<{ claims: Record<string, unknown>; signInProvider: string | null }>;
  signOut(): Promise<void>;
  adminCreateUser(props: {
    uid: string;
    email: string;
    password: string;
    emailVerified?: boolean;
  }): Promise<void>;
  adminSetCustomClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
  adminMintCustomToken(uid: string, developerClaims?: Record<string, unknown>): Promise<string>;
  advanceClock(ms: number): Promise<void>;
  writeRtdb(path: string, value: unknown): Promise<void>;
  writeFirestore(path: string, data: Record<string, unknown>): Promise<void>;
  checkStoragePrefix(prefix: string): Promise<void>;
  cleanup(): Promise<void>;
}

function installSharedWorkerForHost(ctx: HostCtx): void {
  activeHostCtx = ctx;
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port: FakePort;
    addEventListener() {}
    constructor(_url: unknown, _opts: unknown) {
      let targetCtx = ctx;
      if (activeHostCtx !== null) {
        targetCtx = activeHostCtx;
      }
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = {
        postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
      };
      hostPort.onmessage = (event) => {
        void handleMessage(targetCtx, hostPortLike, event.data as InboundMessage);
      };
      this.port = clientPort;
    }
  };
}

export async function createSharedWorker68cSession(): Promise<MultiPlane68cSession> {
  appSeq += 1;
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, {
    dbName: `pyric-sw-68c-${appSeq}`,
    rules: STORAGE_TOKEN_CLAIMS_RULES,
  });
  const ctx: HostCtx = {
    sandbox,
    db: getInPageFirestore(sandbox),
    instanceId: `sw-68c-${appSeq}`,
    subs: new Map(),
    flushPersistence: async () => {},
    appOptions: { projectId: PROJECT_ID },
  };
  ensureAuth(ctx);
  const clock = getClock(ctx.sandbox);
  clock.set(Date.UTC(2026, 0, 1));

  setDatabaseRules(ctx.sandbox, RTDB_TOKEN_CLAIMS_RULES);
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(ctx.sandbox.withAuth(null)).setRules(FIRESTORE_TOKEN_CLAIMS_RULES);

  installSharedWorkerForHost(ctx);
  const servedAuth = await import('../../../../src/serve/entries/auth.js');
  const servedFirestore = await import('../../../../src/serve/entries/firestore-surface.js');
  const servedDatabase = await import('../../../../src/serve/entries/database-surface.js');
  const servedStorage = await import('../../../../src/serve/entries/storage-surface.js');

  const createdApps: FirebaseApp[] = [];
  const app = createAppForSandbox(
    ctx.sandbox,
    { projectId: PROJECT_ID, apiKey: 'demo-sw-68c-key' },
    `served-68c-${appSeq}`,
  );
  createdApps.push(app);
  const auth = servedAuth.getAuth(app);
  const fs = servedFirestore.getFirestore(app);
  const rtdb = servedDatabase.getDatabase(app);
  const storage = servedStorage.getStorage(app);

  const adminApp = initializeAdminApp({ sandbox: ctx.sandbox, projectId: PROJECT_ID }, `admin-sw-68c-${appSeq}`);
  const adminAuth = getAdminAuth(adminApp);

  function requireCurrent() {
    const user = auth.currentUser;
    if (user === null) {
      throw new Error('Expected signed-in SharedWorker user');
    }
    return user;
  }

  return {
    async signInAnonymously() {
      const cred = await servedAuth.signInAnonymously(auth);
      const res = await cred.user.getIdTokenResult();
      return { uid: cred.user.uid, claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signInWithCustomToken(token) {
      const cred = await servedAuth.signInWithCustomToken(auth, token);
      const res = await cred.user.getIdTokenResult();
      return { uid: cred.user.uid, claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signInWithEmailAndPassword(email, password) {
      const cred = await servedAuth.signInWithEmailAndPassword(auth, email, password);
      const res = await cred.user.getIdTokenResult();
      return { uid: cred.user.uid, claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async reauthCurrentWithPassword(email, password) {
      const user = requireCurrent();
      await servedAuth.reauthenticateWithCredential(user, EmailAuthProvider.credential(email, password));
      const res = await user.getIdTokenResult();
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async reloadCurrent() {
      const user = requireCurrent();
      await servedAuth.reload(user);
      const res = await user.getIdTokenResult();
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async forceRefreshCurrent() {
      const user = requireCurrent();
      const res = await user.getIdTokenResult(true);
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signInWithEmailLinkRoundTrip(email) {
      await servedAuth.sendSignInLinkToEmail(auth, email, {
        url: 'https://app.example.com/finish',
        handleCodeInApp: true,
      });
      const mail = await clientActionCodes.takeAuthMail(auth as never, email);
      if (mail === null) {
        throw new Error('Expected outbound sign-in link mail');
      }
      const cred = await servedAuth.signInWithEmailLink(auth, email, mail.link);
      const res = await cred.user.getIdTokenResult();
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signOut() {
      await servedAuth.signOut(auth);
    },
    async adminCreateUser(props) {
      await adminAuth.createUser(props);
    },
    async adminSetCustomClaims(uid, claims) {
      await adminAuth.setCustomUserClaims(uid, claims);
    },
    async adminMintCustomToken(uid, developerClaims) {
      return adminAuth.createCustomToken(uid, developerClaims);
    },
    async advanceClock(ms) {
      clock.advance(ms);
    },
    async writeRtdb(path, value) {
      await servedDatabase.set(servedDatabase.ref(rtdb, path), value);
    },
    async writeFirestore(path, data) {
      await servedFirestore.setDoc(servedFirestore.doc(fs, path), data);
    },
    async checkStoragePrefix(prefix) {
      await servedStorage.uploadBytes(servedStorage.ref(storage, `${prefix}/file.txt`), new Uint8Array([111, 107]));
      await servedStorage.listAll(servedStorage.ref(storage, prefix));
    },
    async cleanup() {
      for (const candidate of createdApps) {
        try {
          await deleteApp(candidate);
        } catch {
          // Best-effort cleanup.
        }
      }
      await deleteAdminApp(adminApp);
      ctx.sandbox.dispose();
    },
  };
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

export async function createNodeHosted68cSession(): Promise<MultiPlane68cSession> {
  const projectDir = process.cwd();
  const sockets = new Map<string, { send(data: string): void }>();
  const persistence = makeInMemoryHostedPersistence();
  const runtime = await createHostedRuntime(
    {
      rules: FIRESTORE_TOKEN_CLAIMS_RULES,
      rulesHash: 'fs-68c',
      databaseRules: RTDB_TOKEN_CLAIMS_RULES,
      databaseRulesHash: 'rtdb-68c',
      storageRules: STORAGE_TOKEN_CLAIMS_RULES,
      storageRulesHash: 'st-68c',
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: PROJECT_ID,
      sessionToken: 'tok-hosted-68c',
    },
    'http://127.0.0.1:4400',
    (frame) => {
      const forwardsToSocket =
        frame.type === 'worker-message-result' ||
        frame.type === 'worker-res' ||
        frame.type === 'worker-snap';
      if (!forwardsToSocket) {
        return;
      }
      const sessionId = frame.clientSessionId;
      if (typeof sessionId !== 'string') {
        return;
      }
      const socket = sockets.get(sessionId);
      if (socket !== undefined) {
        socket.send(JSON.stringify(frame));
      }
    },
    projectDir,
    { persistence: persistence as never, record: false },
  );

  let nextSession = 0;
  const server = Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      nextSession += 1;
      const sessionId = `hosted-68c-${nextSession}`;
      if (bunServer.upgrade(request, { data: { sessionId } })) {
        return undefined;
      }
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) {
        sockets.set(socket.data.sessionId, socket);
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as BridgeMessage;
        if (message.type === 'attach') {
          socket.send(
            JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: socket.data.sessionId,
              projectKey: PROJECT_ID,
              hostInstanceId: runtime.instanceId,
              capabilities: ['worker-port', 'worker-relay'],
            } satisfies BridgeMessage),
          );
          return;
        }
        if (message.type === 'worker-message') {
          runtime.receive({
            type: 'worker-message',
            clientSessionId: socket.data.sessionId,
            message: message.message,
            platform: 'node',
          });
          return;
        }
        const isRelayFrame =
          message.type === 'worker-op' ||
          message.type === 'worker-sub' ||
          message.type === 'worker-unsub';
        if (isRelayFrame) {
          runtime.receive({
            ...message,
            clientSessionId: socket.data.sessionId,
          });
        }
      },
      close(socket) {
        sockets.delete(socket.data.sessionId);
        runtime.receive({
          type: 'worker-client-disconnect',
          clientSessionId: socket.data.sessionId,
        });
      },
    },
  });

  const wsUrl = `ws://127.0.0.1:${server.port}/__pyric/sandbox`;
  const serveUrl = `http://127.0.0.1:${server.port}`;
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

  let attached = false;
  const clientDb: ClientDb = getHostedFirestore({
    url: wsUrl,
    projectKey: PROJECT_ID,
    retryInitialConnection: false,
    onConnection: (state) => {
      if (state === 'attached') {
        attached = true;
      }
    },
  });
  await until(() => attached, 'hosted Auth 68c client attach');
  clientDb.port.postMessage({
    t: 'appConfig',
    options: { projectId: PROJECT_ID },
  } satisfies InboundMessage);

  const adminWs = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    adminWs.once('open', () => resolve());
    adminWs.once('error', reject);
  });
  const core = createRemoteSandboxCore(
    {
      send(msg) {
        if (adminWs.readyState === WebSocket.OPEN) {
          adminWs.send(JSON.stringify(msg));
        }
      },
    },
    { serveUrl },
  );
  adminWs.on('message', (data) => {
    core.handleMessage(JSON.parse(String(data)) as BridgeMessage);
  });
  core.start();
  await core.ready;

  const remoteSandbox = createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl,
    close: () => {
      core.dispose('closed');
      adminWs.close();
    },
  }) as unknown as Sandbox;

  appSeq += 1;
  const adminApp = initializeAdminApp({ sandbox: remoteSandbox, projectId: PROJECT_ID }, `admin-hosted-68c-${appSeq}`);
  const adminAuth = getAdminAuth(adminApp);
  const auth = clientAuth.getAuth(clientDb);
  const rtdb = rtdbGetDatabase(clientDb);
  const storage = clientStorage.getStorage(clientDb);
  const methodConnection = {};

  function requireCurrent() {
    const user = auth.currentUser;
    if (user === null) {
      throw new Error('Expected signed-in Node-hosted user');
    }
    return user;
  }

  return {
    async signInAnonymously() {
      const cred = await clientAuth.signInAnonymously(auth);
      const res = await cred.user.getIdTokenResult();
      return { uid: cred.user.uid, claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signInWithCustomToken(token) {
      const cred = await clientAuth.signInWithCustomToken(auth, token);
      const res = await cred.user.getIdTokenResult();
      return { uid: cred.user.uid, claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signInWithEmailAndPassword(email, password) {
      const cred = await clientAuth.signInWithEmailAndPassword(auth, email, password);
      const res = await cred.user.getIdTokenResult();
      return { uid: cred.user.uid, claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async reauthCurrentWithPassword(email, password) {
      const user = requireCurrent();
      await clientReauthWithCredential(user, EmailAuthProvider.credential(email, password));
      const res = await user.getIdTokenResult();
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async reloadCurrent() {
      const user = requireCurrent();
      await clientAuth.reload(user);
      const res = await user.getIdTokenResult();
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async forceRefreshCurrent() {
      const user = requireCurrent();
      const res = await user.getIdTokenResult(true);
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signInWithEmailLinkRoundTrip(email) {
      await clientActionCodes.sendSignInLinkToEmail(auth, email, {
        url: 'https://app.example.com/finish',
        handleCodeInApp: true,
      });
      const mail = await clientActionCodes.takeAuthMail(auth, email);
      if (mail === null) {
        throw new Error('Expected outbound sign-in link mail');
      }
      const cred = await clientActionCodes.signInWithEmailLink(auth, email, mail.link);
      const res = await cred.user.getIdTokenResult();
      return { claims: res.claims, signInProvider: res.signInProvider ?? null };
    },
    async signOut() {
      await clientAuth.signOut(auth);
    },
    async adminCreateUser(props) {
      await adminAuth.createUser(props);
    },
    async adminSetCustomClaims(uid, claims) {
      await adminAuth.setCustomUserClaims(uid, claims);
    },
    async adminMintCustomToken(uid, developerClaims) {
      return adminAuth.createCustomToken(uid, developerClaims);
    },
    async advanceClock(ms) {
      const outcome = await runtime.runMethod(
        { key: 'sandbox.advanceClock', args: { ms }, projectDir },
        methodConnection,
      );
      if (!outcome.ok) {
        throw new Error(`sandbox.advanceClock failed: ${outcome.summary}`);
      }
    },
    async writeRtdb(path, value) {
      await rtdbSet(rtdbRef(rtdb, path), value);
    },
    async writeFirestore(path, data) {
      await clientSetDoc(clientDoc(clientDb, path), data);
    },
    async checkStoragePrefix(prefix) {
      await clientStorage.listAll(clientStorage.ref(storage, prefix));
    },
    async cleanup() {
      await deleteAdminApp(adminApp);
      core.dispose('closed');
      adminWs.close();
      try {
        clientDb.port.close();
      } catch {
        // Ignore already-closed port.
      }
      await runtime.close();
      await server.stop(true);
    },
  };
}
