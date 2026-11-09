/**
 * Integration tests for `supplied-entry.ts` alongside CommonJS and ESM module
 * instrumentation (`require-in-the-middle` and `import-in-the-middle`).
 *
 * Client-row and ADR 0022 stop tests run on every Node major (including Node 22).
 * Admin-row tests run when `node` is major >= 23 (`it.skipIf(!adminRowsOn)`),
 * because `@pyric/live/register` shuts Admin rows on Node 22.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { ADMIN_ROW_URLS } from '../../src/register/admin-row.js';
import { DEFAULT_SANDBOX_PATH, WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { createSilentLogger } from '../../src/bridge/server/logger.js';
import { attachPeer } from '../../src/bridge/server/peer.js';

const cliDir = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliDir, '../..');
const liveDir = join(repoRoot, 'packages/live');
const liveRegisterFile = join(liveDir, 'dist/register.js');
const suppliedEntryDist = join(cliDir, 'dist/register/supplied-entry.js');

const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const realAdminDir = realpathSync(dirname(requireFromRepo.resolve('firebase-admin/package.json')));
const requireFromFirebase = createRequire(join(realFirebaseDir, 'package.json'));
const requireFromAdmin = createRequire(join(realAdminDir, 'package.json'));

function packageDir(fromFile: string, name: string): string {
  let dir = dirname(fromFile);
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`no ${name} above ${fromFile}`);
}

const gcpFirestoreDir = packageDir(requireFromAdmin.resolve('@google-cloud/firestore'), '@google-cloud/firestore');
const gcpStorageDir = packageDir(requireFromAdmin.resolve('@google-cloud/storage'), '@google-cloud/storage');
const fbDatabaseCompatDir = packageDir(requireFromAdmin.resolve('@firebase/database-compat/standalone'), '@firebase/database-compat');
const fbUtilDir = packageDir(requireFromFirebase.resolve('@firebase/util'), '@firebase/util');
const nodeMajor = Number(spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.split('.')[0]);
const adminRowsOn = nodeMajor >= 23;

/** Stand-in for `require-in-the-middle` (v7/v8) main-entry probe + `onrequire` wrapping. */
const RITM_INDEX_CJS = `'use strict';
const Module = require('node:module');
const path = require('node:path');
function moduleDetailsFromPath(filename) {
  const segs = filename.split(path.sep);
  const nmIdx = segs.lastIndexOf('node_modules');
  if (nmIdx === -1 || nmIdx + 1 >= segs.length) return undefined;
  const first = segs[nmIdx + 1];
  if (first.startsWith('@')) {
    if (nmIdx + 2 >= segs.length) return undefined;
    return { name: first + '/' + segs[nmIdx + 2], basedir: segs.slice(0, nmIdx + 3).join(path.sep) };
  }
  return { name: first, basedir: segs.slice(0, nmIdx + 2).join(path.sep) };
}
function Hook(modules, options, onrequire) {
  if ((this instanceof Hook) === false) return new Hook(modules, options, onrequire);
  if (typeof modules === 'function') { onrequire = modules; modules = null; options = {}; }
  else if (typeof options === 'function') {
    onrequire = options;
    options = Array.isArray(modules) ? {} : (modules || {});
    if (!Array.isArray(modules)) modules = null;
  }
  const hasWhitelist = Array.isArray(modules);
  const internals = options ? options.internals === true : false;
  const self = this;
  this.cache = new Map();
  this._origRequire = Module.prototype.require;
  this._require = Module.prototype.require = function patchedRequire(id) {
    let filename;
    try { filename = Module._resolveFilename(id, this); } catch (_err) { return self._origRequire.apply(this, arguments); }
    if (Module.isBuiltin(filename)) return self._origRequire.apply(this, arguments);
    if (self.cache.has(filename)) return self.cache.get(filename);
    const exports = self._origRequire.apply(this, arguments);
    const stat = moduleDetailsFromPath(filename);
    if (stat === undefined || (hasWhitelist && !modules.includes(stat.name))) return exports;
    if (!internals) {
      let res;
      try { res = require.resolve(stat.name, { paths: [stat.basedir] }); } catch (_err) { return exports; }
      if (res !== filename) return exports;
    }
    const patched = onrequire ? onrequire(exports, stat.name, stat.basedir) : exports;
    self.cache.set(filename, patched);
    return patched;
  };
}

Hook.prototype.unhook = function unhook() {
  if (Module.prototype.require === this._require) Module.prototype.require = this._origRequire;
};

module.exports = Hook;
module.exports.Hook = Hook;
`;

