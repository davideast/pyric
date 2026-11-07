/**
 * The Node register's half of live mode's pass-through (#2122) and where it
 * finds `@pyric/live` (#2116):
 *
 * - the installed `@pyric/live` resolves from the register entry's own
 *   package first, then from the project root;
 * - the pass-through list takes what `pyricLive({ passThrough })` takes, and
 *   throws on anything else;
 * - a listed import resolves to the app's installed SDK, the stop lets its
 *   entry and the packages it needs load, and the network guard lets its
 *   hosts through, while unlisted imports stay refused;
 * - Realtime Database's hosts, which the live database row's SDK reaches,
 *   pass with no list, but only from a file of the installed SDK;
 * - AI Logic's host is a live row host: it passes with no list, a `fetch` to
 *   it only from a file of the installed SDK, and no import passes it through;
 * - so is Cloud Storage's, which the Storage row's SDK reaches with `fetch`;
 * - and so are Installations' and FCM registrations', which the Messaging
 *   SDK reaches with `fetch`. Remote Config, which passes through, reaches
 *   Installations the same way, and its own host stays caller-checked;
 * - `firebase-admin`, listed, resolves to the real Admin SDK, the stop lets
 *   its entry and everything its tree imports load, and the network guard
 *   lets a token source and Google's hosts through from its files only.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveResolutionRoot, recordedPassThrough, LIVE_PASS_THROUGH_VARIABLE } from '../../src/register/live-package.js';
import { registerRows, registerRowsResolution, type RegisterRowPackage } from '../../src/register/supplied-rows.js';
import { suppliedRowsStopFor, type ResolvedLoad } from '../../src/register/swap-or-stop.js';
import { installLiveNetGuard, liveEgressRule, passThroughHosts } from '../../src/register/live-net-guard.js';
import { passThroughSdkPackages, passThroughSet, type PassThroughSpecifier } from '../../src/serve/vite-supplied-rows.js';
import type { ServedFirebaseSpecifier } from '../../src/serve/firebase-module-swap.js';

const scratch = mkdtempSync(join(tmpdir(), 'live-register-pass-through-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A folder holding a package named `@pyric/live` with a `register` export, as an install has it. */
function livePackageAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@pyric/live', type: 'module', exports: { './register': './register.js' } }));
  writeFileSync(join(dir, 'register.js'), '');
  return dir;
}

/** A project folder, with `@pyric/live` installed in its `node_modules` or not. */
function projectAt(name: string, installed: boolean): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true }));
  if (installed) livePackageAt(join(dir, 'node_modules', '@pyric', 'live'));
  return dir;
}

describe('where the register finds @pyric/live', () => {
  test('from the package the register entry was loaded from, before the project root', () => {
    const project = projectAt('both', true);
    const beside = livePackageAt(join(scratch, 'rules', 'node_modules', '@pyric', 'live'));
    expect(liveResolutionRoot(project, beside)).toBe(beside);
  });

  test('from the project root when the entry gives no folder, or the package does not resolve there', () => {
    const project = projectAt('project-only', true);
    expect(liveResolutionRoot(project, undefined)).toBe(project);
    const empty = join(scratch, 'not-a-package');
    mkdirSync(empty, { recursive: true });
    expect(liveResolutionRoot(project, empty)).toBe(project);
  });

  test('beside the app when the project root has none', () => {
    const project = projectAt('web', false);
    const beside = livePackageAt(join(scratch, 'sibling', 'node_modules', '@pyric', 'live'));
    expect(liveResolutionRoot(project, beside)).toBe(beside);
  });
});

describe('the pass-through list', () => {
  test('takes every served import with no live row', () => {
    expect([...passThroughSet(['firebase/remote-config', 'firebase/functions'])]).toEqual([
      'firebase/remote-config',
      'firebase/functions',
    ]);
  });

  test('takes firebase-admin, with no SDK package of its own for the page', () => {
    expect([...passThroughSet(['firebase-admin', 'firebase/functions'])]).toEqual(['firebase-admin', 'firebase/functions']);
    expect([...passThroughSdkPackages(passThroughSet(['firebase-admin']))]).toEqual([]);
  });

  test('throws on a row, its service under another entry, an Admin SDK subpath or an SDK package', () => {
    for (const entry of ['firebase/firestore', 'firebase/auth', 'firebase/firestore/lite', 'firebase-admin/app', '@firebase/database']) {
      expect(() => passThroughSet([entry])).toThrow(`${entry} cannot pass through`);
    }
  });

  test('reaches children as the first process recorded it', () => {
    expect(recordedPassThrough({})).toEqual([]);
    expect(recordedPassThrough({ [LIVE_PASS_THROUGH_VARIABLE]: '' })).toEqual([]);
    expect(recordedPassThrough({ [LIVE_PASS_THROUGH_VARIABLE]: 'firebase/remote-config,firebase/functions' })).toEqual(['firebase/remote-config', 'firebase/functions']);
  });
});

const ROWS: RegisterRowPackage = {
  projectUrl: 'file:///app/package.json',
  refusal: (specifier) => Object.assign(new Error(`refused ${specifier}`), { code: 'PYRIC_LIVE_REFUSED' }),
  moduleSource: () => null,
};

function resolutionOf(passThrough: readonly PassThroughSpecifier[], specifier: string, open = true) {
  const rows = registerRows(new Set(passThrough));
  if (open) rows.open(ROWS);
  return registerRowsResolution(rows, { specifier, importer: 'file:///app/server.mjs', conditions: ['node', 'import'] });
}

describe('a passed-through import under the register', () => {
  test('resolves to the installed SDK as the app wrote it, and an unlisted one is refused', () => {
    expect(resolutionOf(['firebase/functions'], 'firebase/functions')).toEqual({ kind: 'pass-through' });
    const remoteConfig = resolutionOf(['firebase/functions'], 'firebase/remote-config');
    expect(remoteConfig.kind).toBe('refused');
    expect(resolutionOf([], 'firebase/functions').kind).toBe('refused');
  });

  test('is refused while the rows are shut', () => {
    expect(resolutionOf(['firebase/functions'], 'firebase/functions', false).kind).toBe('refused');
  });
});

