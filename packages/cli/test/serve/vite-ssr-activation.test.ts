/** The in-process activation the Vite plugin installs for server-rendered modules (#1123). */
import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ViteDevServer } from 'vite';
import { processActivation } from 'pyric/sandbox/internal';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachViteSsrActivation, httpsCertificateRefusal, httpsUnderBunRefusal, loopbackBase, viteSsrRefusal } from '../../src/serve/vite-ssr-activation.js';
import { useTempDirs } from '../use-temp-dirs.js';

/** A dev server whose HTTP server listens on `address`, or starts listening when told. */
function fakeServer(address: AddressInfo, listening = true): ViteDevServer & { listen(): void } {
  const http = Object.assign(new EventEmitter(), { listening, address: () => address });
  return {
    httpServer: http,
    listen() {
      http.listening = true;
      http.emit('listening');
    },
  } as unknown as ViteDevServer & { listen(): void };
}

/** A dev server configured with `server.https`, as `@vitejs/plugin-basic-ssl` configures one. */
function fakeHttpsServer(address: AddressInfo, https: unknown): ViteDevServer & { listen(): void } {
  return Object.assign(fakeServer(address), { config: { server: { https } } }) as ViteDevServer & { listen(): void };
}

function selfSignedCert(): { cert: string; certPath: string; keyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-ssr-https-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  return { cert: readFileSync(certPath, 'utf8'), certPath, keyPath };
}

const ipv4 = (address: string, port = 5173): AddressInfo => ({ address, family: 'IPv4', port });
const ipv6 = (address: string, port = 5173): AddressInfo => ({ address, family: 'IPv6', port });

let attached: Array<{ close(): void }> = [];

afterEach(() => {
  for (const activation of attached.splice(0).reverse()) activation.close();
});

/** Node checks the certificate pin; these tests run under Bun, which does not, so each says which it stands for. */
const NODE = { honorsCertificatePin: () => true };
const BUN = { honorsCertificatePin: () => false };

function attach(server: ViteDevServer, hosted: boolean, env: Record<string, string | undefined> = {}, runtime = NODE) {
  const activation = attachViteSsrActivation(server, hosted, env, runtime);
  attached.push(activation);
  return activation;
}

describe('loopbackBase', () => {
  it('dials the address the server is bound to, and loopback for a wildcard bind', () => {
    expect(loopbackBase(ipv4('127.0.0.1'))).toBe('http://127.0.0.1:5173');
    expect(loopbackBase(ipv4('0.0.0.0', 4000))).toBe('http://127.0.0.1:4000');
    expect(loopbackBase(ipv6('::'))).toBe('http://127.0.0.1:5173');
    expect(loopbackBase(ipv6('::1'))).toBe('http://[::1]:5173');
  });

  it('dials https for a server that serves TLS', () => {
    expect(loopbackBase(ipv4('0.0.0.0', 4000), true)).toBe('https://127.0.0.1:4000');
    expect(loopbackBase(ipv6('::1'), true)).toBe('https://[::1]:5173');
  });
});

describe('an HTTPS dev server', () => {
  const { cert, certPath, keyPath } = selfSignedCert();

  it('is the host at its https url, and trusts its own certificate for that origin only', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { cert, key: 'unused' }), true);
    const activation = processActivation()!;
    await expect(activation.host()).resolves.toBe('https://127.0.0.1:5443');
    const trust = activation.hostTrust?.('wss://127.0.0.1:5443/__pyric/sandbox');
    expect(trust?.origin).toBe('https://127.0.0.1:5443');
    expect(trust?.ca).toEqual([cert.trim()]);
    expect(activation.hostTrust?.('https://127.0.0.1:5444/')).toBeUndefined();
    expect(activation.hostTrust?.('https://example.com/')).toBeUndefined();
  });

  it('reads a certificate given as a file path, as Vite does', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { cert: certPath, key: keyPath }), true);
    const activation = processActivation()!;
    await expect(activation.host()).resolves.toBe('https://127.0.0.1:5443');
    expect(activation.hostTrust?.('https://127.0.0.1:5443/')?.ca).toEqual([cert.trim()]);
  });

  it('refuses under Bun, naming HTTPS and Bun, and trusts nothing', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { cert, key: 'unused' }), true, {}, BUN);
    const activation = processActivation()!;
    await expect(activation.host()).rejects.toThrow(httpsUnderBunRefusal().message);
    expect(httpsUnderBunRefusal().message).toContain('serves HTTPS under Bun');
    expect(activation.hostTrust?.('https://127.0.0.1:5443/')).toBeUndefined();
  });

  it('refuses, naming HTTPS, when server.https.cert holds no readable PEM certificate', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { pfx: Buffer.from('bundle') }), true);
    const activation = processActivation()!;
    await expect(activation.host()).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(activation.host()).rejects.toThrow(httpsCertificateRefusal().message);
    expect(httpsCertificateRefusal().message).toContain('serves HTTPS');
    expect(activation.hostTrust?.('https://127.0.0.1:5443/')).toBeUndefined();
  });

  it('trusts nothing for a plain HTTP server', async () => {
    attach(fakeServer(ipv4('127.0.0.1', 5173)), true);
    const activation = processActivation()!;
    await expect(activation.host()).resolves.toBe('http://127.0.0.1:5173');
    expect(activation.hostTrust?.('http://127.0.0.1:5173/')).toBeUndefined();
  });
});

