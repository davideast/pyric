import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getDatabase as getAdminDatabase, ServerValue } from 'pyric-admin/database';
import { observeAdminWritesSentinelsAndValidation } from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-writes-sentinels-and-validation.ts';
import { CASCADE_BINDINGS_AUTH_RULES } from '../../../../../conformance/probes/rtdb/rtdb-rules-cascade-bindings-and-auth-context.ts';
import { bundleWorker, workerSourceHash } from '../../../../src/serve/bundler.js';
import { attachViteSsrActivation } from '../../../../src/serve/vite-ssr-activation.js';
import { restoreSharedWorker } from './support.ts';
import {
  cleanupServerProcessFixtures,
  createViteSsrProjectDir,
  loadAbruptExitBehavior,
  loadAdminWritesBehavior,
  loadCascadeAuthBehavior,
  loadCleanDisconnectBehavior,
  openRegisteredServerHost,
  runPlainNodeScript,
  runRegisteredNodeScript,
  spawnRegisteredNodeChild,
  waitForCondition,
} from './rtdb-server-process-support.ts';

restoreSharedWorker();

function wrapReplayRules(): Record<string, unknown> {
  return {
    rules: {
      pyric_oracle: {
        replay: structuredClone(CASCADE_BINDINGS_AUTH_RULES),
        open: { '.read': true, '.write': true },
      },
    },
  };
}

function fakeListeningViteServer(port: number): ViteDevServer {
  const address: AddressInfo = { address: '127.0.0.1', family: 'IPv4', port };
  const http = Object.assign(new EventEmitter(), {
    listening: true,
    address: () => address,
  });
  return { httpServer: http } as unknown as ViteDevServer;
}

beforeAll(async () => {
  await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
}, 60_000);

afterEach(async () => {
  await cleanupServerProcessFixtures();
});

const CASCADE_HELPER_SOURCE = `
function isDeniedError(err) {
  let code = '';
  let msg = '';
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string') code = err.code;
    if (typeof err.message === 'string') msg = err.message;
  }
  return code === 'PERMISSION_DENIED' || msg.includes('PERMISSION_DENIED');
}

export async function runCascadeProbe({ get, set, ref, db, signIn }) {
  const prefix = 'pyric_oracle/replay/';
  async function attemptRead(path) {
    try {
      await get(ref(db, path));
      return { allowed: true, permissionDenied: false };
    } catch (err) {
      return { allowed: false, permissionDenied: isDeniedError(err) };
    }
  }
  async function attemptWrite(path, value) {
    try {
      await set(ref(db, path), value);
      return { allowed: true, permissionDenied: false };
    } catch (err) {
      return { allowed: false, permissionDenied: isDeniedError(err) };
    }
  }

  const unauthedReadChildFalse = await attemptRead(prefix + 'cascadingRead/childFalse');
  const unauthedWriteChildFalse = await attemptWrite(prefix + 'cascadingWrite/childFalse', { updated: false });
  const unauthedOnAuthNullRead = await attemptRead(prefix + 'unauthedOnly');
  const unauthedOnAuthNullWrite = await attemptWrite(prefix + 'unauthedOnly', { guestWrite: 1 });
  const unauthedAnonymousProviderRead = await attemptRead(prefix + 'providerBound');
  const unauthedAnonymousProviderWrite = await attemptWrite(prefix + 'providerBound', { byGuest: true });

  const authedUid = await signIn();

  const authedReadChildFalse = await attemptRead(prefix + 'cascadingRead/childFalse');
  const authedWriteChildFalse = await attemptWrite(prefix + 'cascadingWrite/childFalse', { updated: true });
  const ownUidMatchingOwnerWrite = await attemptWrite(
    prefix + 'users/' + authedUid + '/profile',
    { owner: authedUid },
  );
  const ownUidMismatchedOwnerWrite = await attemptWrite(
    prefix + 'users/' + authedUid + '/profile',
    { owner: 'wrong-owner' },
  );
  const otherUidWrite = await attemptWrite(
    prefix + 'users/other-fixed-uid/profile',
    { owner: 'other-fixed-uid' },
  );
  const ownUidRead = await attemptRead(prefix + 'users/' + authedUid + '/profile');
  const otherUidRead = await attemptRead(prefix + 'users/other-fixed-uid/profile');
  const authedOnAuthNullRead = await attemptRead(prefix + 'unauthedOnly');
  const authedOnAuthNullWrite = await attemptWrite(prefix + 'unauthedOnly', { authedWrite: 1 });
  const authedAnonymousProviderRead = await attemptRead(prefix + 'providerBound');
  const authedAnonymousProviderWrite = await attemptWrite(prefix + 'providerBound', { byAnon: true });

  return {
    authedUid,
    behavior: {
      ancestorCascadeOverridesChildFalse: {
        authedReadChildFalse,
        unauthedReadChildFalse,
        authedWriteChildFalse,
        unauthedWriteChildFalse,
      },
      pathVariableBindings: {
        ownUidMatchingOwnerWrite,
        ownUidMismatchedOwnerWrite,
        otherUidWrite,
        ownUidRead,
        otherUidRead,
      },
      authNullVsBoundToken: {
        unauthedOnAuthNullRead,
        unauthedOnAuthNullWrite,
        authedOnAuthNullRead,
        authedOnAuthNullWrite,
        authedAnonymousProviderRead,
        authedAnonymousProviderWrite,
        unauthedAnonymousProviderRead,
        unauthedAnonymousProviderWrite,
      },
    },
  };
}
`;