describe('firebase-admin under the register', () => {
  test('resolves to the real Admin SDK, by every entry, only when it is listed', () => {
    for (const specifier of ['firebase-admin', 'firebase-admin/app', 'firebase-admin/firestore']) {
      expect(resolutionOf(['firebase-admin'], specifier), specifier).toEqual({ kind: 'admin-pass-through' });
      expect(resolutionOf(['firebase/functions'], specifier).kind, specifier).toBe('refused');
      expect(resolutionOf(['firebase-admin'], specifier, false).kind, specifier).toBe('refused');
    }
  });

  test('passes no client import through', () => {
    expect(resolutionOf(['firebase-admin'], 'firebase/functions').kind).toBe('refused');
  });
});

const FIREBASE_DIR = 'file:///app/node_modules/firebase/';
const FUNCTIONS_DIR = 'file:///app/node_modules/@firebase/functions/';
const ADMIN_DIR = 'file:///app/node_modules/firebase-admin/';
const SERVER_FIRESTORE_DIR = 'file:///app/node_modules/@google-cloud/firestore/';
const SERVER_STORAGE_DIR = 'file:///app/node_modules/@google-cloud/storage/';

const PACKAGE_DIRS: ReadonlyArray<readonly [string, string]> = [
  [FIREBASE_DIR, 'firebase'],
  [FUNCTIONS_DIR, '@firebase/functions'],
  [ADMIN_DIR, 'firebase-admin'],
  [SERVER_FIRESTORE_DIR, '@google-cloud/firestore'],
  [SERVER_STORAGE_DIR, '@google-cloud/storage'],
];

/** A load with its package named from the URL, so no manifest is read. */
function loadOf(specifier: string, url: string, importer: string | undefined): ResolvedLoad {
  const nameOf = (file: string) => PACKAGE_DIRS.find(([dir]) => file.startsWith(dir))?.[1] ?? null;
  const pathInPackage = (file: string) => (file.startsWith(FIREBASE_DIR) ? file.slice(FIREBASE_DIR.length) : null);
  return { specifier, url, importer, nameOf, pathInPackage };
}

describe('the stop for a passed-through import', () => {
  const passThrough = new Set<ServedFirebaseSpecifier>(['firebase/functions']);
  const packages = passThroughSdkPackages(passThrough);
  const entry = `${FIREBASE_DIR}functions/dist/index.mjs`;

  test('lets its entry load, then the SDK package that entry imports', () => {
    const allowed = new Set<string>();
    const grant = { isRowImport: false, isEsmImport: true, isPassThroughImport: true, passThroughPackages: packages };
    expect(suppliedRowsStopFor(loadOf('firebase/functions', entry, 'file:///app/server.mjs'), allowed, grant)).toBeNull();
    expect(allowed.has(entry)).toBe(true);
    const sdk = `${FUNCTIONS_DIR}dist/esm/index.esm.js`;
    const fromEntry = { isRowImport: false, isEsmImport: true, passThroughPackages: packages };
    expect(suppliedRowsStopFor(loadOf('@firebase/functions', sdk, entry), allowed, fromEntry)).toBeNull();
    expect(allowed.has(sdk)).toBe(true);
  });

  test('stops a load of another entry by the listed name, a require(), and the package without the list', () => {
    const grant = { isRowImport: false, isEsmImport: true, isPassThroughImport: true, passThroughPackages: packages };
    const other = `${FIREBASE_DIR}remote-config/dist/index.mjs`;
    expect(suppliedRowsStopFor(loadOf('firebase/functions', other, 'file:///app/server.mjs'), new Set(), grant)).not.toBeNull();
    const required = { ...grant, isEsmImport: false };
    expect(suppliedRowsStopFor(loadOf('firebase/functions', entry, 'file:///app/server.cjs'), new Set(), required)).not.toBeNull();
    const sdk = `${FUNCTIONS_DIR}dist/esm/index.esm.js`;
    const withoutList = { isRowImport: false, isEsmImport: true };
    expect(suppliedRowsStopFor(loadOf('@firebase/functions', sdk, entry), new Set([entry]), withoutList)).not.toBeNull();
  });
});

describe('the stop for firebase-admin, listed', () => {
  const adminEntry = `${ADMIN_DIR}lib/app/index.js`;
  const serverFirestore = `${SERVER_FIRESTORE_DIR}build/src/index.js`;
  const adminImport = { isRowImport: false, isEsmImport: true, isAdminImport: true };
  const fromAdminTree = { isRowImport: false, isEsmImport: false, isFromAdminTree: true };
  const fromApp = { isRowImport: false, isEsmImport: true };

  test("lets the app's firebase-admin import load the real Admin SDK, by import or require()", () => {
    const outcomes = [
      suppliedRowsStopFor(loadOf('firebase-admin/app', adminEntry, 'file:///app/server.mjs'), new Set(), adminImport),
      suppliedRowsStopFor(loadOf('firebase-admin/app', adminEntry, 'file:///app/server.cjs'), new Set(), { ...adminImport, isEsmImport: false }),
    ];
    expect(outcomes).toEqual([null, null]);
  });

  test('lets the files of its tree load what it needs, the server Firestore SDK and the client SDK among them', () => {
    const loads = [
      loadOf('@google-cloud/firestore', serverFirestore, adminEntry),
      loadOf('@firebase/functions', `${FUNCTIONS_DIR}dist/index.cjs.js`, adminEntry),
      loadOf('./utils', `${ADMIN_DIR}lib/utils/index.js`, adminEntry),
    ];
    expect(loads.map((load) => suppliedRowsStopFor(load, new Set(), fromAdminTree))).toEqual([null, null, null]);
  });

  test("stops the app's own import of the server Storage SDK, and lets the Admin SDK's tree load it", () => {
    const serverStorage = `${SERVER_STORAGE_DIR}build/cjs/src/index.js`;
    const fromAppStop = suppliedRowsStopFor(loadOf('@google-cloud/storage', serverStorage, 'file:///app/server.mjs'), new Set(), fromApp);
    const fromTreeStop = suppliedRowsStopFor(loadOf('@google-cloud/storage', serverStorage, adminEntry), new Set(), fromAdminTree);
    expect({ fromApp: (fromAppStop as { code?: string } | null)?.code, fromTree: fromTreeStop }).toEqual({
      fromApp: 'PYRIC_REAL_SDK_STOPPED',
      fromTree: null,
    });
  });

  test("stops the app's own load of the Admin SDK by any other route, and of the server Firestore SDK", () => {
    const stops = [
      suppliedRowsStopFor(loadOf('/app/node_modules/firebase-admin/lib/app/index.js', adminEntry, 'file:///app/server.mjs'), new Set(), fromApp),
      suppliedRowsStopFor(loadOf('@google-cloud/firestore', serverFirestore, 'file:///app/server.mjs'), new Set(), fromApp),
      suppliedRowsStopFor(loadOf('firebase-admin/app', `${FIREBASE_DIR}app/dist/index.mjs`, 'file:///app/server.mjs'), new Set(), adminImport),
    ];
    expect(stops.map((stop) => (stop as { code?: string } | null)?.code)).toEqual([
      'PYRIC_REAL_SDK_STOPPED',
      'PYRIC_REAL_SDK_STOPPED',
      'PYRIC_REAL_SDK_STOPPED',
    ]);
  });
});

