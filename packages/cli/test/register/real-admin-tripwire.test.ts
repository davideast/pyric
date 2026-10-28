/**
 * #1443 part 2: a registered process fails closed when the real
 * `firebase-admin` loads anyway. The register maps every form of the import it
 * recognizes, and `pyric-admin` has no runtime dependency on `firebase-admin`,
 * so a real `firebase-admin` file in a registered process is a missed import.
 * The first one escalates the network guard to block, even under an explicit
 * `PYRIC_GUARD=warn`.
 *
 * Nothing leaves the machine, whether or not the guard refuses. A `--require`
 * preload, which Node runs before the register's `--import`, sends every
 * connection to a host other than loopback to a sink this test runs, and
 * records it. The guard installs later and wraps that patch, so it still sees
 * each host as the child wrote it.
 *
 * Requires the CLI to be built (`dist/register/index.js`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const toolsRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(toolsRoot, '../..');
const registerDist = join(toolsRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;
const realAdminUrl = pathToFileURL(createRequire(join(repoRoot, 'package.json')).resolve('firebase-admin/app')).href;

const TRAP = `'use strict';
const net = require('node:net');
const SINK_PORT = Number(process.env.TRIPWIRE_SINK_PORT);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const escaped = [];
globalThis[Symbol.for('tripwire.escaped')] = escaped;
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

/** Tries each egress, then reports what the guard said and what escaped to the sink. */
const PROBE = `import net from 'node:net';
import { spawnSync } from 'node:child_process';
const outcome = {};
if (process.env.LOAD_REAL_ADMIN === '1') await import(process.env.REAL_ADMIN_URL);
if (process.env.LOAD_SPECIFIER) {
  try { await import(process.env.LOAD_SPECIFIER); } catch (error) { outcome.load = String(error); }
}
try {
  await fetch('https://firestore.googleapis.com/v1/projects/demo-tripwire/databases/(default)/documents/a/b');
  outcome.fetch = 'sent';
} catch (error) {
  outcome.fetch = error?.cause?.code ?? error?.code ?? String(error);
}
await new Promise((resolve) => {
  try {
    const socket = net.connect(80, '169.254.169.254');
    outcome.metadata = 'sent';
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
  } catch (error) {
    outcome.metadata = error?.code ?? String(error);
    resolve();
  }
});
outcome.apis = {};
for (const host of (process.env.EXTRA_HOSTS ?? '').split(',').filter(Boolean)) {
  try {
    await fetch('https://' + host + '/v1/probe', { method: 'POST' });
    outcome.apis[host] = 'sent';
  } catch (error) {
    outcome.apis[host] = error?.cause?.code ?? error?.code ?? String(error);
  }
}
if (process.env.SPAWN_CHILD === '1') {
  const child = spawnSync(process.execPath, ['child.mjs'], { encoding: 'utf8' });
  outcome.child = (/CHILD (\\S+)/.exec(child.stdout) ?? [])[1] ?? child.stderr.slice(-300);
}
outcome.escaped = globalThis[Symbol.for('tripwire.escaped')];
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

/** A child the probe starts after the tripwire. It never loads firebase-admin itself. */
const CHILD = `try {
  await fetch('https://firestore.googleapis.com/v1/projects/demo-tripwire/databases/(default)/documents/a/b');
  console.log('CHILD sent');
} catch (error) {
  console.log('CHILD ' + (error?.cause?.code ?? error?.code ?? String(error)));
}
`;

/**
 * Two installs of `firebase-admin` under a folder that is not named for it:
 * an npm alias (`"admin": "npm:firebase-admin@13"`), which installs the real
 * package, manifest and all, as `node_modules/admin`; and a link named
 * `renamed-admin` to a copy kept in `vendor/`. Each is a stand-in with the
 * real manifest name, so nothing it loads could open a socket.
 */
function writeAdminLookalikes(dir: string): void {
  const manifest = JSON.stringify({ name: 'firebase-admin', version: '13.0.0', main: 'index.js' });
  for (const packageDir of [join(dir, 'node_modules/admin'), join(dir, 'vendor/admin-copy')]) {
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), manifest);
    writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};\n');
  }
  symlinkSync(join(dir, 'vendor/admin-copy'), join(dir, 'node_modules/renamed-admin'), 'dir');
}

/** Google APIs the endpoint catalog does not list, which a real firebase-admin calls (#1475). */
const UNLISTED_APIS = ['oauth2.googleapis.com', 'firebaserules.googleapis.com', 'firebaseremoteconfig.googleapis.com'];

let fixtureDir: string;
let sink: Server;

interface Outcome {
  load?: string;
  fetch: string;
  metadata: string;
  apis: Record<string, string>;
  child?: string;
  escaped: string[];
}

function runProbe(
  env: Record<string, string>,
  nodeArgs: string[] = [],
): Promise<{ status: number | null; stderr: string; outcome: Outcome }> {
  // Through NODE_OPTIONS, as `pyric sandbox` does, so a child the probe starts loads the trap and the register too.
  const nodeOptions = `--require ${join(fixtureDir, 'trap.cjs')} --import ${registerUrl}`;
  const child = spawn('node', [...nodeArgs, 'probe.mjs'], {
    cwd: fixtureDir,
    env: {
      NODE_OPTIONS: nodeOptions,
      PATH: process.env.PATH,
      HOME: fixtureDir,
      CLOUDSDK_CONFIG: join(fixtureDir, 'empty-gcloud'),
      TRIPWIRE_SINK_PORT: String((sink.address() as AddressInfo).port),
      REAL_ADMIN_URL: realAdminUrl,
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

beforeAll(async () => {
  if (!existsSync(registerDist)) {
    throw new Error(`dist/register/index.js missing: run \`bun run build\` first (${registerDist})`);
  }
  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-real-admin-tripwire-'));
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'tripwire-fixture', type: 'module' }));
  writeFileSync(join(fixtureDir, 'trap.cjs'), TRAP);
  writeFileSync(join(fixtureDir, 'probe.mjs'), PROBE);
  writeFileSync(join(fixtureDir, 'child.mjs'), CHILD);
  writeAdminLookalikes(fixtureDir);
  sink = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveListen) => sink.listen(0, '127.0.0.1', resolveListen));
});

