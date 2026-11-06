/**
 * Live mode's refusals in a Node process under `@pyric/live/register`: a
 * named Firestore database, and the network guard, which lets only the live
 * rows' SDK reach Google. Each case runs a real `node --import
 * @pyric/live/register` process in a project with `@pyric/cli`,
 * `@pyric/live` and `firebase` installed, and proves no refused request left:
 *
 * - Firestore is pointed at a local server that counts its connections;
 * - every TLS connection the process opens passes a preload, loaded before
 *   the register and so beneath its guard, that records the host and sends
 *   the connection to a closed loopback port. What the preload records left
 *   the guard; nothing reaches Google.
 *
 * The import refusals and `firebase-admin` are covered by
 * `live-register-stop.test.ts`. Run the file under Node 22.15 and Node 24.
 * Requires the CLI and `@pyric/live` to be built (`dist/`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cliDir = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliDir, '../..');
const liveDir = join(repoRoot, 'packages/live');
const liveRegisterFile = join(liveDir, 'dist/register.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const realAdminDir = realpathSync(dirname(requireFromRepo.resolve('firebase-admin/package.json')));
/** `@google-cloud/firestore`, the server SDK `firebase-admin` installs beside it. */
const realCloudFirestoreDir = (() => {
  const entry = createRequire(join(realAdminDir, 'package.json')).resolve('@google-cloud/firestore');
  return entry.slice(0, entry.lastIndexOf('/node_modules/@google-cloud/firestore/') + '/node_modules/@google-cloud/firestore'.length);
})();

/**
 * Loaded before the register: records the host of every TLS connection that
 * gets past the guard, and sends it to a closed loopback port instead. It
 * answers every `googleapis.com` lookup with the loopback address too, so no
 * name leaves the machine and gRPC gets as far as its connection.
 */
const TLS_RECORDER = `import dns from 'node:dns';
import tls from 'node:tls';
const isGoogle = (hostname) => typeof hostname === 'string' && hostname.endsWith('.googleapis.com');
const realLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (!isGoogle(hostname)) return realLookup.apply(this, arguments);
  const done = typeof options === 'function' ? options : callback;
  const all = typeof options === 'object' && options !== null && options.all === true;
  if (all) process.nextTick(done, null, [{ address: '127.0.0.1', family: 4 }]);
  else process.nextTick(done, null, '127.0.0.1', 4);
};
const reached = [];
globalThis[Symbol.for('live.refusals.reached')] = reached;
const realConnect = tls.connect;
const closedPort = Number(process.env.CLOSED_PORT);
tls.connect = function (...args) {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    reached.push(first.servername ?? first.host);
    args[0] = { ...first, host: '127.0.0.1', port: closedPort };
  } else {
    const options = typeof args[2] === 'object' && args[2] !== null ? args[2] : {};
    reached.push(options.servername ?? args[1]);
    args[0] = closedPort;
    args[1] = '127.0.0.1';
  }
  return realConnect.apply(this, args);
};
`;

let projectDir: string;
let counter: Server;
let counted = 0;
let counterPort = 0;
let closedPort = 0;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return address.port;
}

beforeAll(async () => {
  for (const built of [liveRegisterFile, join(cliDir, 'dist/register/live-net-guard.js')]) {
    if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
  }
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-refusals-')));
  const nm = join(projectDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(cliDir, join(nm, '@pyric/cli'));
  symlinkSync(liveDir, join(nm, '@pyric/live'));
  symlinkSync(realFirebaseDir, join(nm, 'firebase'));
  mkdirSync(join(nm, '@google-cloud'), { recursive: true });
  symlinkSync(realCloudFirestoreDir, join(nm, '@google-cloud/firestore'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'live-refusals-fixture', type: 'module' }));
  // The Firebase project live mode names; every live start refuses without one.
  writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: 'live-refusals' } }));
  writeFileSync(join(projectDir, 'tls-recorder.mjs'), TLS_RECORDER);
  counter = createServer((socket) => {
    counted += 1;
    socket.destroy();
  });
  counterPort = await listen(counter);
  const closed = createServer();
  closedPort = await listen(closed);
  await new Promise<void>((done) => closed.close(() => done()));
});