const FUNCTIONS_HOST = 'us-central1-demo.cloudfunctions.net';
const REMOTE_CONFIG_HOST = 'firebaseremoteconfig.googleapis.com';

describe('the network guard for a passed-through import', () => {
  test('names the hosts of each listed service, and passes them only for the installed SDK', () => {
    expect(passThroughHosts(['firebase/functions'])).toEqual(['cloudfunctions.net']);
    const hosts = passThroughHosts(['firebase/functions']);
    const fromAnyFile = liveEgressRule(undefined, { hosts, isLiveSdkFile: () => true });
    expect(fromAnyFile(FUNCTIONS_HOST, '/')).toBeNull();
    expect(fromAnyFile(REMOTE_CONFIG_HOST, '/')).not.toBeNull();
    const fromNoSdkFile = liveEgressRule(undefined, { hosts, isLiveSdkFile: () => false });
    expect(fromNoSdkFile(FUNCTIONS_HOST, '/')?.reason).toContain('only the installed SDK of an import that passes through');
    expect(liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => true })(FUNCTIONS_HOST, '/')).not.toBeNull();
  });
});

describe('the network guard for the live database row', () => {
  test('passes Realtime Database hosts with no list, only for the installed SDK', () => {
    const fromSdk = liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => true });
    expect(fromSdk('demo-default-rtdb.firebaseio.com', '/')).toBeNull();
    expect(fromSdk('demo-default-rtdb.europe-west1.firebasedatabase.app', '/')).toBeNull();
    const fromNoSdkFile = liveEgressRule()('demo-default-rtdb.firebaseio.com', '/');
    expect(fromNoSdkFile?.service).toBe('Realtime Database');
    expect(fromNoSdkFile?.reason).toContain('Realtime Database');
  });
});

/**
 * The guard installed on stand-ins, so the test process's own sockets stay
 * unpatched: what each seam let out is recorded instead of sent.
 */
function guardedSeams(isLiveSdkFile: (url: string) => boolean) {
  const sent: string[] = [];
  const logged: string[] = [];
  const fetchScope = { fetch: (async () => { sent.push('fetch'); return new Response(''); }) as unknown as typeof fetch };
  const tls = { connect: (..._args: unknown[]) => { sent.push('tls.connect'); return {}; } };
  const net = { connect: () => { sent.push('net.connect'); return {}; }, createConnection: () => { sent.push('net.connect'); return {}; } };
  const requestPrototype = {
    onSocket(this: unknown, _socket: unknown, error?: unknown) {
      sent.push(error === undefined || error === null ? 'https.request' : 'https.request refused');
    },
  };
  const agent = {
    addRequest(request: { onSocket(socket: unknown, error?: unknown): unknown }) {
      return request.onSocket({});
    },
  };
  const hooks = installLiveNetGuard({
    isLiveSdkFile,
    scope: { [Symbol.for('undici.globalDispatcher.1')]: { dispatch: () => true } },
    env: {},
    write: (line) => logged.push(line),
    net,
    tls,
    fetchScope,
    agentPrototypes: [],
    socketPrototypes: [],
    requestPrototypes: [requestPrototype],
    liveAgentPrototypes: [agent],
  });
  /** An `https.request` to `host`, as Node's Agent hands it a socket. */
  const httpsRequest = (host: string) => {
    const request = Object.assign(Object.create(requestPrototype) as object, { host, method: 'GET', path: '/.json?auth=secret' });
    agent.addRequest(request as { onSocket(socket: unknown, error?: unknown): unknown });
  };
  return { sent, logged, fetchScope, tls, httpsRequest, stop: () => hooks.stop() };
}

const DATABASE_HOST = 'demo-default-rtdb.firebaseio.com';

/** A stand-in SDK file: the guard knows it as one the stop let load for the database row. */
const sdkFile = join(scratch, 'database-sdk.mjs');
writeFileSync(sdkFile, [
  // Never in tail position: bun turns `return f()` into a tail call and drops this file's frame from the stack.
  'export function sdkFetch(scope, url) { const calls = [scope.fetch(url)]; return calls[0]; }',
  'export function sdkConnect(tls, host) { const sockets = [tls.connect({ host, port: 443, servername: host })]; return sockets[0]; }',
  'export function sdkCallback(callback) { const results = [callback()]; return results[0]; }',
  'export function sdkRequest(httpsRequest, host) { const requests = [httpsRequest(host)]; return requests[0]; }',
].join('\n'));
const sdkUrl = pathToFileURL(sdkFile).href;

interface StandInSdk {
  sdkFetch(scope: unknown, url: string): Promise<unknown>;
  sdkConnect(tls: unknown, host: string): unknown;
  sdkCallback(callback: () => unknown): unknown;
  sdkRequest(httpsRequest: (host: string) => void, host: string): unknown;
}

