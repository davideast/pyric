/**
 * ADR 0022, swap or stop, in registered child processes. An import that
 * resolves into the real `firebase-admin`, or into the real client SDK where
 * the swap table didn't choose it, fails with `PYRIC_REAL_SDK_STOPPED` before
 * the file loads, whatever `PYRIC_GUARD` says. The real SDK still loads where
 * the table chooses it: production AI mode's `firebase/ai`.
 *
 * Nothing leaves the machine. A `--require` preload, which Node runs before
 * the register's `--import`, sends every connection to a host other than
 * loopback to a sink this test runs, and records it.
 *
 * Requires the CLI to be built (`dist/register/index.js`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const toolsRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(toolsRoot, '../..');
const registerDist = join(toolsRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realAdminFile = requireFromRepo.resolve('firebase-admin/app');
const adminBridgeUrl = pathToFileURL(join(toolsRoot, 'dist/register/app-bridge-admin-app-check.js')).href;
const realAdminDir = realpathSync(join(repoRoot, 'node_modules/firebase-admin'));
const realFirebaseDir = realpathSync(join(repoRoot, 'node_modules/firebase'));

/** The root of an installed package: the nearest directory whose manifest has this name. */
function packageDir(fromFile: string, name: string): string {
  let dir = dirname(fromFile);
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name) return dir;
    dir = dirname(dir);
  }
  throw new Error(`no ${name} above ${fromFile}`);
}

const firestoreDir = packageDir(
  createRequire(join(realFirebaseDir, 'package.json')).resolve('@firebase/firestore'),
  '@firebase/firestore',
);

const TRAP = `'use strict';
const net = require('node:net');
const SINK_PORT = Number(process.env.STOP_SINK_PORT);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const escaped = [];
globalThis[Symbol.for('stop.escaped')] = escaped;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const list = Array.isArray(args[0]) ? args[0] : args;
  const first = list[0];
  const isIpc = typeof first === 'object' && first !== null && first.path !== undefined && first.port === undefined;
  if (typeof first === 'object' && first !== null && !isIpc) {
    const host = first.host ?? 'localhost';
    if (!LOOPBACK.has(host)) {
      escaped.push(host);
      list[0] = { ...first, host: '127.0.0.1', port: SINK_PORT, lookup: undefined };
    }
  } else if (typeof first === 'number' || /^\\d+$/.test(String(first))) {
    const host = typeof list[1] === 'string' ? list[1] : 'localhost';
    if (!LOOPBACK.has(host)) {
      escaped.push(host);
      list[0] = SINK_PORT;
      list[1] = '127.0.0.1';
    }
  }
  return connect.apply(this, args);
};
`;

/** Imports LOAD_SPECIFIER (ESM) or requires it (CJS), and reports what happened. */
const PROBE_ESM = `const outcome = {};
try {
  await import(process.env.LOAD_SPECIFIER);
  outcome.load = 'loaded';
} catch (error) {
  outcome.load = error?.code ?? String(error);
}
outcome.escaped = globalThis[Symbol.for('stop.escaped')];
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

const PROBE_CJS = `const outcome = {};
try {
  require(process.env.LOAD_SPECIFIER);
  outcome.load = 'loaded';
} catch (error) {
  outcome.load = error?.code ?? String(error);
}
outcome.escaped = globalThis[Symbol.for('stop.escaped')];
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