afterAll(async () => {
  await new Promise<void>((done) => counter.close(() => done()));
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stderr: string;
  outcome: Record<string, unknown>;
}

/**
 * Runs `script` under the TLS recorder and the live register; it prints one
 * `OUTCOME` line. Asynchronous, so this process's counting server answers
 * while the child runs.
 */
async function runLive(name: string, script: string): Promise<Run> {
  const file = join(projectDir, name);
  writeFileSync(file, script);
  const imports = ['--import', pathToFileURL(join(projectDir, 'tls-recorder.mjs')).href, '--import', '@pyric/live/register'];
  const child = spawn('node', [...imports, file], {
    cwd: projectDir,
    env: { PATH: process.env.PATH, HOME: projectDir, CLOSED_PORT: String(closedPort) },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 50_000);
  const status = await new Promise<number | null>((done) => child.on('close', (code) => done(code)));
  clearTimeout(timer);
  const line = stdout.split('\n').find((entry) => entry.startsWith('OUTCOME ')) ?? 'OUTCOME {}';
  return { status, stderr, outcome: JSON.parse(line.slice('OUTCOME '.length)) as Record<string, unknown> };
}

const CONFIG = "{ projectId: 'live-refusals', apiKey: 'live-refusals-key', appId: '1:1:web:1' }";

describe('a named Firestore database, in a Node process', () => {
  it('is refused before any request leaves, while the default database reaches the same server', async () => {
    const before = counted;
    const script = `import { initializeApp } from 'firebase/app';
import { doc, getDocFromServer, getFirestore, initializeFirestore, terminate } from 'firebase/firestore';
const settings = { host: '127.0.0.1:${counterPort}', ssl: false };
const outcome = {};
const attempt = (name, call) => { try { call(); outcome[name] = 'served'; } catch (error) { outcome[name] = error.code; outcome[name + ' message'] = error.message; } };
attempt('initializeFirestore', () => initializeFirestore(initializeApp(${CONFIG}, 'named'), settings, 'reports'));
attempt('getFirestore', () => getFirestore(initializeApp(${CONFIG}, 'named-get'), 'reports'));
await new Promise((resolve) => setTimeout(resolve, 300));
console.log('OUTCOME ' + JSON.stringify(outcome));
`;
    const res = await runLive('named-database.mjs', script);
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome.initializeFirestore).toBe('PYRIC_LIVE_REFUSED');
    expect(res.outcome.getFirestore).toBe('PYRIC_LIVE_REFUSED');
    expect(res.outcome['initializeFirestore message']).toContain('initializeFirestore with the database "reports" is refused in live mode, from a Node process');
    expect(counted).toBe(before);

    const control = `import { initializeApp } from 'firebase/app';
import { doc, getDocFromServer, initializeFirestore } from 'firebase/firestore';
const db = initializeFirestore(initializeApp(${CONFIG}), { host: '127.0.0.1:${counterPort}', ssl: false });
getDocFromServer(doc(db, 'rooms/lobby')).catch(() => undefined);
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log('OUTCOME {}');
process.exit(0);
`;
    const controlRun = await runLive('default-database.mjs', control);
    expect(controlRun.status, controlRun.stderr).toBe(0);
    expect(counted).toBeGreaterThan(before);
  }, 60_000);
});

describe('the network guard under @pyric/live/register', () => {
  it("refuses the app's own requests to Google and lets the live rows' Auth and Firestore through", async () => {
    const script = `import https from 'node:https';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
const reached = globalThis[Symbol.for('live.refusals.reached')];
const outcome = {};
const fetchOutcome = (url, init) => fetch(url, init).then(() => 'sent', (error) => error?.cause?.code ?? error?.code ?? String(error));
outcome.fetchFirestore = await fetchOutcome('https://firestore.googleapis.com/v1/projects/live-refusals/databases/(default)/documents/rooms/lobby');
outcome.fetchStorage = await fetchOutcome('https://storage.googleapis.com/storage/v1/b/live-refusals');
outcome.fetchToken = await fetchOutcome('https://oauth2.googleapis.com/token', { method: 'POST' });
outcome.fetchRequest = await fetchOutcome(new Request('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=k', { method: 'POST' }));
outcome.httpsRequest = await new Promise((resolve) => {
  try {
    const request = https.request('https://www.googleapis.com/storage/v1/b/live-refusals', () => resolve('sent'));
    request.on('error', (error) => resolve(error.code ?? String(error)));
    request.end();
  } catch (error) {
    resolve(error.code ?? String(error));
  }
});
outcome.reachedByApp = [...reached];
const app = initializeApp(${CONFIG});
outcome.signIn = await signInAnonymously(getAuth(app)).then(() => 'signed in', (error) => error.code);
getDocFromServer(doc(getFirestore(app), 'rooms/lobby')).catch(() => undefined);
const deadline = Date.now() + 20000;
while (!reached.includes('firestore.googleapis.com') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
outcome.reached = [...new Set(reached)].sort();
console.log('OUTCOME ' + JSON.stringify(outcome));
process.exit(0);
`;
    const res = await runLive('guard.mjs', script);
    expect(res.status, res.stderr).toBe(0);
    for (const name of ['fetchFirestore', 'fetchStorage', 'fetchToken', 'fetchRequest', 'httpsRequest']) {
      expect(res.outcome[name], name).toBe('PYRIC_GUARD_BLOCKED');
    }
    // Nothing the app asked for got past the guard.
    expect(res.outcome.reachedByApp).toEqual([]);
    // The live rows' own requests did, and went no further than the closed port.
    expect(res.outcome.signIn).toBe('auth/network-request-failed');
    expect(res.outcome.reached).toEqual(['firestore.googleapis.com', 'identitytoolkit.googleapis.com']);
    expect(res.stderr).toContain('@pyric/live/register: net-guard BLOCK firestore.googleapis.com (Cloud Firestore) via fetch');
    expect(res.stderr).toContain("in live mode a fetch to Google is made only by the installed SDK that @pyric/live's rows load");
    expect(res.stderr).toContain('net-guard BLOCK storage.googleapis.com (Cloud Storage)');
    expect(res.stderr).toContain(
      'in live mode only the imports @pyric/live serves (firebase/auth, firebase/firestore, firebase/app-check, firebase/database, firebase/ai and firebase/storage) reach Google',
    );
    expect(res.stderr).not.toContain('BLOCK identitytoolkit.googleapis.com (Firebase Authentication) via socket');
  }, 60_000);

  it('lets a request to a host that is not Google through', async () => {
    const before = counted;
    const script = `const outcome = { local: await fetch('http://127.0.0.1:${counterPort}/').then(() => 'answered', (error) => error?.cause?.code ?? 'failed') };
console.log('OUTCOME ' + JSON.stringify(outcome));
`;
    const res = await runLive('local.mjs', script);
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome.local).not.toBe('PYRIC_GUARD_BLOCKED');
    expect(counted).toBeGreaterThan(before);
  }, 60_000);
});