/** The guard's code when `connect` throws its refusal, or `connected`. */
function connectOutcome(connect: () => unknown): string | undefined {
  try {
    connect();
    return 'connected';
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('the network guard for a Realtime Database host, with no list, by caller', () => {
  test('refuses fetch, https.request and tls.connect from an app file', async () => {
    const seams = guardedSeams((url) => url === sdkUrl);
    try {
      const fetched = await seams.fetchScope.fetch(`https://${DATABASE_HOST}/.json?auth=secret`).then(() => 'sent', (error: Error) => error.message);
      seams.httpsRequest(DATABASE_HOST);
      const connected = (() => {
        try {
          seams.tls.connect({ host: DATABASE_HOST, port: 443 });
          return 'connected';
        } catch (error) {
          return (error as { code?: string }).code;
        }
      })();
      expect({ fetched, connected, sent: seams.sent }).toEqual({
        fetched: 'fetch failed',
        connected: 'PYRIC_GUARD_BLOCKED',
        sent: ['https.request refused'],
      });
    } finally {
      seams.stop();
    }
  });

  test('lets fetch and tls.connect out from a file the stop let load', async () => {
    const seams = guardedSeams((url) => url === sdkUrl);
    try {
      const sdk = (await import(sdkUrl)) as StandInSdk;
      await sdk.sdkFetch(seams.fetchScope, `https://${DATABASE_HOST}/.json`);
      sdk.sdkConnect(seams.tls, DATABASE_HOST);
      expect(seams.sent).toEqual(['fetch', 'tls.connect']);
    } finally {
      seams.stop();
    }
  });

  test('refuses an app callback the SDK runs, code made by new Function, and an https.request from the SDK file', async () => {
    const seams = guardedSeams((url) => url === sdkUrl);
    try {
      const sdk = (await import(sdkUrl)) as StandInSdk;
      const fromCallback = connectOutcome(() => sdk.sdkCallback(() => {
        const sockets = [seams.tls.connect({ host: DATABASE_HOST, port: 443 })];
        return sockets[0];
      }));
      const made = new Function('tls', 'host', 'const sockets = [tls.connect({ host, port: 443 })]; return sockets[0];') as (tls: unknown, host: string) => unknown;
      const fromMadeCode = connectOutcome(() => sdk.sdkCallback(() => made(seams.tls, DATABASE_HOST)));
      const madeDirect = connectOutcome(() => sdk.sdkCallback(made.bind(null, seams.tls, DATABASE_HOST)));
      sdk.sdkRequest(seams.httpsRequest, DATABASE_HOST);
      expect({ fromCallback, fromMadeCode, madeDirect, sent: seams.sent }).toEqual({
        fromCallback: 'PYRIC_GUARD_BLOCKED',
        fromMadeCode: 'PYRIC_GUARD_BLOCKED',
        madeDirect: 'PYRIC_GUARD_BLOCKED',
        sent: ['https.request refused'],
      });
    } finally {
      seams.stop();
    }
  });
});

const AI_LOGIC_HOST = 'firebasevertexai.googleapis.com';

describe('the network guard for the AI Logic host, with no list', () => {
  test('passes it as a live row host, and no import passes it through', () => {
    expect(passThroughHosts(['firebase/ai'])).toEqual([]);
    expect(liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => true })(AI_LOGIC_HOST, '/')).toBeNull();
    expect(liveEgressRule()(AI_LOGIC_HOST, '/')).toBeNull();
  });

  test("lets a fetch out from a file the stop let load, and refuses the app's own fetch", async () => {
    const seams = guardedSeams((url) => url === sdkUrl);
    try {
      const sdk = (await import(sdkUrl)) as StandInSdk;
      await sdk.sdkFetch(seams.fetchScope, `https://${AI_LOGIC_HOST}/v1beta/projects/demo/models/m:generateContent`);
      const fromApp = await seams.fetchScope.fetch(`https://${AI_LOGIC_HOST}/v1beta/projects/demo/models/m:generateContent`)
        .then(() => 'sent', (error: Error) => error.message);
      expect({ fromApp, sent: seams.sent }).toEqual({ fromApp: 'fetch failed', sent: ['fetch'] });
    } finally {
      seams.stop();
    }
  });

  test('refuses an https.request, naming firebase/ai as the way to make the call', () => {
    const seams = guardedSeams(() => true);
    try {
      seams.httpsRequest(AI_LOGIC_HOST);
      const refusal = seams.logged.find((line) => line.includes(`BLOCK ${AI_LOGIC_HOST}`)) ?? '';
      expect(seams.sent).toEqual(['https.request refused']);
      expect(refusal).toContain('in live mode only the installed AI Logic SDK, firebase/ai, reaches this host');
      expect(refusal).toContain('the Live API WebSocket, which @pyric/live refuses at the factory');
      expect(refusal).toContain('Make the call through firebase/ai, or from a process without @pyric/live/register');
      expect(refusal).not.toContain('firebase/firestore');
    } finally {
      seams.stop();
    }
  });

  test('keeps the Firestore, Auth and App Check remedy for their hosts', () => {
    const seams = guardedSeams(() => true);
    try {
      seams.httpsRequest('firestore.googleapis.com');
      const refusal = seams.logged.find((line) => line.includes('BLOCK firestore.googleapis.com')) ?? '';
      expect(refusal).toContain('Make the call through firebase/auth, firebase/firestore or firebase/app-check, so pyric observes it');
      expect(refusal).not.toContain('firebase/ai');
    } finally {
      seams.stop();
    }
  });
});

const STORAGE_HOST = 'firebasestorage.googleapis.com';
const STORAGE_OBJECT = `https://${STORAGE_HOST}/v0/b/demo.firebasestorage.app/o/a.bin`;

describe('the network guard for the Cloud Storage host, with no list', () => {
  test('passes it as a live row host', () => {
    expect(liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => true })(STORAGE_HOST, '/')).toBeNull();
    expect(liveEgressRule()(STORAGE_HOST, '/')).toBeNull();
  });

  test("lets a fetch out from a file the stop let load, and refuses the app's own fetch", async () => {
    const seams = guardedSeams((url) => url === sdkUrl);
    try {
      const sdk = (await import(sdkUrl)) as StandInSdk;
      await sdk.sdkFetch(seams.fetchScope, STORAGE_OBJECT);
      const fromApp = await seams.fetchScope.fetch(STORAGE_OBJECT).then(() => 'sent', (error: Error) => error.message);
      expect({ fromApp, sent: seams.sent }).toEqual({ fromApp: 'fetch failed', sent: ['fetch'] });
    } finally {
      seams.stop();
    }
  });

  test('refuses an https.request, naming firebase/storage as the way to make the call', () => {
    const seams = guardedSeams(() => true);
    try {
      seams.httpsRequest(STORAGE_HOST);
      const refusal = seams.logged.find((line) => line.includes(`BLOCK ${STORAGE_HOST}`)) ?? '';
      expect(seams.sent).toEqual(['https.request refused']);
      expect(refusal).toContain('Make the call through firebase/storage, or from a process without @pyric/live/register');
      expect(refusal).not.toContain('firebase/firestore');
    } finally {
      seams.stop();
    }
  });
});

const INSTALLATIONS_HOST = 'firebaseinstallations.googleapis.com';
const REGISTRATIONS_HOST = 'fcmregistrations.googleapis.com';
const MESSAGING_HOSTS = [INSTALLATIONS_HOST, REGISTRATIONS_HOST];
const REGISTRATIONS_URL = `https://${REGISTRATIONS_HOST}/v1/projects/demo/registrations`;