const IITM_REGISTER_MJS = `const INCLUDED = /^(?:.*\\/)?node_modules\\/(?:@firebase\\/[^/]+|firebase|firebase-admin)\\//;
export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('?iitm=true')) return { url: specifier, format: 'module', shortCircuit: true };
  if (specifier.includes('?iitm=ignore')) {
    return { url: specifier.replace('?iitm=ignore', ''), format: 'module', shortCircuit: true };
  }
  const parentURL = context.parentURL?.includes('?iitm=true')
    ? context.parentURL.replace('?iitm=true', '')
    : context.parentURL;
  const result = await nextResolve(specifier, { ...context, parentURL });
  if (result.url.startsWith('file://') && INCLUDED.test(result.url) && result.format === 'module') {
    return { url: result.url + '?iitm=true', format: 'module', shortCircuit: true };
  }
  return result;
}
export async function load(url, context, nextLoad) {
  if (!url.includes('?iitm=true')) return nextLoad(url, context);
  const realUrl = url.replace('?iitm=true', '');
  return { format: 'module', source: 'export * from ' + JSON.stringify(realUrl + '?iitm=ignore') + ';\\n', shortCircuit: true };
}
`;

const PROJECT = 'demo-ritm-fixture';
const INSTANCE_ID = 'demo-ritm-instance';

let projectDir: string;
let stubBackend: Server;
let stubBackendPort: number;
let wsServer: WebSocketServer;
let rtdbWs: WebSocketServer;
let bridgeHttpUrl: string;
let observedCalls: Array<{ service: string; method: string }>;