describe('attachViteSsrActivation', () => {
  it('names the dev server as the host once it listens', async () => {
    const server = fakeServer(ipv6('::1', 5174), false);
    attach(server, true);
    const activation = processActivation();
    expect(activation?.label).toBe("the Vite dev server's server-rendered modules");
    const host = activation!.host();
    server.listen();
    await expect(host).resolves.toBe('http://[::1]:5174');
  });

  it('answers from the newest server, so a restart replaces the host and closing the old one changes nothing', async () => {
    const first = attach(fakeServer(ipv4('127.0.0.1', 5001)), true);
    attach(fakeServer(ipv4('127.0.0.1', 5002)), true);
    first.close();
    await expect(processActivation()!.host()).resolves.toBe('http://127.0.0.1:5002');
  });

  it('removes the activation when the server in force closes', () => {
    attach(fakeServer(ipv4('127.0.0.1')), true).close();
    expect(processActivation()).toBeUndefined();
  });

  it('gives firebase-admin one handle for the process, kept across dev servers', () => {
    const firstServer = attach(fakeServer(ipv4('127.0.0.1', 5001)), true);
    const first = processActivation()!.adminSandbox();
    firstServer.close();
    attach(fakeServer(ipv4('127.0.0.1', 5002)), true);
    expect(processActivation()!.adminSandbox()).toBe(first);
  });

  it('switches the held firebase-admin handle immediately when a replacement server is SharedWorker-hosted', async () => {
    attach(fakeServer(ipv4('127.0.0.1', 5001)), true);
    const held = processActivation()!.adminSandbox() as unknown as {
      ready: Promise<void>;
      channel: { op: (payload: { method: string }) => Promise<unknown> };
    };
    attach(fakeServer(ipv4('127.0.0.1', 5002)), false);
    await expect(held.ready).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(held.channel.op({ method: 'firestore.get' })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('installs nothing when PYRIC_SANDBOX already activates the process', () => {
    attach(fakeServer(ipv4('127.0.0.1')), true, { PYRIC_SANDBOX: 'remote:http://127.0.0.1:9000' });
    expect(processActivation()).toBeUndefined();
  });

  it('refuses firebase-admin on a SharedWorker dev server without dialing, naming hosted: true', async () => {
    attach(fakeServer(ipv4('127.0.0.1')), false);
    const sandbox = processActivation()!.adminSandbox() as unknown as { ready: Promise<void> };
    await expect(sandbox.ready).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(sandbox.ready).rejects.toThrow('pyric({ hosted: true })');
  });

  it('gives the client SDKs a refusal for a host that is not the Node host', () => {
    attach(fakeServer(ipv4('127.0.0.1')), false);
    const error = processActivation()!.offHostError('the host at http://127.0.0.1:5173 is not the Node host');
    expect(error).toMatchObject({ code: 'failed-precondition' });
    expect(error.message).toBe(viteSsrRefusal('the host at http://127.0.0.1:5173 is not the Node host').message);
    expect(error.message).toContain('SharedWorker');
  });
});

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const allocateTempDir = useTempDirs('pyric-vite-ssr-worker-');

function createWorkerTestCert(dir: string): { certPath: string; keyPath: string } {
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
  'const swPort = await freePort();',
  'const swServer = await createServer({',
  "  root: appDir, configFile: false, logLevel: 'silent',",
  "  server: { port: swPort, strictPort: true, host: '127.0.0.1' },",
  '  plugins: [pyric({ hosted: false, ui: false }), earlySpawnPlugin],',
  '});',
  'await swServer.listen();',
  "const swRes = await callWorker(worker, 'sw');",
  'await swServer.close();',
  'const h1Port = await freePort();',
  'const h1Server = await createServer({',
  "  root: appDir, configFile: false, logLevel: 'silent',",
  "  server: { port: h1Port, strictPort: true, host: '127.0.0.1' },",
  '  plugins: [pyric({ hosted: true, sessionToken: true, ui: false })],',
  '});',
  'await h1Server.listen();',
  "const h1Res = await callWorker(worker, 'h1');",
  'await h1Server.close();',
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
    const { certPath, keyPath } = createWorkerTestCert(baseDir);

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

const APP_CHECK_VERIFIER = Symbol.for('pyric.admin.appCheck.firebaseVerifier');
const VITE_PROCESS_STOP = Symbol.for('pyric.viteProcessStop');

describe('Vite SSR App Check verifier lifecycle (#1561)', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[APP_CHECK_VERIFIER];
    delete (globalThis as Record<symbol, unknown>)[VITE_PROCESS_STOP];
  });

  it('installs the firebaseVerifier symbol in production AI mode (env and passthrough) and clears it on close', () => {
    const holder = globalThis as Record<symbol, unknown>;
    const prod = attach(fakeServer(ipv4('127.0.0.1', 5180)), true, { PYRIC_AI_MODE: 'production' });
    expect(typeof holder[APP_CHECK_VERIFIER]).toBe('function');
    prod.close();
    expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();

    const passthrough = attach(fakeServer(ipv4('127.0.0.1', 5181)), true, { PYRIC_AI_PASSTHROUGH: '1' });
    expect(typeof holder[APP_CHECK_VERIFIER]).toBe('function');
    passthrough.close();
    expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();
  });

  it('does not install the verifier in sandbox AI mode', () => {
    const holder = globalThis as Record<symbol, unknown>;
    attach(fakeServer(ipv4('127.0.0.1', 5182)), true, {});
    expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();
  });

  it('tracks restarts across production and sandbox AI modes without letting an old close clear a newer server', () => {
    const holder = globalThis as Record<symbol, unknown>;
    const first = attach(fakeServer(ipv4('127.0.0.1', 5183)), true, { PYRIC_AI_MODE: 'production' });
    const firstVerifier = holder[APP_CHECK_VERIFIER];
    expect(typeof firstVerifier).toBe('function');

    const second = attach(fakeServer(ipv4('127.0.0.1', 5184)), true, {});
    expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();
    first.close();
    expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();

    const third = attach(fakeServer(ipv4('127.0.0.1', 5185)), true, { PYRIC_AI_MODE: 'production' });
    const thirdVerifier = holder[APP_CHECK_VERIFIER];
    expect(typeof thirdVerifier).toBe('function');
    second.close();
    expect(holder[APP_CHECK_VERIFIER]).toBe(thirdVerifier);

    const fourth = attach(fakeServer(ipv4('127.0.0.1', 5186)), true, { PYRIC_AI_MODE: 'production' });
    const fourthVerifier = holder[APP_CHECK_VERIFIER];
    expect(typeof fourthVerifier).toBe('function');
    third.close();
    expect(holder[APP_CHECK_VERIFIER]).toBe(fourthVerifier);
    fourth.close();
    expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();
  });

  it('reads the active Vite process-stop sandbox lease when env is process.env and ignores live leases', () => {
    const holder = globalThis as Record<symbol, unknown>;
    const savedSandbox = process.env.PYRIC_SANDBOX;
    delete process.env.PYRIC_SANDBOX;
    try {
      holder[VITE_PROCESS_STOP] = {
        leases: [{ kind: 'sandbox', getAiMode: () => 'production' }],
      };
      const prod = attach(fakeServer(ipv4('127.0.0.1', 5187)), true, process.env);
      expect(typeof holder[APP_CHECK_VERIFIER]).toBe('function');
      prod.close();
      expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();

      holder[VITE_PROCESS_STOP] = {
        leases: [{ kind: 'live' }],
      };
      const live = attach(fakeServer(ipv4('127.0.0.1', 5188)), true, process.env);
      expect(holder[APP_CHECK_VERIFIER]).toBeUndefined();
      live.close();
    } finally {
      if (savedSandbox === undefined) {
        delete process.env.PYRIC_SANDBOX;
      } else {
        process.env.PYRIC_SANDBOX = savedSandbox;
      }
    }
  });

  it('preserves externally installed verifiers when PYRIC_SANDBOX activates the process or when replaced before close', () => {
    const holder = globalThis as Record<symbol, unknown>;
    const external = async () => ({ appId: 'external', token: {} });
    holder[APP_CHECK_VERIFIER] = external;

    const outside = attach(fakeServer(ipv4('127.0.0.1', 5189)), true, {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:9000',
      PYRIC_AI_MODE: 'production',
    });
    expect(holder[APP_CHECK_VERIFIER]).toBe(external);
    outside.close();
    expect(holder[APP_CHECK_VERIFIER]).toBe(external);

    const sandboxServer = attach(fakeServer(ipv4('127.0.0.1', 5190)), true, {});
    expect(holder[APP_CHECK_VERIFIER]).toBe(external);
    sandboxServer.close();
    expect(holder[APP_CHECK_VERIFIER]).toBe(external);

    const prodServer = attach(fakeServer(ipv4('127.0.0.1', 5191)), true, { PYRIC_AI_MODE: 'production' });
    expect(holder[APP_CHECK_VERIFIER]).not.toBe(external);
    holder[APP_CHECK_VERIFIER] = external;
    prodServer.close();
    expect(holder[APP_CHECK_VERIFIER]).toBe(external);
  });
});