describe('the network guard for the Messaging hosts, with no list', () => {
  test('passes Installations and FCM registrations as live row hosts, and no import passes them through', () => {
    expect(passThroughHosts(['firebase/messaging', 'firebase/messaging/sw'])).toEqual([]);
    for (const host of MESSAGING_HOSTS) {
      expect(liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => true })(host, '/'), host).toBeNull();
      expect(liveEgressRule()(host, '/'), host).toBeNull();
    }
  });

  test("lets a fetch out from a file the stop let load, and refuses the app's own fetch", async () => {
    const seams = guardedSeams((url) => url === sdkUrl);
    try {
      const sdk = (await import(sdkUrl)) as StandInSdk;
      await sdk.sdkFetch(seams.fetchScope, REGISTRATIONS_URL);
      const fromApp = await seams.fetchScope.fetch(REGISTRATIONS_URL).then(() => 'sent', (error: Error) => error.message);
      expect({ fromApp, sent: seams.sent }).toEqual({ fromApp: 'fetch failed', sent: ['fetch'] });
    } finally {
      seams.stop();
    }
  });

  test('refuses an https.request to either host, naming firebase/messaging as the way to make the call', () => {
    const seams = guardedSeams(() => true);
    try {
      for (const host of MESSAGING_HOSTS) seams.httpsRequest(host);
      expect(seams.sent).toEqual(['https.request refused', 'https.request refused']);
      for (const host of MESSAGING_HOSTS) {
        const refusal = seams.logged.find((line) => line.includes(`BLOCK ${host}`)) ?? '';
        expect(refusal, host).toContain('in live mode only the installed Firebase SDK reaches this host');
        expect(refusal, host).toContain('Make the call through firebase/messaging');
        expect(refusal, host).not.toContain('firebase/firestore');
      }
    } finally {
      seams.stop();
    }
  });
});

describe('the network guard for Remote Config, passed through, now that Installations is a live row host', () => {
  test('lists only its own host, and lets its SDK reach both its host and Installations', async () => {
    expect(passThroughHosts(['firebase/remote-config'])).toEqual([REMOTE_CONFIG_HOST]);
    const hosts = passThroughHosts(['firebase/remote-config']);
    const fromSdk = liveEgressRule(undefined, { hosts, isLiveSdkFile: () => true });
    expect(fromSdk(REMOTE_CONFIG_HOST, '/')).toBeNull();
    expect(fromSdk(INSTALLATIONS_HOST, '/')).toBeNull();
    const fromNoSdkFile = liveEgressRule(undefined, { hosts, isLiveSdkFile: () => false });
    expect(fromNoSdkFile(REMOTE_CONFIG_HOST, '/')?.reason).toContain('only the installed SDK of an import that passes through');

    const seams = guardedSeams((url) => url === sdkUrl);
    try {
      const sdk = (await import(sdkUrl)) as StandInSdk;
      await sdk.sdkFetch(seams.fetchScope, `https://${INSTALLATIONS_HOST}/v1/projects/demo/installations`);
      const fromApp = await seams.fetchScope.fetch(`https://${INSTALLATIONS_HOST}/v1/projects/demo/installations`)
        .then(() => 'sent', (error: Error) => error.message);
      expect({ fromApp, sent: seams.sent }).toEqual({ fromApp: 'fetch failed', sent: ['fetch'] });
    } finally {
      seams.stop();
    }
  });
});

const TOKEN_HOST = 'oauth2.googleapis.com';
const TOKEN_URL = `https://${TOKEN_HOST}/token`;
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const ADMIN_AUTH_HOST = 'identitytoolkit.googleapis.com';

/**
 * A stand-in Admin SDK file. It holds the stand-in Agent too: in Node the
 * Agent is the runtime's, which the caller check reads past, so here its
 * frame must not read as the app's.
 */
const adminFile = join(scratch, 'admin-sdk.mjs');
writeFileSync(adminFile, [
  // Never in tail position: bun turns `return f()` into a tail call and drops this file's frame from the stack.
  'export function adminFetch(scope, url) { const calls = [scope.fetch(url)]; return calls[0]; }',
  'export function adminConnect(tls, host) { const sockets = [tls.connect({ host, port: 443, servername: host })]; return sockets[0]; }',
  'export function adminRequest(agent, request) { const requests = [agent.addRequest(request)]; return requests[0]; }',
  'export const adminAgent = { addRequest(request) { const sockets = [request.onSocket({})]; return sockets[0]; } };',
  // The Admin SDK calling `https.request`, `fetch` or `tls.connect` after an app replaced it with a pass-through wrapper.
  'export function adminVia(send, ...args) { const results = [send(...args)]; return results[0]; }',
].join('\n'));
const adminUrl = pathToFileURL(adminFile).href;

interface StandInAdmin {
  adminFetch(scope: unknown, url: string): Promise<unknown>;
  adminConnect(tls: unknown, host: string): unknown;
  adminRequest(agent: unknown, request: unknown): unknown;
  adminAgent: { addRequest(request: unknown): unknown };
  adminVia<T>(send: (...args: never[]) => T, ...args: unknown[]): T;
}

/** The guard with `firebase-admin` listed or not, on stand-ins whose Agent is the stand-in Admin SDK's. */
async function adminSeams(passThrough: string[], adminProjectId: string | null = null) {
  const admin = (await import(adminUrl)) as StandInAdmin;
  const sent: string[] = [];
  const slot = Symbol.for('undici.globalDispatcher.1');
  const scope: Record<symbol, unknown> = { [slot]: { dispatch: () => true } };
  // As undici's fetch does, the stand-in dispatches after an await, when no caller frame is left on the stack.
  const fetchScope = {
    fetch: (async (url: string) => {
      await Promise.resolve();
      (scope[slot] as { dispatch(opts: unknown, handler: unknown): unknown }).dispatch({ origin: new URL(url).origin, path: new URL(url).pathname }, {});
      sent.push('fetch');
      return new Response('');
    }) as unknown as typeof fetch,
  };
  const tls = { connect: (..._args: unknown[]) => { sent.push('tls.connect'); return {}; } };
  const net = { connect: () => ({}), createConnection: () => ({}) };
  const requestPrototype = {
    onSocket(this: unknown, _socket: unknown, error?: unknown) {
      sent.push(error === undefined || error === null ? 'https.request' : 'https.request refused');
    },
  };
  // The runtime's Agent and https.request, as an app or its wrapper reaches them: no frame of the Admin SDK's tree.
  const runtimeAgent = { addRequest(request: { onSocket(socket: unknown): unknown }) { const sockets = [request.onSocket({})]; return sockets[0]; } };
  const runtimeRequest = (request: unknown) => {
    const sent = [runtimeAgent.addRequest(request as { onSocket(socket: unknown): unknown })];
    return sent[0];
  };
  const https = { request: runtimeRequest };
  const hooks = installLiveNetGuard({
    isLiveSdkFile: () => false,
    isAdminSdkFile: (url) => url === adminUrl,
    adminProjectId: () => adminProjectId,
    passThrough,
    scope,
    env: {},
    write: () => {},
    net,
    tls,
    fetchScope,
    agentPrototypes: [],
    socketPrototypes: [],
    requestPrototypes: [requestPrototype],
    liveAgentPrototypes: [admin.adminAgent],
    adminEntryPoints: [
      { object: https, key: 'request' },
      { object: tls, key: 'connect' },
      { object: fetchScope, key: 'fetch' },
    ],
  });
  const realFetch = fetchScope.fetch;
  const request = (host: string) => Object.assign(Object.create(requestPrototype) as object, { host, method: 'POST', path: '/v1/accounts:lookup' });
  return { admin, sent, fetchScope, tls, https, runtimeRequest, realFetch, request, stop: () => hooks.stop() };
}