beforeAll(async () => {
  for (const built of [liveRegisterFile, suppliedEntryDist]) {
    if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
  }

  stubBackend = createServer((req, res) => {
    const respond = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/__pyric/health') {
      return respond(200, {
        status: 'ok',
        mode: 'sandbox',
        instanceId: INSTANCE_ID,
        live: {
          projectId: PROJECT,
          configProjectId: PROJECT,
          configSource: '.firebaserc',
          appProjectIds: [PROJECT],
          billed: { reads: 0, writes: 0, deliveries: 0 },
          admin: { mode: 'observed', observed: true, bypassesRules: true },
        },
      });
    }
    if (req.url === '/__pyric/init.json') {
      return respond(200, {
        instanceId: INSTANCE_ID,
        sessionToken: 'test-session',
        hosted: true,
        projectKey: PROJECT,
        bridgeUrl: `ws://127.0.0.1:${stubBackendPort}${DEFAULT_SANDBOX_PATH}`,
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        seed: null,
      });
    }
    if (req.url?.startsWith('/v1/projects/')) {
      return respond(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Permission denied' } });
    }
    respond(404, { error: { code: 404, message: 'USER_NOT_FOUND' } });
  });
  await new Promise<void>((r) => stubBackend.listen(0, '127.0.0.1', () => r()));
  const stubAddr = stubBackend.address();
  stubBackendPort = typeof stubAddr === 'object' && stubAddr ? stubAddr.port : 0;
  bridgeHttpUrl = `http://127.0.0.1:${stubBackendPort}`;

  observedCalls = [];
  const bridge = createBridge({ version: 'test', projectKey: PROJECT, logger: createSilentLogger() });
  bridge.registerSandboxPeer(
    (message: BridgeMessage) => {
      if (message.type === 'worker-message') {
        const inner = message.message as unknown as { t?: string; call?: { service: string; method: string } };
        if (inner.t === 'observe' && inner.call) {
          observedCalls.push({ service: inner.call.service, method: inner.call.method });
        }
      }
    },
    [],
    'host',
    [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY],
  );

  wsServer = new WebSocketServer({ noServer: true });
  rtdbWs = new WebSocketServer({ noServer: true });
  stubBackend.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === DEFAULT_SANDBOX_PATH) {
      wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      return;
    }
    if (pathname === '/.ws') {
      rtdbWs.handleUpgrade(req, socket, head, (ws) => rtdbWs.emit('connection', ws, req));
      return;
    }
    socket.destroy();
  });
  rtdbWs.on('connection', (socket) => {
    socket.send(
      JSON.stringify({ t: 'c', d: { t: 'h', d: { ts: Date.now(), v: '5', h: `127.0.0.1:${stubBackendPort}`, s: 's1' } } }),
    );
    socket.on('message', (raw) => {
      const text = String(raw);
      if (text === '0') return;
      try {
        const frame = JSON.parse(text) as { d?: { r?: number; a?: string } };
        if (typeof frame.d?.r !== 'number') return;
        const ok = frame.d.a === 's' || frame.d.a === 'gauth' || frame.d.a === 'auth' || frame.d.a === 'n';
        socket.send(
          JSON.stringify({
            t: 'd',
            d: { r: frame.d.r, b: ok ? { s: 'ok', d: {} } : { s: 'permission_denied', d: 'Permission denied' } },
          }),
        );
      } catch {
        // Non-JSON RTDB keepalive frames require no reply.
      }
    });
  });
  wsServer.on('connection', (socket) => {
    attachPeer(bridge, socket);
    socket.on('message', (raw) => {
      try {
        const parsed = JSON.parse(String(raw)) as { type?: string; message?: { t?: string; id?: string } };
        if (
          parsed.type === 'worker-message' &&
          (parsed.message?.t === 'observe' || parsed.message?.t === 'unobserved') &&
          typeof parsed.message.id === 'string'
        ) {
          socket.send(
            JSON.stringify({ type: 'worker-message', message: { t: 'res', id: parsed.message.id, ok: true, value: null } }),
          );
        }
      } catch {
        // Non-JSON bridge control frames are handled by attachPeer.
      }
    });
  });

  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-ritm-')));
  const nm = join(projectDir, 'node_modules');
  for (const sub of ['@pyric', '@google-cloud', '@firebase', 'require-in-the-middle', 'import-in-the-middle/lib']) {
    mkdirSync(join(nm, sub), { recursive: true });
  }
  symlinkSync(cliDir, join(nm, '@pyric/cli'));
  symlinkSync(liveDir, join(nm, '@pyric/live'));
  symlinkSync(realFirebaseDir, join(nm, 'firebase'));
  symlinkSync(realAdminDir, join(nm, 'firebase-admin'));
  symlinkSync(gcpFirestoreDir, join(nm, '@google-cloud/firestore'));
  symlinkSync(gcpStorageDir, join(nm, '@google-cloud/storage'));
  symlinkSync(fbDatabaseCompatDir, join(nm, '@firebase/database-compat'));
  symlinkSync(fbUtilDir, join(nm, '@firebase/util'));

  writeFileSync(
    join(nm, 'require-in-the-middle/package.json'),
    JSON.stringify({ name: 'require-in-the-middle', version: '0.0.0-standin', main: 'index.js' }),
  );
  writeFileSync(join(nm, 'require-in-the-middle/index.js'), RITM_INDEX_CJS);
  writeFileSync(
    join(nm, 'import-in-the-middle/package.json'),
    JSON.stringify({ name: 'import-in-the-middle', version: '0.0.0-standin', type: 'module' }),
  );
  writeFileSync(join(nm, 'import-in-the-middle/lib/register.js'), IITM_REGISTER_MJS);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'live-ritm-fixture', type: 'module' }));
  writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT } }));

  writeFileSync(
    join(projectDir, 'ritm-stacked.mjs'),
    `import Hook from 'require-in-the-middle';
const hooked = [];
globalThis[Symbol.for('test.ritm.hooked')] = hooked;
new Hook((exports, name) => {
  hooked.push(name);
  return exports;
});
new Hook((exports, name) => {
  if (name === '@google-cloud/firestore' && typeof exports === 'function') {
    const Wrapped = function (...args) { return new exports(...args); };
    Object.assign(Wrapped, exports);
    Wrapped.prototype = exports.prototype;
    return Wrapped;
  }
  return exports;
});
`,
  );

  writeFileSync(
    join(projectDir, 'iitm-setup.mjs'),
    `import Module from 'node:module';
Module.register('import-in-the-middle/lib/register.js', import.meta.url);
`,
  );
});