/** Production AI mode: the real firebase/ai on the shadow app, as an app writes it. No request is sent. */
const PROBE_PRODUCTION_AI = `const outcome = {};
try {
  const { initializeApp } = await import('firebase/app');
  const { getAI, GoogleAIBackend } = await import('firebase/ai');
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-stop', appId: '1:1:web:1' });
  getAI(app, { backend: new GoogleAIBackend() });
  outcome.load = 'loaded';
} catch (error) {
  outcome.load = error?.code ?? String(error);
}
outcome.escaped = globalThis[Symbol.for('stop.escaped')];
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

/** The App Check verifier bridge loads the real firebase-admin on pyric's behalf (#1552); the app's own import afterwards still stops. */
const PROBE_BRIDGE_THEN_APP = `const outcome = {};
try {
  await import(process.env.ADMIN_BRIDGE_URL);
  outcome.bridge = 'loaded';
} catch (error) {
  outcome.bridge = error?.code ?? String(error);
}
try {
  await import(process.env.LOAD_SPECIFIER);
  outcome.load = 'loaded';
} catch (error) {
  outcome.load = error?.code ?? String(error);
}
outcome.escaped = globalThis[Symbol.for('stop.escaped')];
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

let fixtureDir: string;
let sink: Server;

interface Outcome {
  bridge?: string;
  load: string;
  escaped: string[];
}

interface Run {
  status: number | null;
  stderr: string;
  outcome: Outcome;
}

function runProbe(script: string, env: Record<string, string>, nodeFlags: readonly string[] = []): Promise<Run> {
  const args = [...nodeFlags, '--require', join(fixtureDir, 'trap.cjs'), '--import', registerUrl, script];
  const child = spawn('node', args, {
    cwd: fixtureDir,
    env: {
      PATH: process.env.PATH,
      HOME: fixtureDir,
      CLOUDSDK_CONFIG: join(fixtureDir, 'empty-gcloud'),
      STOP_SINK_PORT: String((sink.address() as AddressInfo).port),
      ADMIN_BRIDGE_URL: adminBridgeUrl,
      PYRIC_SANDBOX: 'local',
      ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise((resolveRun) => {
    child.once('exit', (status) => {
      const line = stdout.split('\n').find((entry) => entry.startsWith('OUTCOME ')) ?? 'OUTCOME {}';
      resolveRun({ status, stderr, outcome: JSON.parse(line.slice('OUTCOME '.length)) as Outcome });
    });
  });
}

function stopLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.includes('stopped loading the real'));
}

beforeAll(async () => {
  if (!existsSync(registerDist)) {
    throw new Error(`dist/register/index.js missing: run \`bun run build\` first (${registerDist})`);
  }
  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-real-sdk-stop-'));
  const nm = join(fixtureDir, 'node_modules');
  mkdirSync(join(nm, '@firebase'), { recursive: true });
  // An npm alias ("admin": "npm:firebase-admin@13") and a link under another name.
  symlinkSync(realAdminDir, join(nm, 'admin'));
  symlinkSync(realAdminDir, join(nm, 'linked-admin'));
  symlinkSync(realFirebaseDir, join(nm, 'firebase'));
  symlinkSync(firestoreDir, join(nm, '@firebase', 'firestore'));
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'stop-fixture', type: 'module' }));
  writeFileSync(join(fixtureDir, 'trap.cjs'), TRAP);
  writeFileSync(join(fixtureDir, 'probe.mjs'), PROBE_ESM);
  writeFileSync(join(fixtureDir, 'probe.cjs'), PROBE_CJS);
  writeFileSync(join(fixtureDir, 'production-ai.mjs'), PROBE_PRODUCTION_AI);
  writeFileSync(join(fixtureDir, 'bridge-then-app.mjs'), PROBE_BRIDGE_THEN_APP);
  sink = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen) => sink.listen(0, '127.0.0.1', resolveListen));
});