/** An APM's pass-through wrappers on https.request, fetch and tls.connect, in an app file, installed after the guard. */
/**
 * How an instrumentation library puts its wrapper in place: a plain
 * assignment, `Object.defineProperty` with a data descriptor (shimmer, which
 * OpenTelemetry uses), or `Reflect.defineProperty`.
 */
type WrapInstall = 'assignment' | 'Object.defineProperty' | 'Reflect.defineProperty';

const WRAP_INSTALLS: readonly WrapInstall[] = ['assignment', 'Object.defineProperty', 'Reflect.defineProperty'];

function installWrapper(object: object, key: string, wrapper: unknown, install: WrapInstall): void {
  const descriptor = { configurable: true, enumerable: true, writable: true, value: wrapper };
  if (install === 'Object.defineProperty') Object.defineProperty(object, key, descriptor);
  if (install === 'Reflect.defineProperty') Reflect.defineProperty(object, key, descriptor);
  if (install === 'assignment') Reflect.set(object, key, wrapper);
}

function wrapLikeAnApm(
  seams: { https: { request: (request: unknown) => unknown }; fetchScope: { fetch: typeof fetch }; tls: { connect: (...args: unknown[]) => unknown } },
  install: WrapInstall = 'assignment',
) {
  const wrap = { calls: 0 };
  const request = seams.https.request;
  installWrapper(seams.https, 'request', function wrappedRequest(this: unknown, ...args: unknown[]) {
    wrap.calls += 1;
    const results = [Reflect.apply(request, this, args)];
    return results[0];
  }, install);
  const fetchFn = seams.fetchScope.fetch;
  installWrapper(seams.fetchScope, 'fetch', function wrappedFetch(this: unknown, ...args: unknown[]) {
    wrap.calls += 1;
    const results = [Reflect.apply(fetchFn, this, args) as ReturnType<typeof fetch>];
    return results[0]!;
  }, install);
  const connect = seams.tls.connect;
  installWrapper(seams.tls, 'connect', function wrappedConnect(this: unknown, ...args: unknown[]) {
    wrap.calls += 1;
    const results = [Reflect.apply(connect, this, args)];
    return results[0];
  }, install);
  return wrap;
}