describe('RTDB registered server process (@pyric/cli/register, RS1)', () => {
  it('replays cascade/$uid/auth rules and clean/abrupt onDisconnect + .info/connected + goOffline exit', async () => {
    const cascadeExpected = loadCascadeAuthBehavior();
    const cleanExpected = loadCleanDisconnectBehavior();
    const abruptExpected = loadAbruptExitBehavior();

    const host = await openRegisteredServerHost({ databaseRules: wrapReplayRules() });
    const adminDb = await host.openAdminObserver();

    await adminDb.ref('pyric_oracle/replay/cascadingRead/childFalse').set({ secret: 'visible-via-parent' });
    await adminDb.ref('pyric_oracle/replay/users/other-fixed-uid/profile').set({ owner: 'other-fixed-uid' });
    await adminDb.ref('pyric_oracle/replay/unauthedOnly').set({ publicGuest: true });
    await adminDb.ref('pyric_oracle/replay/providerBound').set({ anonAllowed: true });

    const cleanEvents: unknown[] = [];
    const cleanPath = 'pyric_oracle/open/rs1-clean-disconnect';
    const cleanCb = (snap: { val(): unknown }) => {
      cleanEvents.push(snap.val());
    };
    adminDb.ref(cleanPath).on('value', cleanCb);
    await waitForCondition(() => cleanEvents.length >= 1, 'initial observer null event');

    const rs1Script = `
${CASCADE_HELPER_SOURCE}
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, get, set, onValue, onDisconnect, goOffline, goOnline } from 'firebase/database';

const app = initializeApp({
  apiKey: 'demo',
  appId: 'demo',
  projectId: 'demo-oracle',
  databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
});
const db = getDatabase(app);
const auth = getAuth(app);

const connectedTransitions = [];
const unsubConnected = onValue(ref(db, '.info/connected'), (snap) => {
  connectedTransitions.push(snap.val());
});

const cascade = await runCascadeProbe({
  get,
  set,
  ref,
  db,
  signIn: async () => (await signInAnonymously(auth)).user.uid,
});

const cleanPath = '${cleanPath}';
await set(ref(db, cleanPath), { state: 'online' });
await onDisconnect(ref(db, cleanPath)).set({ state: 'offline' });
const beforeDisconnect = (await get(ref(db, cleanPath))).val();

goOffline(db);
await new Promise((r) => setTimeout(r, 80));
goOnline(db);
const afterDisconnect = (await get(ref(db, cleanPath))).val();
await set(ref(db, cleanPath), { state: 'reconnected' });

goOffline(db);
await new Promise((r) => setTimeout(r, 80));
goOnline(db);
const secondControl = { secondDisconnectControl: { drained: true }, state: 'reconnected' };
await set(ref(db, cleanPath), secondControl);
await set(ref(db, cleanPath), { state: 'reconnected' });
const terminalAfterReconnect = (await get(ref(db, cleanPath))).val();
unsubConnected();

// Release the Node RTDB socket hold so the process exits cleanly without process.exit().
goOffline(db);
console.log('RS1_RESULT ' + JSON.stringify({
  authedUid: cascade.authedUid,
  cascade: cascade.behavior,
  connectedSawTrue: connectedTransitions.includes(true),
  connectedSawFalse: connectedTransitions.includes(false),
  beforeDisconnect,
  afterDisconnect,
  terminalAfterReconnect,
}));
`;

    const rs1Res = await runRegisteredNodeScript(host.projectDir, 'rs1-client.mjs', rs1Script, {
      PYRIC_SANDBOX: `remote:${host.serveUrl}`,
      PYRIC_SANDBOX_INSTANCE: host.instanceId,
    });
    expect(rs1Res.status, rs1Res.stderr).toBe(0);
    const resultLine = rs1Res.stdout.split('\n').find((line) => line.startsWith('RS1_RESULT '));
    expect(resultLine).toBeDefined();
    const rawResultLine = resultLine ?? 'RS1_RESULT {}';
    const parsed = JSON.parse(rawResultLine.slice('RS1_RESULT '.length)) as {
      authedUid: string;
      cascade: unknown;
      connectedSawTrue: boolean;
      connectedSawFalse: boolean;
      beforeDisconnect: unknown;
      afterDisconnect: unknown;
      terminalAfterReconnect: unknown;
    };

    expect(parsed.cascade).toEqual(cascadeExpected);
    expect(parsed.connectedSawTrue).toBe(true);
    expect(parsed.connectedSawFalse).toBe(true);
    expect(parsed.beforeDisconnect).toEqual(cleanExpected.beforeDisconnect);
    expect(parsed.afterDisconnect).toEqual(cleanExpected.afterDisconnect);
    expect(parsed.terminalAfterReconnect).toEqual(cleanExpected.terminalAfterReconnect);
    await waitForCondition(() => cleanEvents.length >= cleanExpected.events.length, 'clean disconnect events');
    expect(cleanEvents).toEqual(cleanExpected.events);
    adminDb.ref(cleanPath).off('value', cleanCb);

    const ownProfileSnap = await adminDb.ref(`pyric_oracle/replay/users/${parsed.authedUid}/profile`).get();
    expect(ownProfileSnap.val()).toEqual({ owner: parsed.authedUid });

    // Replay rtdb-modular-ondisconnect-abrupt-exit: registered writer stays alive
    // (held by RTDB), registers onDisconnect, is SIGKILLed, and observer sees offline.
    const abruptPath = 'pyric_oracle/open/rs1-abrupt-exit';
    const abruptEvents: Array<Record<string, unknown>> = [];
    const abruptCb = (snap: { val(): unknown }) => {
      const value = snap.val();
      if (value !== null && typeof value === 'object') {
        abruptEvents.push(value as Record<string, unknown>);
      }
    };
    adminDb.ref(abruptPath).on('value', abruptCb);

    const abruptScript = `
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, onDisconnect } from 'firebase/database';

const app = initializeApp({
  apiKey: 'demo',
  appId: 'demo',
  projectId: 'demo-oracle',
  databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
});
const db = getDatabase(app);
await set(ref(db, '${abruptPath}'), { state: 'online' });
await onDisconnect(ref(db, '${abruptPath}')).set({ state: 'offline' });
console.log(JSON.stringify({ registered: true }));
`;
    const spawned = spawnRegisteredNodeChild(host.projectDir, 'rs1-abrupt.mjs', abruptScript, {
      PYRIC_SANDBOX: `remote:${host.serveUrl}`,
      PYRIC_SANDBOX_INSTANCE: host.instanceId,
    });
    await waitForCondition(() => spawned.stdout().includes('"registered":true'), 'abrupt writer registration');
    await new Promise((r) => setTimeout(r, 120));
    expect(spawned.child.exitCode).toBeNull();
    spawned.child.kill('SIGKILL');
    const killed = await spawned.waitExit();
    expect(killed.signal).toBe('SIGKILL');
    await waitForCondition(() => abruptEvents.length >= abruptExpected.events.length, 'abrupt offline delivery');
    expect(abruptEvents).toEqual(abruptExpected.events);
    expect((await adminDb.ref(abruptPath).get()).val()).toEqual(abruptExpected.terminal);
    adminDb.ref(abruptPath).off('value', abruptCb);
  }, 45_000);

  it('refuses with failed-precondition on a non-Node host and never falls back in-process', async () => {
    const offHost = await openRegisteredServerHost({ databaseRules: wrapReplayRules(), hosted: false });
    const refusalScript = `
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set } from 'firebase/database';
import * as pyricDb from 'pyric/database';

const app = initializeApp({ apiKey: 'demo', appId: 'demo', projectId: 'demo-oracle' });
let clientFailure = { code: null, message: '' };
try {
  await set(ref(getDatabase(app), 'x'), 1);
} catch (err) {
  let code = null;
  let message = String(err);
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string') code = err.code;
    if (typeof err.message === 'string') message = err.message;
  }
  clientFailure = { code, message };
}
let mirrorCode = null;
try {
  pyricDb.getDatabase(app);
} catch (err) {
  mirrorCode = err.code ?? null;
}
console.log('RS1_REFUSAL ' + JSON.stringify({ clientFailure, mirrorCode }));
process.exit(0);
`;
    const res = await runRegisteredNodeScript(offHost.projectDir, 'rs1-refusal.mjs', refusalScript, {
      PYRIC_SANDBOX: `remote:${offHost.serveUrl}`,
      PYRIC_SANDBOX_INSTANCE: offHost.instanceId,
    });
    expect(res.status, res.stderr).toBe(0);
    const line = res.stdout.split('\n').find((item) => item.startsWith('RS1_REFUSAL '));
    const rawRefusalLine = line ?? 'RS1_REFUSAL {}';
    const out = JSON.parse(rawRefusalLine.slice('RS1_REFUSAL '.length)) as {
      clientFailure: { code: string | null; message: string };
      mirrorCode: string | null;
    };
    expect(out.clientFailure.code).toBe('failed-precondition');
    expect(out.clientFailure.message).toContain('hosted: true');
    expect(out.mirrorCode).toBe('failed-precondition');
  }, 20_000);
});