afterAll(async () => {
  if (sink) await new Promise<void>((resolveClose) => sink.close(() => resolveClose()));
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe('@pyric/cli/register real firebase-admin tripwire (child process)', () => {
  it('escalates the guard to block when the real firebase-admin loads, even under PYRIC_GUARD=warn', async () => {
    const res = await runProbe({ LOAD_REAL_ADMIN: '1', PYRIC_GUARD: 'warn' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome).toMatchObject({ fetch: 'PYRIC_GUARD_BLOCKED', metadata: 'PYRIC_GUARD_BLOCKED', escaped: [] });
    const tripwire = res.stderr.split('\n').filter((line) => line.includes('the real firebase-admin loaded from'));
    expect(tripwire, res.stderr).toHaveLength(1);
    expect(tripwire[0]).toContain(realAdminUrl);
    expect(tripwire[0]).toContain('https://github.com/davideast/pyric/issues/1443');
    expect(res.stderr).toContain('net-guard escalated to block');
  }, 30_000);

  it('escalates under the default mode too', async () => {
    const res = await runProbe({ LOAD_REAL_ADMIN: '1' });
    expect(res.outcome).toMatchObject({ fetch: 'PYRIC_GUARD_BLOCKED', metadata: 'PYRIC_GUARD_BLOCKED', escaped: [] });
  }, 30_000);

  it('keeps warn in a registered process that never loads the real firebase-admin', async () => {
    const res = await runProbe({ PYRIC_GUARD: 'warn' });
    expect(res.status, res.stderr).toBe(0);
    // Warn lets both through, and the trap catches them on this machine.
    expect(res.outcome.metadata).toBe('sent');
    expect(res.outcome.escaped).toContain('169.254.169.254');
    expect(res.stderr).not.toContain('the real firebase-admin loaded');
    expect(res.stderr).not.toContain('escalated to block');
  }, 30_000);

  it('refuses every Google host after the tripwire, not only the catalog (#1475)', async () => {
    const res = await runProbe({ LOAD_REAL_ADMIN: '1', PYRIC_GUARD: 'warn', EXTRA_HOSTS: UNLISTED_APIS.join(',') });
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome.apis).toEqual(Object.fromEntries(UNLISTED_APIS.map((host) => [host, 'PYRIC_GUARD_BLOCKED'])));
    expect(res.outcome.escaped).toEqual([]);
    expect(res.stderr).toContain('refuses every connection to *.googleapis.com');
  }, 30_000);

  it('lets Google Fonts through after the tripwire, by exact name', async () => {
    const res = await runProbe({
      LOAD_REAL_ADMIN: '1',
      EXTRA_HOSTS: 'fonts.googleapis.com,fonts.gstatic.com,oauth2.googleapis.com',
    });
    // The fonts hosts reach the trap's sink on this machine and nowhere else.
    expect(res.outcome.apis).toEqual({
      'fonts.googleapis.com': 'ECONNRESET',
      'fonts.gstatic.com': 'ECONNRESET',
      'oauth2.googleapis.com': 'PYRIC_GUARD_BLOCKED',
    });
    expect(res.outcome.metadata).toBe('PYRIC_GUARD_BLOCKED');
    expect(res.outcome.escaped).toEqual(['fonts.googleapis.com', 'fonts.gstatic.com']);
  }, 30_000);

  it('lets PYRIC_GUARD_ALLOW through after the tripwire', async () => {
    const res = await runProbe({
      LOAD_REAL_ADMIN: '1',
      PYRIC_GUARD_ALLOW: 'firebaserules.googleapis.com',
      EXTRA_HOSTS: 'firebaserules.googleapis.com,oauth2.googleapis.com',
    });
    // Allowed, so it reaches the trap's sink on this machine and nowhere else.
    expect(res.outcome.apis).toEqual({
      'firebaserules.googleapis.com': 'ECONNRESET',
      'oauth2.googleapis.com': 'PYRIC_GUARD_BLOCKED',
    });
    expect(res.outcome.escaped).toEqual(['firebaserules.googleapis.com']);
  }, 30_000);

  it('keeps the catalog list under plain block, with no tripwire', async () => {
    const res = await runProbe({ PYRIC_GUARD: 'block', EXTRA_HOSTS: 'oauth2.googleapis.com' });
    expect(res.outcome.fetch).toBe('PYRIC_GUARD_BLOCKED');
    expect(res.outcome.apis).toEqual({ 'oauth2.googleapis.com': 'ECONNRESET' });
    expect(res.outcome.escaped).toEqual(['oauth2.googleapis.com']);
  }, 30_000);

  it('trips on firebase-admin installed under an npm alias (#1475)', async () => {
    const res = await runProbe({ LOAD_SPECIFIER: 'admin', PYRIC_GUARD: 'warn' });
    expect(res.outcome.load, res.stderr).toBeUndefined();
    expect(res.outcome).toMatchObject({ fetch: 'PYRIC_GUARD_BLOCKED', metadata: 'PYRIC_GUARD_BLOCKED', escaped: [] });
    expect(res.stderr).toContain(pathToFileURL(join(fixtureDir, 'node_modules/admin/index.js')).href);
  }, 30_000);

  it('trips on firebase-admin linked under another name, with and without --preserve-symlinks (#1475)', async () => {
    for (const nodeArgs of [['--preserve-symlinks'], []]) {
      const res = await runProbe({ LOAD_SPECIFIER: 'renamed-admin', PYRIC_GUARD: 'warn' }, nodeArgs);
      expect(res.outcome.load, res.stderr).toBeUndefined();
      expect(res.outcome, nodeArgs.join(' ')).toMatchObject({ fetch: 'PYRIC_GUARD_BLOCKED', escaped: [] });
    }
  }, 30_000);

  it('passes block to a child started after the tripwire (#1475)', async () => {
    const res = await runProbe({ LOAD_REAL_ADMIN: '1', PYRIC_GUARD: 'warn', SPAWN_CHILD: '1' });
    expect(res.outcome.child, res.stderr).toBe('PYRIC_GUARD_BLOCKED');
    expect(res.outcome.escaped).toEqual([]);
  }, 30_000);

  it('stays off under PYRIC_GUARD=off', async () => {
    const res = await runProbe({ LOAD_REAL_ADMIN: '1', PYRIC_GUARD: 'off' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome.metadata).toBe('sent');
    expect(res.stderr).not.toContain('escalated to block');
  }, 30_000);
});
