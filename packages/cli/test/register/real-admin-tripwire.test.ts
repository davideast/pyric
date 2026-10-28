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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const outcome = {};
if (process.env.LOAD_REAL_ADMIN === '1') await import(process.env.REAL_ADMIN_URL);
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
outcome.escaped = globalThis[Symbol.for('tripwire.escaped')];
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

let fixtureDir: string;
let sink: Server;

interface Outcome {
  fetch: string;
  metadata: string;
  escaped: string[];
}

function runProbe(env: Record<string, string>): Promise<{ status: number | null; stderr: string; outcome: Outcome }> {
  const child = spawn('node', ['--require', join(fixtureDir, 'trap.cjs'), '--import', registerUrl, 'probe.mjs'], {
    cwd: fixtureDir,
    env: {
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
    expect(res.outcome).toEqual({ fetch: 'PYRIC_GUARD_BLOCKED', metadata: 'PYRIC_GUARD_BLOCKED', escaped: [] });
    const tripwire = res.stderr.split('\n').filter((line) => line.includes('the real firebase-admin loaded from'));
    expect(tripwire, res.stderr).toHaveLength(1);
    expect(tripwire[0]).toContain(realAdminUrl);
    expect(tripwire[0]).toContain('https://github.com/davideast/pyric/issues/1443');
    expect(res.stderr).toContain('net-guard escalated to block');
  }, 30_000);

  it('escalates under the default mode too', async () => {
    const res = await runProbe({ LOAD_REAL_ADMIN: '1' });
    expect(res.outcome).toEqual({ fetch: 'PYRIC_GUARD_BLOCKED', metadata: 'PYRIC_GUARD_BLOCKED', escaped: [] });
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

  it('stays off under PYRIC_GUARD=off', async () => {
    const res = await runProbe({ LOAD_REAL_ADMIN: '1', PYRIC_GUARD: 'off' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.outcome.metadata).toBe('sent');
    expect(res.stderr).not.toContain('escalated to block');
  }, 30_000);
});