describe('RTDB server-rendered modules under vite dev (RS2 & RS3)', () => {
  it('replays rtdb-modular-admin-writes-sentinels-and-validation via attachViteSsrActivation bare initializeApp (RS3)', async () => {
    const host = await openRegisteredServerHost({ databaseRules: wrapReplayRules() });
    const port = Number(new URL(host.serveUrl).port);
    const activation = attachViteSsrActivation(fakeListeningViteServer(port), true, {});
    const bareAdminApp = initializeAdminApp(undefined, `rs3-bare-ssr-admin-${Date.now()}`);
    try {
      const ssrAdminDb = getAdminDatabase(bareAdminApp);
      const actual = await observeAdminWritesSentinelsAndValidation(
        ssrAdminDb as unknown as Parameters<typeof observeAdminWritesSentinelsAndValidation>[0],
        ServerValue,
        'pyric_oracle/open',
      );
      expect(actual).toEqual(loadAdminWritesBehavior());
    } finally {
      await deleteAdminApp(bareAdminApp);
      activation.close();
    }
  }, 25_000);

  it('replays cascade/$uid/auth rules across Vite ssrLoadModule client & admin modules, releases on server.close, and refuses SharedWorker (RS2 & RS3)', async () => {
    const cascadeExpected = loadCascadeAuthBehavior();
    const viteDir = createViteSsrProjectDir(wrapReplayRules());

    const ssrClientModule = `
${CASCADE_HELPER_SOURCE}
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, get, set } from 'firebase/database';

function appOnce() {
  const apps = getApps();
  if (apps.length > 0) return apps[0];
  return initializeApp({
    apiKey: 'demo',
    appId: 'demo',
    projectId: 'demo-oracle',
    databaseURL: 'https://demo-oracle-default-rtdb.firebaseio.com',
  });
}

export async function runSsrCascade() {
  const app = appOnce();
  const db = getDatabase(app);
  const auth = getAuth(app);
  return runCascadeProbe({
    get,
    set,
    ref,
    db,
    signIn: async () => (await signInAnonymously(auth)).user.uid,
  });
}

export async function readSharedSession() {
  const app = appOnce();
  const auth = getAuth(app);
  let uid = null;
  if (auth.currentUser) uid = auth.currentUser.uid;
  const db = getDatabase(app);
  const snap = await get(ref(db, 'pyric_oracle/replay/users/' + uid + '/profile'));
  return { appCount: getApps().length, uid, profile: snap.val() };
}
`;

    const ssrAdminModule = `
import { initializeApp, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

function adminOnce() {
  const apps = getApps();
  if (apps.length > 0) return apps[0];
  return initializeApp();
}

export async function seedCascadeFixture() {
  const db = getDatabase(adminOnce());
  await db.ref('pyric_oracle/replay/cascadingRead/childFalse').set({ secret: 'visible-via-parent' });
  await db.ref('pyric_oracle/replay/users/other-fixed-uid/profile').set({ owner: 'other-fixed-uid' });
  await db.ref('pyric_oracle/replay/unauthedOnly').set({ publicGuest: true });
  await db.ref('pyric_oracle/replay/providerBound').set({ anonAllowed: true });
  await db.ref('pyric_oracle/replay/browserSeed').set({ from: 'browser-client' });
}

export async function readAcrossRules(ssrUid) {
  const db = getDatabase(adminOnce());
  const ssrUserSnap = await db.ref('pyric_oracle/replay/users/' + ssrUid + '/profile').get();
  const browserSnap = await db.ref('pyric_oracle/replay/browserSeed').get();
  return { ssrUserProfile: ssrUserSnap.val(), browserSeed: browserSnap.val() };
}
`;

    const sharedWorkerScript = `
import { writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pyric } from '@pyric/cli/vite';

writeFileSync(join(process.cwd(), 'ssr-client.mjs'), ${JSON.stringify(ssrClientModule)});
writeFileSync(join(process.cwd(), 'ssr-admin.mjs'), ${JSON.stringify(ssrAdminModule)});

const swPort = await new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const swServer = await createServer({
  appType: 'custom',
  configFile: false,
  logLevel: 'silent',
  root: process.cwd(),
  plugins: [pyric({ hosted: false, ui: false, capture: false, project: 'demo-oracle' })],
  server: { port: swPort, host: '127.0.0.1' },
  optimizeDeps: { noDiscovery: true },
});
await swServer.listen();
function extractRefusal(err) {
  let code = null;
  let message = String(err);
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string') code = err.code;
    if (typeof err.message === 'string') message = err.message;
  }
  return { code, message };
}
let rs2Refusal = { code: null, message: '' };
try {
  const swClient = await swServer.ssrLoadModule('/ssr-client.mjs');
  await swClient.readSharedSession();
} catch (err) {
  rs2Refusal = extractRefusal(err);
}
let rs3Refusal = { code: null, message: '' };
try {
  const swAdmin = await swServer.ssrLoadModule('/ssr-admin.mjs');
  await swAdmin.seedCascadeFixture();
} catch (err) {
  rs3Refusal = extractRefusal(err);
}
await swServer.close();
console.log('VITE_SW_REFUSAL ' + JSON.stringify({ rs2Refusal, rs3Refusal }));
`;

    const swDir = createViteSsrProjectDir(wrapReplayRules());
    const swRes = await runPlainNodeScript(swDir, 'run-vite-sw.mjs', sharedWorkerScript, {}, 30_000);
    expect(swRes.status, swRes.stderr).toBe(0);
    const swLine = swRes.stdout.split('\n').find((line) => line.startsWith('VITE_SW_REFUSAL '));
    expect(swLine).toBeDefined();
    const rawSwLine = swLine ?? 'VITE_SW_REFUSAL {}';
    const swOut = JSON.parse(rawSwLine.slice('VITE_SW_REFUSAL '.length)) as {
      rs2Refusal: { code: string | null; message: string };
      rs3Refusal: { code: string | null; message: string };
    };
    expect(swOut.rs2Refusal.code).toBe('failed-precondition');
    expect(swOut.rs2Refusal.message).toContain('pyric({ hosted: true })');
    expect(swOut.rs3Refusal.code).toBe('failed-precondition');
    expect(swOut.rs3Refusal.message).toContain('pyric({ hosted: true })');

    const hostedScript = `
import { writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'vite';
import { pyric } from '@pyric/cli/vite';

writeFileSync(join(process.cwd(), 'ssr-client.mjs'), ${JSON.stringify(ssrClientModule)});
writeFileSync(join(process.cwd(), 'ssr-second.mjs'), 'export { readSharedSession } from "./ssr-client.mjs";\\n');
writeFileSync(join(process.cwd(), 'ssr-admin.mjs'), ${JSON.stringify(ssrAdminModule)});

const hostedPort = await new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const hostedServer = await createServer({
  appType: 'custom',
  configFile: false,
  logLevel: 'silent',
  root: process.cwd(),
  ssr: { noExternal: ['firebase'] },
  plugins: [pyric({ hosted: true, ui: false, capture: false, project: 'demo-oracle' })],
  server: { port: hostedPort, host: '127.0.0.1' },
  optimizeDeps: { noDiscovery: true },
});
await hostedServer.listen();
const adminMod = await hostedServer.ssrLoadModule('/ssr-admin.mjs');
await adminMod.seedCascadeFixture();

const clientMod = await hostedServer.ssrLoadModule('/ssr-client.mjs');
const cascadeRes = await clientMod.runSsrCascade();

const secondMod = await hostedServer.ssrLoadModule('/ssr-second.mjs');
const sharedSession = await secondMod.readSharedSession();
const adminReadBack = await adminMod.readAcrossRules(cascadeRes.authedUid);

// Closing the dev server must release the RTDB Node socket hold so this script exits on its own without process.exit().
await hostedServer.close();
console.log('VITE_SSR_RESULT ' + JSON.stringify({
  cascade: cascadeRes.behavior,
  authedUid: cascadeRes.authedUid,
  sharedSession,
  adminReadBack,
}));
`;

    const res = await runPlainNodeScript(viteDir, 'run-vite-ssr.mjs', hostedScript, {}, 45_000);
    expect(res.status, res.stderr).toBe(0);
    const outLine = res.stdout.split('\n').find((line) => line.startsWith('VITE_SSR_RESULT '));
    expect(outLine).toBeDefined();
    const rawOutLine = outLine ?? 'VITE_SSR_RESULT {}';
    const out = JSON.parse(rawOutLine.slice('VITE_SSR_RESULT '.length)) as {
      cascade: unknown;
      authedUid: string;
      sharedSession: { appCount: number; uid: string; profile: unknown };
      adminReadBack: { ssrUserProfile: unknown; browserSeed: unknown };
    };

    expect(out.cascade).toEqual(cascadeExpected);
    expect(out.sharedSession).toEqual({
      appCount: 1,
      uid: out.authedUid,
      profile: { owner: out.authedUid },
    });
    expect(out.adminReadBack).toEqual({
      ssrUserProfile: { owner: out.authedUid },
      browserSeed: { from: 'browser-client' },
    });
  }, 60_000);
});
