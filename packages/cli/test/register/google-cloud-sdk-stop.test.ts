/**
 * Offline unit and subprocess tests for sandbox Swap-or-Stop on
 * `@google-cloud/firestore` and `@google-cloud/storage` (#1609):
 *   1. `stopFor` and `isFirebaseSdkName` stop direct, subpath, aliased,
 *      vendored, and forged-importer loads of `@google-cloud/firestore` and
 *      `@google-cloud/storage` in both sandbox and production AI modes, while
 *      leaving unrelated `@google-cloud/*` packages and live-mode Admin trees
 *      unaffected.
 *   2. Under `node --import @pyric/cli/register`, ESM `import`, CJS `require`,
 *      npm aliases, absolute paths, and Worker threads fail with
 *      `PYRIC_REAL_SDK_STOPPED` before any file loads and before any socket or
 *      DNS lookup runs, even when `GOOGLE_APPLICATION_CREDENTIALS` is set.
 *   3. Under standalone Vite SSR (`acquireViteProcessStop` and `vite`
 *      `createServer` + `pyric()` + `ssrLoadModule`), `@google-cloud/firestore`
 *      and `@google-cloud/storage` fail with `PYRIC_REAL_SDK_STOPPED` before
 *      any socket or DNS call runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  REAL_SDK_STOPPED_CODE,
  isFirebaseSdkName,
  isStoppedServerSdkSpecifier,
  stopFor,
  stoppedServerSdkSpecifierStop,
  suppliedRowsStopFor,
  type ResolvedLoad,
} from '../../src/register/swap-or-stop.js';
import { viteProcessStopHook, type SyncResolve } from '../../src/serve/vite-process-stop.js';
import { resolveNodeExecutable } from '../serve/require-node-on-path.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const registerDist = join(cliRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;
const viteStopDist = join(cliRoot, 'dist/serve/vite-process-stop.js');
const viteStopUrl = pathToFileURL(viteStopDist).href;
const realAdminDir = realpathSync(join(repoRoot, 'node_modules/firebase-admin'));
const realFirebaseDir = realpathSync(join(repoRoot, 'node_modules/firebase'));
const requireFromAdmin = createRequire(join(realAdminDir, 'package.json'));

function packageDir(fromFile: string, name: string): string {
  let dir = dirname(fromFile);
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === name) {
        return dir;
      }
    }
    dir = dirname(dir);
  }
  throw new Error(`Could not locate package root for ${name} above ${fromFile}`);
}

const gcpFirestoreEntry = requireFromAdmin.resolve('@google-cloud/firestore');
const gcpStorageEntry = requireFromAdmin.resolve('@google-cloud/storage');
const gcpFirestoreDir = packageDir(gcpFirestoreEntry, '@google-cloud/firestore');
const gcpStorageDir = packageDir(gcpStorageEntry, '@google-cloud/storage');

const NETWORK_AND_DNS_TRAP = `'use strict';
const dns = require('node:dns');
const net = require('node:net');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const escapedSockets = [];
const dnsLookups = [];
globalThis[Symbol.for('gcp.stop.sockets')] = escapedSockets;
globalThis[Symbol.for('gcp.stop.dns')] = dnsLookups;

const origLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (!LOOPBACK.has(String(hostname))) {
    dnsLookups.push(String(hostname));
    const cb = rest[rest.length - 1];
    if (typeof cb === 'function') {
      cb(new Error('offline-dns-trap:' + hostname));
      return;
    }
    throw new Error('offline-dns-trap:' + hostname);
  }
  return origLookup.call(this, hostname, ...rest);
};

const origResolve = dns.resolve;
dns.resolve = function (hostname, ...rest) {
  dnsLookups.push(String(hostname));
  const cb = rest[rest.length - 1];
  if (typeof cb === 'function') {
    cb(new Error('offline-dns-trap:' + hostname));
    return;
  }
  throw new Error('offline-dns-trap:' + hostname);
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const list = Array.isArray(args[0]) ? args[0] : args;
  const first = list[0];
  const isIpc = typeof first === 'object' && first !== null && first.path !== undefined && first.port === undefined;
  if (typeof first === 'object' && first !== null && !isIpc) {
    const host = first.host ?? 'localhost';
    if (!LOOPBACK.has(host)) {
      escapedSockets.push(String(host));
      throw new Error('offline-socket-trap:' + host);
    }
  } else if (typeof first === 'number' || /^\\d+$/.test(String(first))) {
    const host = typeof list[1] === 'string' ? list[1] : 'localhost';
    if (!LOOPBACK.has(host)) {
      escapedSockets.push(String(host));
      throw new Error('offline-socket-trap:' + host);
    }
  }
  return origConnect.apply(this, args);
};
`;

const LOAD_OBSERVER = `import Module from 'node:module';
const loadedUrls = [];
globalThis[Symbol.for('gcp.stop.loaded')] = loadedUrls;
Module.registerHooks({
  load(url, context, nextLoad) {
    loadedUrls.push(url);
    return nextLoad(url, context);
  },
});
`;

interface SubprocessOutcome {
  readonly results: Record<string, string>;
  readonly loadedGcpFiles: string[];
  readonly escapedSockets: string[];
  readonly dnsLookups: string[];
}

describe('sandbox stopFor: @google-cloud/firestore and @google-cloud/storage (#1609)', () => {
  const appImporter = 'file:///work/app/src/server.js';
  const adminAppFile = 'file:///work/app/node_modules/firebase-admin/lib/app/index.js';
  const firestoreFile = 'file:///work/app/node_modules/@google-cloud/firestore/build/src/index.js';
  const storageFile = 'file:///work/app/node_modules/@google-cloud/storage/build/cjs/src/index.js';
  const aliasFirestoreFile = 'file:///work/app/node_modules/gcp-fs/build/src/index.js';
  const vendoredStorageFile = 'file:///work/app/vendor/gcp-storage/build/cjs/src/index.js';
  const pubsubFile = 'file:///work/app/node_modules/@google-cloud/pubsub/build/src/index.js';

  const packageMap: ReadonlyArray<readonly [string, string]> = [
    ['/node_modules/firebase-admin/', 'firebase-admin'],
    ['/node_modules/@google-cloud/firestore/', '@google-cloud/firestore'],
    ['/node_modules/gcp-fs/', '@google-cloud/firestore'],
    ['/node_modules/@google-cloud/storage/', '@google-cloud/storage'],
    ['/vendor/gcp-storage/', '@google-cloud/storage'],
    ['/node_modules/@google-cloud/pubsub/', '@google-cloud/pubsub'],
  ];

  const nameOf = (url: string): string | null => {
    for (const [segment, name] of packageMap) {
      if (url.includes(segment)) {
        return name;
      }
    }
    return null;
  };

  function makeLoad(overrides: Partial<ResolvedLoad> & Pick<ResolvedLoad, 'url'>): ResolvedLoad {
    return {
      specifier: '@google-cloud/firestore',
      importer: appImporter,
      aiMode: 'sandbox',
      nameOf,
      ...overrides,
    };
  }

  it('recognizes @google-cloud/firestore and @google-cloud/storage in isFirebaseSdkName and specifier predicates', () => {
    expect(isFirebaseSdkName('@google-cloud/firestore')).toBe(true);
    expect(isFirebaseSdkName('@google-cloud/storage')).toBe(true);
    expect(isFirebaseSdkName('@google-cloud/pubsub')).toBe(false);

    expect(isStoppedServerSdkSpecifier('@google-cloud/firestore')).toBe(true);
    expect(isStoppedServerSdkSpecifier('@google-cloud/firestore/types')).toBe(true);
    expect(isStoppedServerSdkSpecifier('@google-cloud/storage')).toBe(true);
    expect(isStoppedServerSdkSpecifier('@google-cloud/storage/build/cjs/src/index.js')).toBe(true);
    expect(isStoppedServerSdkSpecifier('@google-cloud/pubsub')).toBe(false);
  });

  it('stops @google-cloud/firestore and @google-cloud/storage in both sandbox and production AI modes', () => {
    for (const aiMode of ['sandbox', 'production'] as const) {
      const fsStop = stopFor(
        makeLoad({ specifier: '@google-cloud/firestore', url: firestoreFile, aiMode }),
        new Set(),
      );
      expect(fsStop).not.toBeNull();
      expect((fsStop as Error & { code?: string }).code).toBe(REAL_SDK_STOPPED_CODE);
      expect(fsStop?.message).toContain('stopped loading the real @google-cloud/firestore');
      expect(fsStop?.message).toContain("'firebase-admin/firestore'");

      const stStop = stopFor(
        makeLoad({ specifier: '@google-cloud/storage', url: storageFile, aiMode }),
        new Set(),
      );
      expect(stStop).not.toBeNull();
      expect((stStop as Error & { code?: string }).code).toBe(REAL_SDK_STOPPED_CODE);
      expect(stStop?.message).toContain('stopped loading the real @google-cloud/storage');
      expect(stStop?.message).toContain("'firebase-admin/storage'");
    }
  });

  it('stops aliased, vendored, and forged-importer loads while leaving unrelated @google-cloud packages alone', () => {
    const aliasStop = stopFor(makeLoad({ specifier: 'gcp-fs', url: aliasFirestoreFile }), new Set());
    expect((aliasStop as (Error & { code?: string }) | null)?.code).toBe(REAL_SDK_STOPPED_CODE);

    const vendoredStop = stopFor(
      makeLoad({ specifier: './vendor/gcp-storage/build/cjs/src/index.js', url: vendoredStorageFile }),
      new Set(),
    );
    expect((vendoredStop as (Error & { code?: string }) | null)?.code).toBe(REAL_SDK_STOPPED_CODE);

    // Even from an allowed firebase-admin/app file in production AI mode,
    // @google-cloud/firestore and @google-cloud/storage remain stopped.
    const forgedFromAdmin = stopFor(
      makeLoad({
        specifier: '@google-cloud/firestore',
        url: firestoreFile,
        importer: adminAppFile,
        aiMode: 'production',
      }),
      new Set([adminAppFile]),
    );
    expect((forgedFromAdmin as (Error & { code?: string }) | null)?.code).toBe(REAL_SDK_STOPPED_CODE);

    expect(stopFor(makeLoad({ specifier: '@google-cloud/pubsub', url: pubsubFile }), new Set())).toBeNull();

    // Live mode's passed-through Admin tree still permits both packages.
    expect(
      suppliedRowsStopFor(
        makeLoad({ specifier: '@google-cloud/firestore', url: firestoreFile, importer: adminAppFile }),
        new Set(),
        { isRowImport: false, isEsmImport: false, isFromAdminTree: true },
      ),
    ).toBeNull();
  });

  it('stops missing or unexported @google-cloud/{firestore,storage} subpaths in viteProcessStopHook', () => {
    const lines: string[] = [];
    const hook = viteProcessStopHook({ getAiMode: () => 'sandbox', write: (line) => lines.push(line) });
    const missingNext: Parameters<SyncResolve>[2] = () => {
      throw Object.assign(new Error('Package subpath not exported'), {
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      });
    };

    for (const specifier of ['@google-cloud/firestore/nonexistent', '@google-cloud/storage/nonexistent']) {
      let caught: (Error & { code?: string }) | null = null;
      try {
        hook(specifier, { parentURL: appImporter }, missingNext);
      } catch (err: unknown) {
        if (err instanceof Error) {
          caught = err as Error & { code?: string };
        } else {
          throw err;
        }
      }
      expect(caught).not.toBeNull();
      expect(caught?.code).toBe(REAL_SDK_STOPPED_CODE);
    }

    const directMissing = stoppedServerSdkSpecifierStop('@google-cloud/firestore', appImporter);
    expect((directMissing as Error & { code?: string }).code).toBe(REAL_SDK_STOPPED_CODE);
    expect(directMissing.message).toContain('stopped loading the real @google-cloud/firestore');
    expect(lines).toHaveLength(2);
  });
});

describe('offline subprocess Swap-or-Stop for @google-cloud/firestore and @google-cloud/storage (#1609)', () => {
  let fixtureDir = '';

  beforeAll(() => {
    if (!existsSync(registerDist) || !existsSync(viteStopDist)) {
      throw new Error('Build @pyric/cli first so dist/register/index.js and dist/serve/vite-process-stop.js exist.');
    }
    fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-gcp-sdk-stop-')));
    const nm = join(fixtureDir, 'node_modules');
    mkdirSync(join(nm, '@google-cloud'), { recursive: true });
    symlinkSync(gcpFirestoreDir, join(nm, '@google-cloud/firestore'));
    symlinkSync(gcpStorageDir, join(nm, '@google-cloud/storage'));
    symlinkSync(gcpFirestoreDir, join(nm, 'gcp-fs-alias'));
    symlinkSync(gcpStorageDir, join(nm, 'gcp-storage-alias'));
    symlinkSync(realFirebaseDir, join(nm, 'firebase'));
    symlinkSync(realAdminDir, join(nm, 'firebase-admin'));

    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'gcp-stop-fixture', type: 'module' }));
    writeFileSync(
      join(fixtureDir, 'fake-sa.json'),
      JSON.stringify({
        type: 'service_account',
        project_id: 'demo-gcp-stop',
        private_key_id: 'synthetic-key-id',
        private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----\n',
        client_email: 'synthetic@demo-gcp-stop.iam.gserviceaccount.com',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    writeFileSync(join(fixtureDir, 'trap.cjs'), NETWORK_AND_DNS_TRAP);
    writeFileSync(join(fixtureDir, 'observer.mjs'), LOAD_OBSERVER);
  });

  afterAll(() => {
    if (fixtureDir.length > 0) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  function runOfflineNode(
    args: string[],
    envOverrides: Record<string, string> = {},
  ): { status: number | null; stderr: string; outcome: SubprocessOutcome } {
    const nodeBin = resolveNodeExecutable();
    const res = spawnSync(nodeBin, args, {
      cwd: fixtureDir,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: fixtureDir,
        CLOUDSDK_CONFIG: join(fixtureDir, 'empty-gcloud'),
        GOOGLE_APPLICATION_CREDENTIALS: join(fixtureDir, 'fake-sa.json'),
        PYRIC_SANDBOX: 'local',
        ...envOverrides,
      },
    });
    const line = res.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME '));
    if (line === undefined) {
      throw new Error(`Probe produced no OUTCOME (status=${res.status}):\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
    }
    const outcome = JSON.parse(line.slice('OUTCOME '.length)) as SubprocessOutcome;
    return { status: res.status, stderr: res.stderr, outcome };
  }

  it('stops ESM, CJS, aliases, absolute paths, and Worker threads under @pyric/cli/register before any socket or DNS call', () => {
    const probePath = join(fixtureDir, 'register-probe.mjs');
    const probeScript = [
      "import { createRequire } from 'node:module';",
      "import { Worker } from 'node:worker_threads';",
      `const firestoreAbs = ${JSON.stringify(pathToFileURL(gcpFirestoreEntry).href)};`,
      `const storageAbs = ${JSON.stringify(pathToFileURL(gcpStorageEntry).href)};`,
      'const req = createRequire(import.meta.url);',
      'const results = {};',
      'const esmSpecs = [',
      "  '@google-cloud/firestore',",
      "  '@google-cloud/firestore/pipelines',",
      "  '@google-cloud/firestore/build/src/path',",
      "  '@google-cloud/storage',",
      "  'gcp-fs-alias',",
      "  'gcp-storage-alias',",
      '  firestoreAbs,',
      '  storageAbs,',
      '];',
      'for (const spec of esmSpecs) {',
      '  try { await import(spec); results["esm:" + spec] = "loaded"; }',
      '  catch (err) { results["esm:" + spec] = err?.code ?? String(err); }',
      '}',
      "for (const spec of ['@google-cloud/firestore', '@google-cloud/firestore/pipelines', '@google-cloud/storage', 'gcp-fs-alias', 'gcp-storage-alias']) {",
      '  try { req(spec); results["cjs:" + spec] = "loaded"; }',
      '  catch (err) { results["cjs:" + spec] = err?.code ?? String(err); }',
      '}',
      'results.worker = await new Promise((resolveWorker) => {',
      '  const w = new Worker(',
      '    "const { parentPort } = require(\'node:worker_threads\'); try { require(\'@google-cloud/firestore\'); parentPort.postMessage(\'loaded\'); } catch (e) { parentPort.postMessage(e && e.code || String(e)); }",',
      '    { eval: true },',
      '  );',
      '  w.once("message", resolveWorker);',
      '  w.once("error", (e) => resolveWorker("error:" + String(e)));',
      '});',
      "const loaded = globalThis[Symbol.for('gcp.stop.loaded')] ?? [];",
      'const loadedGcpFiles = loaded.filter((u) => u.includes("@google-cloud/firestore") || u.includes("@google-cloud/storage"));',
      'console.log("OUTCOME " + JSON.stringify({',
      '  results,',
      '  loadedGcpFiles,',
      "  escapedSockets: globalThis[Symbol.for('gcp.stop.sockets')] ?? [],",
      "  dnsLookups: globalThis[Symbol.for('gcp.stop.dns')] ?? [],",
      '}));',
    ].join('\n');
    writeFileSync(probePath, probeScript, 'utf8');

    const run = runOfflineNode([
      '--require',
      join(fixtureDir, 'trap.cjs'),
      '--import',
      pathToFileURL(join(fixtureDir, 'observer.mjs')).href,
      '--import',
      registerUrl,
      probePath,
    ]);

    expect(run.status, run.stderr).toBe(0);
    expect(run.outcome.loadedGcpFiles).toEqual([]);
    expect(run.outcome.escapedSockets).toEqual([]);
    expect(run.outcome.dnsLookups).toEqual([]);
    for (const [key, value] of Object.entries(run.outcome.results)) {
      expect(value, `${key}\n${run.stderr}`).toBe(REAL_SDK_STOPPED_CODE);
    }
    expect(run.stderr).toContain('@pyric/cli/register: stopped loading the real @google-cloud/firestore');
    expect(run.stderr).toContain('@pyric/cli/register: stopped loading the real @google-cloud/storage');
  }, 30_000);

  it('keeps production AI mode working while still stopping @google-cloud/firestore and @google-cloud/storage', () => {
    const probePath = join(fixtureDir, 'prod-ai-probe.mjs');
    const probeScript = [
      'const results = {};',
      "try { await import('firebase/ai'); results.ai = 'loaded'; } catch (e) { results.ai = e?.code ?? String(e); }",
      "try { await import('@google-cloud/firestore'); results.firestore = 'loaded'; } catch (e) { results.firestore = e?.code ?? String(e); }",
      "try { await import('@google-cloud/storage'); results.storage = 'loaded'; } catch (e) { results.storage = e?.code ?? String(e); }",
      "const loaded = globalThis[Symbol.for('gcp.stop.loaded')] ?? [];",
      'const loadedGcpFiles = loaded.filter((u) => u.includes("@google-cloud/firestore") || u.includes("@google-cloud/storage"));',
      'console.log("OUTCOME " + JSON.stringify({',
      '  results,',
      '  loadedGcpFiles,',
      "  escapedSockets: globalThis[Symbol.for('gcp.stop.sockets')] ?? [],",
      "  dnsLookups: globalThis[Symbol.for('gcp.stop.dns')] ?? [],",
      '}));',
    ].join('\n');
    writeFileSync(probePath, probeScript, 'utf8');

    const run = runOfflineNode(
      [
        '--require',
        join(fixtureDir, 'trap.cjs'),
        '--import',
        pathToFileURL(join(fixtureDir, 'observer.mjs')).href,
        '--import',
        registerUrl,
        probePath,
      ],
      { PYRIC_AI_MODE: 'production' },
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.outcome.results).toEqual({
      ai: 'loaded',
      firestore: REAL_SDK_STOPPED_CODE,
      storage: REAL_SDK_STOPPED_CODE,
    });
    expect(run.outcome.loadedGcpFiles).toEqual([]);
    expect(run.outcome.escapedSockets).toEqual([]);
    expect(run.outcome.dnsLookups).toEqual([]);
  }, 30_000);

  it('stops @google-cloud/firestore and @google-cloud/storage under standalone Vite SSR process-stop and Vite swap before any socket or DNS call', () => {
    const viteSwapUrl = pathToFileURL(join(cliRoot, 'dist/serve/vite-module-swap.js')).href;
    const probePath = join(fixtureDir, 'vite-ssr-probe.mjs');
    const probeScript = [
      "import { createRequire } from 'node:module';",
      "import path from 'node:path';",
      `const { acquireViteProcessStop } = await import(${JSON.stringify(viteStopUrl)});`,
      `const { createViteModuleContext, createViteModuleSwap } = await import(${JSON.stringify(viteSwapUrl)});`,
      'const release = acquireViteProcessStop({ write: (line) => process.stderr.write(line) });',
      'const req = createRequire(import.meta.url);',
      'const results = {};',
      'try {',
      '  const swap = createViteModuleSwap(createViteModuleContext());',
      '  swap.config({ devServer: true, userConfig: { root: process.cwd() } });',
      '  swap.configResolved({ root: process.cwd() });',
      '  const importer = path.join(process.cwd(), "src", "main.ts");',
      '  const client = { environment: { name: "client", config: { consumer: "client" } }, resolve: async () => null };',
      "  for (const spec of ['@google-cloud/firestore', '@google-cloud/storage']) {",
      '    const resolved = await swap.resolvePluginId(client, spec, importer);',
      '    const id = typeof resolved === "string" ? resolved : resolved?.id ?? null;',
      '    const src = id === null ? null : await swap.loadPluginModule(id);',
      '    results["vite-client:" + spec] = id !== null && id.startsWith("\\0pyric-stop:") && (src ?? "").includes("PYRIC_REAL_SDK_STOPPED") ? "PYRIC_REAL_SDK_STOPPED" : String(id);',
      '  }',
      "  const ssrSpecs = ['@google-cloud/firestore', '@google-cloud/firestore/pipelines', '@google-cloud/storage', '@google-cloud/storage/nonexistent', 'gcp-fs-alias', 'gcp-storage-alias'];",
      '  for (const spec of ssrSpecs) {',
      '    try { await import(spec); results["esm:" + spec] = "loaded"; }',
      '    catch (err) { results["esm:" + spec] = err?.code ?? String(err); }',
      '    try { req(spec); results["cjs:" + spec] = "loaded"; }',
      '    catch (err) { results["cjs:" + spec] = err?.code ?? String(err); }',
      '  }',
      '} finally {',
      '  release();',
      '}',
      "const loaded = globalThis[Symbol.for('gcp.stop.loaded')] ?? [];",
      'const loadedGcpFiles = loaded.filter((u) => u.includes("@google-cloud/firestore") || u.includes("@google-cloud/storage"));',
      'console.log("OUTCOME " + JSON.stringify({',
      '  results,',
      '  loadedGcpFiles,',
      "  escapedSockets: globalThis[Symbol.for('gcp.stop.sockets')] ?? [],",
      "  dnsLookups: globalThis[Symbol.for('gcp.stop.dns')] ?? [],",
      '}));',
    ].join('\n');
    writeFileSync(probePath, probeScript, 'utf8');

    const run = runOfflineNode(
      [
        '--require',
        join(fixtureDir, 'trap.cjs'),
        '--import',
        pathToFileURL(join(fixtureDir, 'observer.mjs')).href,
        probePath,
      ],
      { PYRIC_SANDBOX: '' },
    );

    expect(run.status, run.stderr).toBe(0);
    expect(run.outcome.loadedGcpFiles).toEqual([]);
    expect(run.outcome.escapedSockets).toEqual([]);
    expect(run.outcome.dnsLookups).toEqual([]);
    for (const [key, value] of Object.entries(run.outcome.results)) {
      expect(value, `${key}\n${run.stderr}`).toBe(REAL_SDK_STOPPED_CODE);
    }
    expect(run.stderr).toContain('@pyric/cli/register: stopped loading the real @google-cloud/firestore');
    expect(run.stderr).toContain('@pyric/cli/register: stopped loading the real @google-cloud/storage');
  }, 30_000);
});