afterAll(() => {
  wsServer?.close();
  rtdbWs?.close();
  stubBackend?.close();
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

async function runNode(imports: readonly string[], scriptName: string, source: string) {
  observedCalls = [];
  const scriptPath = join(projectDir, scriptName);
  writeFileSync(scriptPath, source);
  const child = spawn('node', [...imports.flatMap((entry) => ['--import', entry]), scriptPath], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH,
      HOME: projectDir,
      PYRIC_SANDBOX: `remote:${bridgeHttpUrl}`,
      PYRIC_SANDBOX_INSTANCE: INSTANCE_ID,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${stubBackendPort}`,
      FIRESTORE_PREFER_REST: 'true',
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${stubBackendPort}`,
      FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${stubBackendPort}`,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`child timed out (${scriptName}):\nstdout=${stdout}\nstderr=${stderr}`));
    }, 30_000);
    child.on('error', (err) => (clearTimeout(timer), rejectExit(err)));
    child.on('close', (code) => (clearTimeout(timer), resolveExit(code)));
  });
  return { status, stdout, stderr, observed: [...observedCalls] };
}

describe('supplied-entry with require-in-the-middle and import-in-the-middle', () => {
  it('supports import-in-the-middle ?iitm=true client SDK shims on every Node major while stopping direct and forged SDK loads', async () => {
    const iitmUrl = pathToFileURL(join(projectDir, 'iitm-setup.mjs')).href;
    const ritmUrl = pathToFileURL(join(projectDir, 'ritm-stacked.mjs')).href;

    const cleanClient = await runNode(
      [iitmUrl, ritmUrl, '@pyric/live/register'],
      'iitm-client-clean.mjs',
      `import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
console.log('CLIENT_OK', typeof initializeApp, typeof getFirestore);
process.exit(0);
`,
    );
    expect(cleanClient.status, cleanClient.stderr).toBe(0);
    expect(cleanClient.stderr).not.toContain('PYRIC_REAL_SDK_STOPPED');

    const stopClient = await runNode(
      [iitmUrl, ritmUrl, '@pyric/live/register'],
      'iitm-client-stop.mjs',
      `import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const appFile = fileURLToPath(import.meta.url);
const appRequire = createRequire(import.meta.url);
const iitmReg = appRequire.resolve('import-in-the-middle/lib/register.js');
const forgedIitmReq = createRequire(iitmReg);

async function catchCode(fn) {
  try { await fn(); return 'ALLOWED'; } catch (e) { return e?.code ?? String(e); }
}

// Exercises both require.resolve('firebase/firestore') (which bypasses
// registerHooks.resolve on Node 22.15) and direct Module._resolveFilename
// so live-row specifiers never false-stop, while direct @firebase/util
// resolution reports to stderr and throws PYRIC_REAL_SDK_STOPPED.
const resolvedRow = appRequire.resolve('firebase/firestore');
const directRow = Module._resolveFilename('firebase/firestore', { id: appFile, filename: appFile, paths: Module._nodeModulePaths(appFile) }, false);

const out = {
  rowResolved: typeof resolvedRow === 'string' && resolvedRow.length > 0,
  directRowResolved: typeof directRow === 'string' && directRow.length > 0,
  directResolveFbUtil: await catchCode(() => Module._resolveFilename('@firebase/util', { id: appFile, filename: appFile, paths: Module._nodeModulePaths(appFile) }, false)),
  esmFirestoreServer: await catchCode(() => import('@google-cloud/firestore')),
  forgedIitmServer: await catchCode(() => forgedIitmReq('@google-cloud/firestore')),
};
console.log('STOP_OUT ' + JSON.stringify(out));
process.exit(0);
`,
    );
    expect(stopClient.status, stopClient.stderr).toBe(0);
    const line = stopClient.stdout.split('\n').find((l) => l.startsWith('STOP_OUT '))!;
    expect(JSON.parse(line.slice('STOP_OUT '.length))).toEqual({
      rowResolved: true,
      directRowResolved: true,
      directResolveFbUtil: 'PYRIC_REAL_SDK_STOPPED',
      esmFirestoreServer: 'PYRIC_REAL_SDK_STOPPED',
      forgedIitmServer: 'PYRIC_REAL_SDK_STOPPED',
    });
    expect(stopClient.stderr).toContain('@pyric/live/register: stopped loading @google-cloud/firestore');
    expect(stopClient.stderr).toContain('@pyric/live/register: stopped loading the real @firebase/util');
  }, 60_000);

  it.skipIf(!adminRowsOn)(
    'loads firebase-admin cleanly with zero PYRIC_REAL_SDK_STOPPED stderr and observes Admin calls under stacked require-in-the-middle hooks (both --import orders)',
    async () => {
      const adminScript = `import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const app = initializeApp({
  projectId: '${PROJECT}',
  databaseURL: 'http://127.0.0.1:${stubBackendPort}?ns=${PROJECT}-default-rtdb',
  storageBucket: '${PROJECT}.appspot.com',
});

const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);
const bucket = getStorage(app).bucket();

await auth.getUser('user-1').catch(() => {});
await db.doc('items/a').get().catch(() => {});
await db.collection('items').count().get().catch(() => {});
await db.terminate().catch(() => {});
await bucket.file('items/a.txt').getMetadata().catch(() => {});
await rtdb.ref('items/a').set({ n: 1 }).catch(() => {});
await rtdb.goOffline();
await new Promise((r) => setTimeout(r, 200));

const hooked = globalThis[Symbol.for('test.ritm.hooked')] ?? [];
console.log('RESULT ' + JSON.stringify({ hooked }));
process.exit(0);
`;

      const ritmUrl = pathToFileURL(join(projectDir, 'ritm-stacked.mjs')).href;
      for (const order of [
        [ritmUrl, '@pyric/live/register'],
        ['@pyric/live/register', ritmUrl],
      ]) {
        const res = await runNode(order, 'admin-clean.mjs', adminScript);
        expect(res.status, res.stderr).toBe(0);
        expect(res.stderr).not.toContain('PYRIC_REAL_SDK_STOPPED');
        expect(res.stderr).not.toContain('stopped loading');

        const line = res.stdout.split('\n').find((l) => l.startsWith('RESULT '))!;
        const { hooked } = JSON.parse(line.slice('RESULT '.length)) as { hooked: string[] };
        expect(hooked).toContain('@google-cloud/firestore');
        expect(hooked).toContain('@google-cloud/storage');
        expect(hooked).toContain('@firebase/util');

        const methods = res.observed.map((c) => `${c.service}:${c.method}`);
        expect(methods).toContain('auth:Auth.getUser');
        expect(methods).toContain('firestore:DocumentReference.get');
        expect(methods).toContain('firestore:AggregateQuery.get');
        expect(methods).toContain('rtdb:Reference.set');
        expect(methods).toContain('storage:File.getMetadata');
      }
    },
    60_000,
  );

  it.skipIf(!adminRowsOn)(
    'stops direct, createRequire(adminTree/ritm/adminRow), and vm+paths-getter forged loads with PYRIC_REAL_SDK_STOPPED after firebase-admin has loaded',
    async () => {
      const firestoreRowUrl = ADMIN_ROW_URLS.get('firestore')!;
      const gcpFirestoreEntry = requireFromAdmin.resolve('@google-cloud/firestore');
      const securityScript = `import { createRequire } from 'node:module';
import vm from 'node:vm';
import Hook from 'require-in-the-middle';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabase } from 'firebase-admin/database';

const app = initializeApp({
  projectId: '${PROJECT}',
  databaseURL: 'http://127.0.0.1:${stubBackendPort}?ns=${PROJECT}-default-rtdb',
  storageBucket: '${PROJECT}.appspot.com',
});
getFirestore(app);
getStorage(app).bucket();
await getDatabase(app).goOffline();

const appRequire = createRequire(import.meta.url);
const ritmEntry = appRequire.resolve('require-in-the-middle');
const adminFirestoreEntry = appRequire.resolve('firebase-admin/firestore');
const forgedRitmRequire = createRequire(ritmEntry);
const forgedAdminRequire = createRequire(adminFirestoreEntry);
const forgedRowRequire = createRequire(${JSON.stringify(firestoreRowUrl)});

function catchCode(fn) {
  try { fn(); return 'ALLOWED'; } catch (err) { return err?.code ?? ('ERR:' + String(err?.message ?? err)); }
}
async function catchAsyncCode(fn) {
  try { await fn(); return 'ALLOWED'; } catch (err) { return err?.code ?? ('ERR:' + String(err?.message ?? err)); }
}

// Repro for forged V8 stack frames + nested paths-getter require() inside require.resolve:
let getterInnerLoad = 'NOT_RUN';
const forgedRitmFrame = vm.runInThisContext(
  '(function(ritmReq, spec, runInner, dir) { return ritmReq.resolve(spec, { get paths() { runInner(); return [dir]; } }); })',
  { filename: ritmEntry },
);
const forgedAdminFrame = vm.runInThisContext(
  '(function(invoke) { return invoke(); })',
  { filename: adminFirestoreEntry },
);
const getterOuterResolve = catchCode(() =>
  forgedAdminFrame(() =>
    forgedRitmFrame(
      forgedRitmRequire,
      '@google-cloud/firestore',
      () => { getterInnerLoad = catchCode(() => forgedRitmRequire('@google-cloud/firestore')); },
      ${JSON.stringify(gcpFirestoreDir)},
    ),
  ),
);

let hookForgeryCode = 'NOT_RUN';
const evilHook = new Hook({ internals: true }, (exports, name) => {
  if (name === 'firebase-admin' && hookForgeryCode === 'NOT_RUN') {
    hookForgeryCode = catchCode(() => forgedRitmRequire.resolve('@google-cloud/firestore', { paths: [${JSON.stringify(gcpFirestoreDir)}] }));
  }
  return exports;
});
appRequire('firebase-admin/app-check');
evilHook.unhook();

const outcomes = {
  cjsFirestore: catchCode(() => appRequire('@google-cloud/firestore')),
  cjsStorage: catchCode(() => appRequire('@google-cloud/storage')),
  cjsFbUtil: catchCode(() => appRequire('@firebase/util')),
  cjsFbDbCompat: catchCode(() => appRequire('@firebase/database-compat')),
  esmFirestore: await catchAsyncCode(() => import('@google-cloud/firestore')),
  esmStorage: await catchAsyncCode(() => import('@google-cloud/storage')),
  esmFbUtil: await catchAsyncCode(() => import('@firebase/util')),
  forgedRitmLoad: catchCode(() => forgedRitmRequire('@google-cloud/firestore')),
  forgedRitmResolvePaths: catchCode(() => forgedRitmRequire.resolve('@google-cloud/firestore', { paths: [${JSON.stringify(gcpFirestoreDir)}] })),
  forgedAdminLoad: catchCode(() => forgedAdminRequire('@google-cloud/firestore')),
  forgedAdminResolvePaths: catchCode(() => forgedAdminRequire.resolve('@google-cloud/firestore', { paths: [${JSON.stringify(realAdminDir)}] })),
  forgedRowRealPath: catchCode(() => forgedRowRequire(${JSON.stringify(gcpFirestoreEntry)})),
  forgedRowResolvePaths: catchCode(() => forgedRowRequire.resolve('@google-cloud/firestore', { paths: [${JSON.stringify(gcpFirestoreDir)}] })),
  getterInnerLoad,
  getterOuterResolve,
  onrequireForgery: hookForgeryCode,
};

console.log('SECURITY ' + JSON.stringify(outcomes));
process.exit(0);
`;

      const ritmUrl = pathToFileURL(join(projectDir, 'ritm-stacked.mjs')).href;
      const res = await runNode([ritmUrl, '@pyric/live/register'], 'security-probe.mjs', securityScript);
      expect(res.status, res.stderr).toBe(0);

      const line = res.stdout.split('\n').find((l) => l.startsWith('SECURITY '))!;
      const outcomes = JSON.parse(line.slice('SECURITY '.length)) as Record<string, string>;
      for (const [key, value] of Object.entries(outcomes)) {
        expect([key, value]).toEqual([key, 'PYRIC_REAL_SDK_STOPPED']);
      }
      expect(res.stderr).toContain('@pyric/live/register: stopped loading @google-cloud/firestore');
      expect(res.stderr).toContain('@pyric/live/register: stopped loading @google-cloud/storage');
      expect(res.stderr).toContain('@pyric/live/register: stopped loading the real @firebase/util');
    },
    60_000,
  );
});