describe('the network guard for firebase-admin, listed', () => {
  test('passes its token sources, Cloud Storage and the public-key paths only from a file of its tree', () => {
    const fromTree = liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => false, isAdminSdkFile: () => true });
    const fromApp = liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => false, isAdminSdkFile: () => false });
    const destinations: Array<[string, string | undefined]> = [
      [TOKEN_HOST, '/token'],
      ['metadata.google.internal', '/computeMetadata/v1/instance/service-accounts/default/token'],
      ['169.254.169.254', '/'],
      ['iamcredentials.googleapis.com', '/v1/projects/-/serviceAccounts/a@b.iam.gserviceaccount.com:signBlob'],
      ['storage.googleapis.com', '/storage/v1/b/demo/o'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/securetoken%40system.gserviceaccount.com?alt=json'],
      ['www.googleapis.com', '/oauth2/v4/token'],
      ['www.googleapis.com', undefined],
    ];
    expect(destinations.map(([host, path]) => fromTree(host, path))).toEqual(destinations.map(() => null));
    expect(destinations.map(([host, path]) => fromApp(host, path)?.verdict)).toEqual(destinations.map(() => 'block'));
  });

  test('refuses a file of its tree any other Google host or token source', () => {
    const fromTree = liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => false, isAdminSdkFile: () => true });
    const destinations: Array<[string, string]> = [
      ['pubsub.googleapis.com', '/v1/projects/demo/topics'],
      ['fcm.googleapis.com', '/v1/projects/demo/messages:send'],
      ['sts.googleapis.com', '/v1/token'],
      ['www.googleapis.com', '/drive/v3/files'],
      ['www.googleapis.com', '/oauth2/v3/token'],
      ['www.googleapis.com', '/oauth2/v4/token/../../drive/v3/files'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/../../../drive/v3/files'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/%2e%2e/%2E%2E/%2e%2e/drive/v3/files'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/%252e%252e/drive/v3/files'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/..%2f..%2f..%2fdrive/v3/files'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/%5c..%5cdrive'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/#/../../../drive/v3/files'],
      ['www.googleapis.com', '/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com#'],
      ['demo-default-rtdb.firebaseio.com', '/.json'],
      ['s-usc1a-nss-2001.firebaseio.com', '/.json'],
    ];
    expect(destinations.map(([host, path]) => fromTree(host, path)?.verdict)).toEqual(destinations.map(() => 'block'));
  });

  test('reads the path from a full-URL request target, as the host or as the path, before judging it', () => {
    const fromTree = liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => false, isAdminSdkFile: () => true });
    const keys = 'http://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
    expect(fromTree(keys, undefined)).toBeNull();
    expect(fromTree('www.googleapis.com', keys)).toBeNull();
    const refused = [
      'http://www.googleapis.com/drive/v3/files',
      'http://www.googleapis.com:80/robot/v1/metadata/x509/../../../drive/v3/files',
      'http://www.googleapis.com',
      'http://s-usc1a-nss-2001.firebaseio.com/.json',
    ];
    expect(refused.map((target) => fromTree(target, undefined)?.verdict)).toEqual(refused.map(() => 'block'));
    expect(refused.map((target) => fromTree('proxy.internal', target)?.verdict)).toEqual(refused.map(() => 'block'));
    expect(fromTree('www.googleapis.com:443', undefined)).toBeNull();
  });

  test("lets its token fetch, socket and https.request out, and refuses the app's own", async () => {
    const seams = await adminSeams(['firebase-admin']);
    try {
      const { admin } = seams;
      await admin.adminFetch(seams.fetchScope, TOKEN_URL);
      await admin.adminFetch(seams.fetchScope, METADATA_TOKEN_URL);
      admin.adminConnect(seams.tls, TOKEN_HOST);
      admin.adminRequest(admin.adminAgent, seams.request(ADMIN_AUTH_HOST));
      const fromAdmin = [...seams.sent];
      const fromApp = await Promise.all([TOKEN_URL, METADATA_TOKEN_URL].map((url) => seams.fetchScope.fetch(url).then(() => 'sent', (error: Error) => error.message)));
      const connected = connectOutcome(() => seams.tls.connect({ host: TOKEN_HOST, port: 443 }));
      admin.adminAgent.addRequest(seams.request(ADMIN_AUTH_HOST));
      expect({ fromAdmin, fromApp, connected, sent: seams.sent.slice(fromAdmin.length) }).toEqual({
        fromAdmin: ['fetch', 'fetch', 'tls.connect', 'https.request'],
        fromApp: ['fetch failed', 'fetch failed'],
        connected: 'PYRIC_GUARD_BLOCKED',
        sent: ['https.request refused'],
      });
    } finally {
      seams.stop();
    }
  });

  test.each(WRAP_INSTALLS)("lets its calls out through an app's pass-through wrapper on https.request, fetch and tls.connect installed by %s, and refuses the app's own through it", async (install) => {
    const seams = await adminSeams(['firebase-admin']);
    try {
      const { admin } = seams;
      const wrap = wrapLikeAnApm(seams, install);
      const tokenRequest = () => Object.assign(seams.request(TOKEN_HOST), { path: '/token' });
      admin.adminVia(seams.https.request, tokenRequest());
      admin.adminVia(seams.https.request, seams.request(ADMIN_AUTH_HOST));
      await admin.adminVia(seams.fetchScope.fetch, TOKEN_URL).catch(() => 'refused');
      connectOutcome(() => admin.adminVia(seams.tls.connect, { host: TOKEN_HOST, port: 443, servername: TOKEN_HOST }));
      const fromAdmin = [...seams.sent];
      seams.https.request(tokenRequest());
      seams.https.request(seams.request(ADMIN_AUTH_HOST));
      const fetched = await seams.fetchScope.fetch(TOKEN_URL).then(() => 'sent', (error: Error) => error.message);
      const connected = connectOutcome(() => seams.tls.connect({ host: TOKEN_HOST, port: 443, servername: TOKEN_HOST }));
      expect({ wrapped: wrap.calls, fromAdmin, fromApp: seams.sent.slice(fromAdmin.length), fetched, connected }).toEqual({
        wrapped: 8,
        fromAdmin: ['https.request', 'https.request', 'fetch', 'tls.connect'],
        fromApp: ['https.request refused', 'https.request refused'],
        fetched: 'fetch failed',
        connected: 'PYRIC_GUARD_BLOCKED',
      });
    } finally {
      seams.stop();
    }
  });

  test("refuses a wrapper's own request sent before it forwards the Admin SDK's call, and that call too", async () => {
    const seams = await adminSeams(['firebase-admin']);
    try {
      const { admin } = seams;
      const forward = seams.https.request;
      const ownRequest = Object.assign(seams.request('iamcredentials.googleapis.com'), { path: '/v1/projects/-/serviceAccounts/x:generateAccessToken' });
      seams.https.request = function wrappedRequest(this: unknown, ...args: unknown[]) {
        forward(ownRequest);
        const results = [Reflect.apply(forward, this, args)];
        return results[0];
      };
      admin.adminVia(seams.https.request, Object.assign(seams.request(TOKEN_HOST), { path: '/token' }));
      const fetchForward = seams.fetchScope.fetch;
      const ownFetches: Array<Promise<string>> = [];
      seams.fetchScope.fetch = function wrappedFetch(this: unknown, ...args: unknown[]) {
        ownFetches.push(fetchForward('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/x:generateAccessToken').then(() => 'sent', (error: Error) => error.message));
        const results = [Reflect.apply(fetchForward, this, args) as ReturnType<typeof fetch>];
        return results[0]!;
      } as typeof fetch;
      const adminFetched = await admin.adminVia(seams.fetchScope.fetch, TOKEN_URL).then(() => 'sent', (error: Error) => error.message);
      expect({ sent: seams.sent, ownFetched: await Promise.all(ownFetches), adminFetched }).toEqual({
        sent: ['https.request refused', 'https.request refused'],
        ownFetched: ['fetch failed'],
        adminFetched: 'fetch failed',
      });
    } finally {
      seams.stop();
    }
  });

  test('refuses an app callback the Admin SDK runs, through the wrappers or not, for each of its hosts', async () => {
    const seams = await adminSeams(['firebase-admin'], 'demo');
    try {
      const { admin } = seams;
      wrapLikeAnApm(seams);
      const hosts: Array<[string, string]> = [
        [TOKEN_HOST, '/token'],
        ['www.googleapis.com', '/oauth2/v4/token'],
        ['iamcredentials.googleapis.com', '/v1/projects/-/serviceAccounts/x:generateAccessToken'],
        ['storage.googleapis.com', '/storage/v1/b/other-bucket/o'],
        [ADMIN_AUTH_HOST, '/v1/accounts:lookup'],
      ];
      const fetches: Array<Promise<string>> = [];
      const connections: Array<string | undefined> = [];
      // A custom credential's getAccessToken, a token listener or a transaction update: app code the Admin SDK calls.
      const callback = () => {
        for (const [host, path] of hosts) {
          seams.https.request(Object.assign(seams.request(host), { path }));
          seams.runtimeRequest(Object.assign(seams.request(host), { path }));
          fetches.push(seams.fetchScope.fetch(`https://${host}${path}`).then(() => 'sent', (error: Error) => error.message));
          fetches.push(seams.realFetch(`https://${host}${path}`).then(() => 'sent', (error: Error) => error.message));
          // A live row host's socket passes for any caller; its request is what the guard refuses.
          const isLiveRowHost = host === ADMIN_AUTH_HOST;
          if (!isLiveRowHost) connections.push(connectOutcome(() => seams.tls.connect({ host, port: 443, servername: host })));
        }
        return null;
      };
      admin.adminVia(callback);
      expect({ sent: seams.sent, fetched: await Promise.all(fetches), connections }).toEqual({
        sent: hosts.flatMap(() => ['https.request refused', 'https.request refused']),
        fetched: hosts.flatMap(() => ['fetch failed', 'fetch failed']),
        connections: hosts.slice(0, -1).map(() => 'PYRIC_GUARD_BLOCKED'),
      });
    } finally {
      seams.stop();
    }
  });

  test('refuses its fetch to another Google host, after the dispatch as at the call', async () => {
    const seams = await adminSeams(['firebase-admin']);
    try {
      const fetched = await seams.admin.adminFetch(seams.fetchScope, 'https://pubsub.googleapis.com/v1/projects/demo/topics')
        .then(() => 'sent', (error: Error) => error.message);
      expect({ fetched, sent: seams.sent }).toEqual({ fetched: 'fetch failed', sent: [] });
    } finally {
      seams.stop();
    }
  });

  test("passes its socket to the project's own Realtime Database, and refuses another project's", async () => {
    const seams = await adminSeams(['firebase-admin'], 'demo');
    try {
      const { admin } = seams;
      const ownHosts = ['demo-default-rtdb.firebaseio.com', 'demo-default-rtdb.europe-west1.firebasedatabase.app', 'demo.firebaseio.com'];
      const otherHosts = ['other-default-rtdb.firebaseio.com', 'demo-reports.firebaseio.com', 'other-default-rtdb.europe-west1.firebasedatabase.app'];
      expect({
        own: ownHosts.map((host) => connectOutcome(() => admin.adminConnect(seams.tls, host))),
        other: otherHosts.map((host) => connectOutcome(() => admin.adminConnect(seams.tls, host))),
      }).toEqual({
        own: ownHosts.map(() => 'connected'),
        other: otherHosts.map(() => 'PYRIC_GUARD_BLOCKED'),
      });
    } finally {
      seams.stop();
    }
  });

  test("passes its socket to a Realtime Database shard, and refuses the app's own", async () => {
    const seams = await adminSeams(['firebase-admin'], 'demo');
    try {
      const { admin } = seams;
      const shards = ['s-usc1a-nss-2001.firebaseio.com', 's-gke-euw1-nssi1-1.europe-west1.firebasedatabase.app'];
      expect({
        fromTree: shards.map((host) => connectOutcome(() => admin.adminConnect(seams.tls, host))),
        fromApp: shards.map((host) => connectOutcome(() => seams.tls.connect({ host, port: 443 }))),
      }).toEqual({
        fromTree: shards.map(() => 'connected'),
        fromApp: shards.map(() => 'PYRIC_GUARD_BLOCKED'),
      });
    } finally {
      seams.stop();
    }
  });

  test("passes gtoken's Storage token path for its tree, and refuses the app's own fetch to it", async () => {
    const seams = await adminSeams(['firebase-admin']);
    try {
      const url = 'https://www.googleapis.com/oauth2/v4/token';
      const fromTree = await seams.admin.adminFetch(seams.fetchScope, url).then(() => 'sent', (error: Error) => error.message);
      const fromApp = await seams.fetchScope.fetch(url).then(() => 'sent', (error: Error) => error.message);
      expect({ fromTree, fromApp }).toEqual({ fromTree: 'sent', fromApp: 'fetch failed' });
    } finally {
      seams.stop();
    }
  });

  test("leaves the app's own socket to the project's Realtime Database as it was: refused, and passed from a live row's SDK file", () => {
    const project = { hosts: [], isAdminSdkFile: () => false, adminProjectId: () => 'demo' };
    const fromApp = liveEgressRule(undefined, { ...project, isLiveSdkFile: () => false });
    const fromRowSdk = liveEgressRule(undefined, { ...project, isLiveSdkFile: () => true });
    expect({ fromApp: fromApp(DATABASE_HOST, '/')?.service, fromRowSdk: fromRowSdk(DATABASE_HOST, '/') })
      .toEqual({ fromApp: 'Realtime Database', fromRowSdk: null });
  });

  test('refuses FCM for its tree and the app, naming firebase-admin/messaging', () => {
    const fromTree = liveEgressRule(undefined, { hosts: [], isLiveSdkFile: () => false, isAdminSdkFile: () => true, adminProjectId: () => 'demo' });
    const refusal = fromTree('fcm.googleapis.com', '/v1/projects/demo/messages:send');
    expect({ verdict: refusal?.verdict, namesMessaging: refusal?.reason?.includes('firebase-admin/messaging') }).toEqual({ verdict: 'block', namesMessaging: true });
  });

  test('passes nothing from those files when firebase-admin is not listed', async () => {
    const seams = await adminSeams(['firebase/functions']);
    try {
      const { admin } = seams;
      const fetched = await admin.adminFetch(seams.fetchScope, TOKEN_URL).then(() => 'sent', (error: Error) => error.message);
      const connected = connectOutcome(() => admin.adminConnect(seams.tls, TOKEN_HOST));
      admin.adminRequest(admin.adminAgent, seams.request(ADMIN_AUTH_HOST));
      expect({ fetched, connected, sent: seams.sent }).toEqual({ fetched: 'fetch failed', connected: 'PYRIC_GUARD_BLOCKED', sent: ['https.request refused'] });
    } finally {
      seams.stop();
    }
  });
});

const VM_CALLER_FIXTURE = fileURLToPath(new URL('./fixtures/live-guard-vm-caller.mjs', import.meta.url));
const DIST_GUARD = new URL('../../dist/register/live-net-guard.js', import.meta.url).href;

describe('the network guard for a Realtime Database host, under Node', () => {
  // Bun names a vm frame `file:///`; Node names it `evalmachine.<anonymous>` or its `filename`, with isEval() false.
  test('refuses a callback the SDK runs that node:vm built, whatever filename it was given', () => {
    const result = spawnSync('node', [VM_CALLER_FIXTURE, DIST_GUARD, sdkUrl], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      fromSdk: 'connected',
      vmDefault: 'PYRIC_GUARD_BLOCKED',
      vmEmptyName: 'PYRIC_GUARD_BLOCKED',
      vmNamed: 'PYRIC_GUARD_BLOCKED',
      vmNodeName: 'PYRIC_GUARD_BLOCKED',
      sent: ['tls.connect'],
    });
  }, 30_000);
});
