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
 *   hosts through, while unlisted imports stay refused.
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
import { passThroughSdkPackages, passThroughSet } from '../../src/serve/vite-supplied-rows.js';
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
    expect([...passThroughSet(['firebase/database', 'firebase/ai', 'firebase/messaging'])]).toEqual([
      'firebase/database',
      'firebase/ai',
      'firebase/messaging',
    ]);
  });

  test('throws on a row, its service under another entry, firebase-admin or an SDK package', () => {
    for (const entry of ['firebase/firestore', 'firebase/auth', 'firebase/firestore/lite', 'firebase-admin', '@firebase/database']) {
      expect(() => passThroughSet([entry])).toThrow(`${entry} cannot pass through`);
    }
  });

  test('reaches children as the first process recorded it', () => {
    expect(recordedPassThrough({})).toEqual([]);
    expect(recordedPassThrough({ [LIVE_PASS_THROUGH_VARIABLE]: '' })).toEqual([]);
    expect(recordedPassThrough({ [LIVE_PASS_THROUGH_VARIABLE]: 'firebase/database,firebase/ai' })).toEqual(['firebase/database', 'firebase/ai']);
  });
});

const ROWS: RegisterRowPackage = {
  projectUrl: 'file:///app/package.json',
  refusal: (specifier) => Object.assign(new Error(`refused ${specifier}`), { code: 'PYRIC_LIVE_REFUSED' }),
  moduleSource: () => null,
};

function resolutionOf(passThrough: readonly ServedFirebaseSpecifier[], specifier: string, open = true) {
  const rows = registerRows(new Set(passThrough));
  if (open) rows.open(ROWS);
  return registerRowsResolution(rows, { specifier, importer: 'file:///app/server.mjs', conditions: ['node', 'import'] });
}

describe('a passed-through import under the register', () => {
  test('resolves to the installed SDK as the app wrote it, and an unlisted one is refused', () => {
    expect(resolutionOf(['firebase/database'], 'firebase/database')).toEqual({ kind: 'pass-through' });
    const storage = resolutionOf(['firebase/database'], 'firebase/storage');
    expect(storage.kind).toBe('refused');
    expect(resolutionOf([], 'firebase/database').kind).toBe('refused');
  });

  test('is refused while the rows are shut', () => {
    expect(resolutionOf(['firebase/database'], 'firebase/database', false).kind).toBe('refused');
  });
});

const FIREBASE_DIR = 'file:///app/node_modules/firebase/';
const DATABASE_DIR = 'file:///app/node_modules/@firebase/database/';

/** A load with its package named from the URL, so no manifest is read. */
function loadOf(specifier: string, url: string, importer: string | undefined): ResolvedLoad {
  const nameOf = (file: string) => (file.startsWith(FIREBASE_DIR) ? 'firebase' : file.startsWith(DATABASE_DIR) ? '@firebase/database' : null);
  const pathInPackage = (file: string) => (file.startsWith(FIREBASE_DIR) ? file.slice(FIREBASE_DIR.length) : null);
  return { specifier, url, importer, nameOf, pathInPackage };
}

describe('the stop for a passed-through import', () => {
  const passThrough = new Set<ServedFirebaseSpecifier>(['firebase/database']);
  const packages = passThroughSdkPackages(passThrough);
  const entry = `${FIREBASE_DIR}database/dist/index.mjs`;

  test('lets its entry load, then the SDK package that entry imports', () => {
    const allowed = new Set<string>();
    const grant = { isRowImport: false, isEsmImport: true, isPassThroughImport: true, passThroughPackages: packages };
    expect(suppliedRowsStopFor(loadOf('firebase/database', entry, 'file:///app/server.mjs'), allowed, grant)).toBeNull();
    expect(allowed.has(entry)).toBe(true);
    const sdk = `${DATABASE_DIR}dist/node-esm/index.node.esm.js`;
    const fromEntry = { isRowImport: false, isEsmImport: true, passThroughPackages: packages };
    expect(suppliedRowsStopFor(loadOf('@firebase/database', sdk, entry), allowed, fromEntry)).toBeNull();
    expect(allowed.has(sdk)).toBe(true);
  });

  test('stops a load of another entry by the listed name, a require(), and the package without the list', () => {
    const grant = { isRowImport: false, isEsmImport: true, isPassThroughImport: true, passThroughPackages: packages };
    const other = `${FIREBASE_DIR}storage/dist/index.mjs`;
    expect(suppliedRowsStopFor(loadOf('firebase/database', other, 'file:///app/server.mjs'), new Set(), grant)).not.toBeNull();
    const required = { ...grant, isEsmImport: false };
    expect(suppliedRowsStopFor(loadOf('firebase/database', entry, 'file:///app/server.cjs'), new Set(), required)).not.toBeNull();
    const sdk = `${DATABASE_DIR}dist/node-esm/index.node.esm.js`;
    const withoutList = { isRowImport: false, isEsmImport: true };
    expect(suppliedRowsStopFor(loadOf('@firebase/database', sdk, entry), new Set([entry]), withoutList)).not.toBeNull();
  });
});

describe('the network guard for a passed-through import', () => {
  test('names the hosts of each listed service, and passes them only for the installed SDK', () => {
    expect(passThroughHosts(['firebase/database'])).toEqual(['firebaseio.com', 'firebasedatabase.app']);
    const hosts = passThroughHosts(['firebase/database']);
    const fromAnyFile = liveEgressRule(undefined, { hosts, isLiveSdkFile: () => true });
    expect(fromAnyFile('demo-default-rtdb.firebaseio.com', '/')).toBeNull();
    expect(fromAnyFile('demo-default-rtdb.europe-west1.firebasedatabase.app', '/')).toBeNull();
    expect(fromAnyFile('firebasevertexai.googleapis.com', '/')).not.toBeNull();
    const fromNoSdkFile = liveEgressRule(undefined, { hosts, isLiveSdkFile: () => false });
    expect(fromNoSdkFile('demo-default-rtdb.firebaseio.com', '/')?.reason).toContain('only the installed SDK of an import that passes through');
    expect(liveEgressRule()('demo-default-rtdb.firebaseio.com', '/')).not.toBeNull();
  });
});

/**
 * The guard installed on stand-ins, so the test process's own sockets stay
 * unpatched: what each seam let out is recorded instead of sent.
 */
function guardedSeams(isLiveSdkFile: (url: string) => boolean) {
  const sent: string[] = [];
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
    passThrough: ['firebase/database'],
    scope: { [Symbol.for('undici.globalDispatcher.1')]: { dispatch: () => true } },
    env: {},
    write: () => {},
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
  return { sent, fetchScope, tls, httpsRequest, stop: () => hooks.stop() };
}

const DATABASE_HOST = 'demo-default-rtdb.firebaseio.com';

/** A stand-in SDK file: the guard knows it as one the stop let load for firebase/database. */
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

describe('the network guard for a passed-through host, by caller', () => {
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

const VM_CALLER_FIXTURE = fileURLToPath(new URL('./fixtures/live-guard-vm-caller.mjs', import.meta.url));
const DIST_GUARD = new URL('../../dist/register/live-net-guard.js', import.meta.url).href;

describe('the network guard for a passed-through host, under Node', () => {
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