describe("app code that skips the live rows' SDK, under @pyric/live/register", () => {
  it('refuses a raw https.request to a live row host, naming live mode and the wrapped SDK', async () => {
    const script = `import https from 'node:https';
const reached = globalThis[Symbol.for('live.refusals.reached')];
const send = (url, method) => new Promise((resolve) => {
  try {
    const request = https.request(url, { method, headers: { 'content-type': 'application/json' } }, () => resolve('sent'));
    request.on('error', (error) => resolve(error.code ?? String(error)));
    request.end('{}');
  } catch (error) {
    resolve(error.code ?? String(error));
  }
});
const outcome = {};
outcome.firestore = await send('https://firestore.googleapis.com/v1/projects/live-refusals/databases/(default)/documents/rooms/lobby', 'PATCH');
outcome.auth = await send('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=k', 'POST');
outcome.appCheck = await send('https://content-firebaseappcheck.googleapis.com/v1/projects/live-refusals/apps/1:1:web:1:exchangeDebugToken', 'POST');
outcome.reachedByApp = [...reached];
console.log('OUTCOME ' + JSON.stringify(outcome));
process.exit(0);
`;
    const res = await runLive('raw-https.mjs', script);
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome.firestore).toBe('PYRIC_GUARD_BLOCKED');
    expect(res.outcome.auth).toBe('PYRIC_GUARD_BLOCKED');
    expect(res.outcome.appCheck).toBe('PYRIC_GUARD_BLOCKED');
    expect(res.outcome.reachedByApp).toEqual([]);
    expect(res.stderr).toContain('@pyric/live/register: net-guard BLOCK firestore.googleapis.com (Cloud Firestore) via socket');
    expect(res.stderr).toContain("in live mode only the installed Firebase SDK, wrapped by @pyric/live's rows, reaches this host");
    expect(res.stderr).toContain('Make the call through firebase/auth, firebase/firestore or firebase/app-check, so pyric observes it');
    expect(res.stderr).not.toContain('firebase/database, so pyric observes it');
  }, 60_000);

  it('refuses @google-cloud/firestore at import, before it loads', async () => {
    const script = `const outcome = {};
try {
  await import('@google-cloud/firestore');
  outcome.cloudFirestore = 'loaded';
} catch (error) {
  outcome.cloudFirestore = error.code ?? String(error);
  outcome.message = error.message;
}
console.log('OUTCOME ' + JSON.stringify(outcome));
process.exit(0);
`;
    const res = await runLive('cloud-firestore.mjs', script);
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome.cloudFirestore).toBe('PYRIC_REAL_SDK_STOPPED');
    expect(res.outcome.message).toContain('@pyric/live/register: stopped loading @google-cloud/firestore');
    expect(res.outcome.message).toContain("In live mode, only the installed Firebase SDK reaches production, through @pyric/live's rows");
  }, 60_000);
});
