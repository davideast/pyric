/**
 * Worker-thread Vite dev SSR activation and multi-server port handover (#1144, #1145).
 *
 * Runs real Node child processes with `worker_threads.Worker` against Vite dev
 * servers on `127.0.0.1` so `module.registerHooks`, `BroadcastChannel`,
 * `setEnvironmentData`, HTTPS certificate pinning, and clean process exit are
 * exercised end-to-end.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDirs } from '../use-temp-dirs.js';

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const allocateTempDir = useTempDirs('pyric-vite-ssr-worker-');

function createCert(dir: string): { certPath: string; keyPath: string } {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
  return { certPath, keyPath };
}

function writeAppFixture(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  symlinkSync(join(WORKSPACE_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ssr-worker-test', private: true, type: 'module' }));
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-app' } }));
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({
      database: { rules: 'database.rules.json' },
      firestore: { rules: 'firestore.rules' },
    }),
  );
  writeFileSync(
    join(dir, 'database.rules.json'),
    JSON.stringify({
      rules: {
        items: { $id: { '.read': 'auth != null', '.write': 'auth != null' } },
      },
    }),
  );
  writeFileSync(
    join(dir, 'firestore.rules'),
    [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow read, write: if request.auth != null;',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>\n');
}

const WORKER_ENTRY_SOURCE = [
  "import { parentPort, workerData } from 'node:worker_threads';",
  "import Module from 'node:module';",
  'Module.registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    try { return nextResolve(specifier, context); } catch (err) {',
  "      const code = err && typeof err === 'object' ? err.code : undefined;",
  "      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {",
  '        for (const parentURL of workerData.bases) {',
  '          try { return nextResolve(specifier, { ...context, parentURL }); } catch (inner) { if (!(inner instanceof Error)) throw inner; }',
  '        }',
  '      }',
  '      throw err;',
  '    }',
  '  },',
  '});',
  "const { loadServerTarget } = await import('@pyric/cli/vite/ssr-loader');",
  'const cfg = {',
  "  apiKey: 'demo-key',",
  "  projectId: 'demo-app',",
  "  databaseURL: 'https://demo-app-default-rtdb.firebaseio.com',",
  '};',
  'async function runTag(tag) {',
  '  let client;',
  '  try {',
  "    const fApp = await loadServerTarget('@pyric/cli/register/client/app');",
  "    const fAuth = await loadServerTarget('@pyric/cli/register/client/auth');",
  "    const fDb = await loadServerTarget('@pyric/cli/register/client/database');",
  "    const fFs = await loadServerTarget('@pyric/cli/register/client/firestore');",
  '    const app = fApp.getApps()[0] ?? fApp.initializeApp(cfg);',
  '    const auth = fAuth.getAuth(app);',
  '    if (!auth.currentUser) await fAuth.signInAnonymously(auth);',
  "    await fDb.set(fDb.ref(fDb.getDatabase(app), 'items/' + tag), { from: tag });",
  "    await fFs.setDoc(fFs.doc(fFs.getFirestore(app), 'items', tag), { from: tag });",
  '    client = { ok: true };',
  '  } catch (err) {',
  '    client = { ok: false, code: err?.code ?? null, message: String(err?.message ?? err) };',
  '  }',
  '  let admin;',
  '  try {',
  "    const aApp = await loadServerTarget('pyric-admin/app');",
  "    const aDb = await loadServerTarget('pyric-admin/database');",
  "    const aFs = await loadServerTarget('pyric-admin/firestore');",
  '    const app = aApp.getApps()[0] ?? aApp.initializeApp({ projectId: cfg.projectId, databaseURL: cfg.databaseURL });',
  "    const rtdb = (await aDb.getDatabase(app).ref('items/' + tag).get()).val();",
  "    const fs = (await aFs.getFirestore(app).doc('items/' + tag).get()).data() ?? null;",
  '    admin = { ok: true, rtdb, fs };',
  '  } catch (err) {',
  '    admin = { ok: false, code: err?.code ?? null, message: String(err?.message ?? err) };',
  '  }',
  '  return { client, admin };',
  '}',
  "parentPort.on('message', async (msg) => {",
  "  if (msg.type === 'close') { parentPort.close(); return; }",
  '  const res = await runTag(msg.tag);',
  '  parentPort.postMessage({ id: msg.id, ...res });',
  '});',
  "parentPort.postMessage({ type: 'ready' });",
].join('\n');

const MAIN_DRIVER_SOURCE = [
  "import { createServer as createNetServer } from 'node:net';",
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
  "import { Worker } from 'node:worker_threads';",
  "import Module from 'node:module';",
  'const [wsRoot, appDir, outsideCwd, workerScript, certPath, keyPath] = process.argv.slice(2);',
  'const bases = [',
  "  pathToFileURL(join(wsRoot, 'packages/cli/package.json')).href,",
  "  pathToFileURL(join(wsRoot, 'packages/pyric/package.json')).href,",
  "  pathToFileURL(join(wsRoot, 'packages/pyric-admin/package.json')).href,",
  "  pathToFileURL(join(wsRoot, 'package.json')).href,",
  '];',
  'Module.registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    try { return nextResolve(specifier, context); } catch (err) {',
  "      const code = err && typeof err === 'object' ? err.code : undefined;",
  "      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {",
  '        for (const parentURL of bases) {',
  '          try { return nextResolve(specifier, { ...context, parentURL }); } catch (inner) { if (!(inner instanceof Error)) throw inner; }',
  '        }',
  '      }',
  '      throw err;',
  '    }',
  '  },',
  '});',
  'process.chdir(outsideCwd);',
  "const { createServer } = await import('vite');",
  "const { pyric } = await import('@pyric/cli/vite');",
  'function freePort() {',
  '  return new Promise((resolve, reject) => {',
  '    const srv = createNetServer();',
  "    srv.listen(0, '127.0.0.1', () => {",
  '      const p = srv.address().port;',
  '      srv.close((e) => (e ? reject(e) : resolve(p)));',
  '    });',
  '  });',
  '}',
  'let worker;',
  'let seq = 0;',
  'function spawnWorker() {',
  '  return new Promise((resolve, reject) => {',
  '    const w = new Worker(workerScript, { workerData: { bases } });',
  "    w.once('error', reject);",
  "    w.on('message', function onReady(m) {",
  "      if (m && m.type === 'ready') { w.off('message', onReady); resolve(w); }",
  '    });',
  '  });',
  '}',
  'function callWorker(w, tag) {',
  '  seq += 1;',
  '  const id = seq;',
  '  return new Promise((resolve, reject) => {',
  '    const onMsg = (m) => {',
  "      if (m && m.id === id) { w.off('message', onMsg); resolve({ client: m.client, admin: m.admin }); }",
  '    };',
  "    w.on('message', onMsg);",
  "    w.once('error', reject);",
  '    w.postMessage({ id, tag });',
  '  });',
  '}',
  'const earlySpawnPlugin = {',
  "  name: 'spawn-worker-before-listen',",
  '  async configureServer() {',
  '    worker = await spawnWorker();',
  '  },',
  '};',
  '// 1. SharedWorker server first: worker spawned BEFORE server.listen(), from outsideCwd',
  'const swPort = await freePort();',
  'const swServer = await createServer({',
  "  root: appDir, configFile: false, logLevel: 'silent',",
  "  server: { port: swPort, strictPort: true, host: '127.0.0.1' },",
  '  plugins: [pyric({ hosted: false, ui: false }), earlySpawnPlugin],',
  '});',
  'await swServer.listen();',
  "const swRes = await callWorker(worker, 'sw');",
  'await swServer.close();',
  '// 2. Hosted HTTP server on a new port with sessionToken: true; SAME worker follows it!',
  'const h1Port = await freePort();',
  'const h1Server = await createServer({',
  "  root: appDir, configFile: false, logLevel: 'silent',",
  "  server: { port: h1Port, strictPort: true, host: '127.0.0.1' },",
  '  plugins: [pyric({ hosted: true, sessionToken: true, ui: false })],',
  '});',
  'await h1Server.listen();',
  "const h1Res = await callWorker(worker, 'h1');",
  'await h1Server.close();',
  '// 3. Hosted HTTPS server on a third port with self-signed cert; SAME worker follows it!',
  'const httpsPort = await freePort();',
  'const httpsServer = await createServer({',
  "  root: appDir, configFile: false, logLevel: 'silent',",
  '  server: {',
  '    port: httpsPort,',
  '    strictPort: true,',
  "    host: '127.0.0.1',",
  "    https: { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') },",
  '  },',
  '  plugins: [pyric({ hosted: true, ui: false })],',
  '});',
  'await httpsServer.listen();',
  "const httpsRes = await callWorker(worker, 'https');",
  "worker.postMessage({ type: 'close' });",
  'await httpsServer.close();',
  'console.log(JSON.stringify({ ports: [swPort, h1Port, httpsPort], swRes, h1Res, httpsRes }));',
].join('\n');

interface WorkerPhaseResult {
  client: { ok: boolean; code?: string | null; message?: string };
  admin: { ok: boolean; code?: string | null; message?: string; rtdb?: unknown; fs?: unknown };
}

interface DriverReport {
  ports: [number, number, number];
  swRes: WorkerPhaseResult;
  h1Res: WorkerPhaseResult;
  httpsRes: WorkerPhaseResult;
}

describe('Vite SSR worker-thread activation and port handover (#1144, #1145)', () => {
  it('propagates activation to a worker spawned before listen(), outside project cwd, across SharedWorker, hosted sessionToken, and HTTPS port handovers, then exits cleanly', () => {
    const baseDir = allocateTempDir('pyric-vite-ssr-worker-');
    const appDir = join(baseDir, 'app');
    const outsideCwd = join(baseDir, 'outside-cwd');
    mkdirSync(appDir, { recursive: true });
    mkdirSync(outsideCwd, { recursive: true });
    writeAppFixture(appDir);
    const { certPath, keyPath } = createCert(baseDir);

    const workerScript = join(baseDir, 'ssr-worker.mjs');
    const driverScript = join(baseDir, 'driver.mjs');
    writeFileSync(workerScript, WORKER_ENTRY_SOURCE, 'utf8');
    writeFileSync(driverScript, MAIN_DRIVER_SOURCE, 'utf8');

    const result = spawnSync(
      process.env.PYRIC_TEST_NODE ?? 'node',
      [driverScript, WORKSPACE_ROOT, appDir, outsideCwd, workerScript, certPath, keyPath],
      {
        cwd: outsideCwd,
        env: { ...process.env, NODE_OPTIONS: undefined, PYRIC_SANDBOX: undefined },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );

    expect(result.status, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toBe(0);
    const line = result.stdout.trim().split('\n').at(-1) ?? '{}';
    const report = JSON.parse(line) as DriverReport;

    expect(new Set(report.ports).size).toBe(3);

    expect(report.swRes.client.ok).toBe(false);
    expect(report.swRes.client.code).toBe('failed-precondition');
    expect(report.swRes.client.message).toContain('hosted: true');
    expect(report.swRes.admin.ok).toBe(false);
    expect(report.swRes.admin.code).toBe('failed-precondition');
    expect(report.swRes.admin.message).toContain('hosted: true');

    expect(report.h1Res.client).toEqual({ ok: true });
    expect(report.h1Res.admin).toEqual({
      ok: true,
      rtdb: { from: 'h1' },
      fs: { from: 'h1' },
    });

    expect(report.httpsRes.client).toEqual({ ok: true });
    expect(report.httpsRes.admin).toEqual({
      ok: true,
      rtdb: { from: 'https' },
      fs: { from: 'https' },
    });
  }, 60_000);
});