afterAll(async () => {
  if (sink) await new Promise<void>((resolveClose) => sink.close(() => resolveClose()));
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe('@pyric/cli/register stops the real firebase-admin (child process)', () => {
  it('stops an import by absolute file URL, even under PYRIC_GUARD=warn, and writes the stop once', async () => {
    const res = await runProbe('probe.mjs', { LOAD_SPECIFIER: pathToFileURL(realAdminFile).href, PYRIC_GUARD: 'warn' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome).toEqual({ load: 'PYRIC_REAL_SDK_STOPPED', escaped: [] });
    expect(stopLines(res.stderr), res.stderr).toEqual(['@pyric/cli/register: stopped loading the real firebase-admin']);
    expect(res.stderr).toContain(`found  ${pathToFileURL(realpathSync(realAdminFile)).href}`);
    expect(res.stderr).toContain('code: PYRIC_REAL_SDK_STOPPED');
    expect(res.stderr).not.toContain('escalated to block');
  }, 30_000);

  it('stops a CommonJS require by absolute path', async () => {
    const res = await runProbe('probe.cjs', { LOAD_SPECIFIER: realAdminFile });
    expect(res.outcome).toEqual({ load: 'PYRIC_REAL_SDK_STOPPED', escaped: [] });
  }, 30_000);

  it('stops an npm alias, which the register cannot map by name', async () => {
    const res = await runProbe('probe.mjs', { LOAD_SPECIFIER: 'admin/app' });
    expect(res.outcome).toEqual({ load: 'PYRIC_REAL_SDK_STOPPED', escaped: [] });
  }, 30_000);

  it('stops a link under another name, with and without --preserve-symlinks', async () => {
    const plain = await runProbe('probe.mjs', { LOAD_SPECIFIER: 'linked-admin/app' });
    const preserved = await runProbe('probe.mjs', { LOAD_SPECIFIER: 'linked-admin/app' }, ['--preserve-symlinks']);
    expect([plain.outcome.load, preserved.outcome.load]).toEqual(['PYRIC_REAL_SDK_STOPPED', 'PYRIC_REAL_SDK_STOPPED']);
  }, 30_000);

  it('still stops under PYRIC_GUARD=off, which only turns off the network guard', async () => {
    const res = await runProbe('probe.mjs', { LOAD_SPECIFIER: 'admin/app', PYRIC_GUARD: 'off' });
    expect(res.outcome.load).toBe('PYRIC_REAL_SDK_STOPPED');
  }, 30_000);
});

describe("@pyric/cli/register lets production AI mode's App Check verifier bridge load firebase-admin (child process)", () => {
  it('loads the bridge and the firebase-admin it pulls in, then still stops the app import of the real package', async () => {
    const res = await runProbe('bridge-then-app.mjs', {
      LOAD_SPECIFIER: pathToFileURL(realAdminFile).href,
      PYRIC_AI_MODE: 'production',
      PYRIC_GUARD: 'warn',
    });
    expect(res.outcome, res.stderr).toEqual({ bridge: 'loaded', load: 'PYRIC_REAL_SDK_STOPPED', escaped: [] });
    expect(stopLines(res.stderr), res.stderr).toHaveLength(1);
  }, 30_000);
});

describe('@pyric/cli/register stops the real client SDK where the swap table did not choose it (child process)', () => {
  it('stops @firebase/firestore imported by app code', async () => {
    const res = await runProbe('probe.mjs', { LOAD_SPECIFIER: '@firebase/firestore' });
    expect(res.outcome).toEqual({ load: 'PYRIC_REAL_SDK_STOPPED', escaped: [] });
    expect(res.stderr).toContain("import 'firebase/firestore' instead of '@firebase/firestore'");
  }, 30_000);

  it('still maps firebase/firestore to the sandbox, so nothing stops', async () => {
    const res = await runProbe('probe.mjs', { LOAD_SPECIFIER: 'firebase/firestore' });
    expect(res.outcome.load, res.stderr).toBe('loaded');
    expect(stopLines(res.stderr)).toEqual([]);
  }, 30_000);

  it('loads the real firebase/ai and its shadow app in production AI mode', async () => {
    const res = await runProbe('production-ai.mjs', { PYRIC_AI_MODE: 'production' });
    expect(res.outcome, res.stderr).toEqual({ load: 'loaded', escaped: [] });
    expect(stopLines(res.stderr)).toEqual([]);
  }, 30_000);
});
