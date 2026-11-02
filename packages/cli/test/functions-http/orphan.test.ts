/**
 * The Functions child must not outlive its parent. `pyric sandbox` runs the
 * capture fixture (onRequest functions, so the child also has its HTTP server,
 * heartbeat, and uncaught-error handler); the test SIGKILLs the CLI and
 * asserts its child exits within ~2 s without spinning. A second case sends
 * SIGTERM to the child while its host still runs, so the signal handler is
 * what ends it. The root cause itself (a send on a closed channel) is pinned
 * in child-ipc.test.ts.
 * Linux only: it reads /proc for the child's pid and CPU time.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { functionsHttpCaptureDir } from '@pyric/conformance/functions-http-fixture';
import { connectFunctionsWorkerPeer, createFunctionsWorkerHostCtx } from '../functions-rtdb/worker-peer.js';
import { functionsChildrenOf, isAlive as alive } from './children.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const PROJECT_ID = 'demo-functions-http';
const CLOCK_TICKS_PER_SECOND = 100;
const linuxOnly = process.platform === 'linux' ? describe : describe.skip;

const started: ChildProcess[] = [];
const childPids: number[] = [];
const peers: Array<{ close(): Promise<void> }> = [];

/** utime + stime in clock ticks, or null once the process is gone. */
function cpuTicks(pid: number): number | null {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return null;
  }
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  return null;
}

function stageFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-orphan-'));
  cpSync(join(functionsHttpCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsHttpCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) cpSync(join(functionsHttpCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  symlinkSync(join(repoRoot, 'packages/conformance/node_modules/firebase-functions'), join(cwd, 'fixture/node_modules/firebase-functions'));
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  return cwd;
}

/** `pyric sandbox` in the fixture, a peer connected, and the Functions child serving. */
async function sandboxWithServingChild(): Promise<{ cli: ChildProcess; childPid: number }> {
  if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
  const cwd = stageFixture();
  let output = '';
  const cli = spawn('node', [cliEntry, 'sandbox', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(cli);
  cli.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  cli.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const pointer = await waitFor(() => {
    const path = join(cwd, '.pyric/serve.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { url: string }) : null;
  }, 15_000);
  if (!pointer) throw new Error(`pyric sandbox did not start:\n${output}`);
  const url = pointer.url.replace(/\/$/, '');
  const ctx = await createFunctionsWorkerHostCtx({ persistenceKeyPrefix: 'functions-orphan', instanceId: 'functions-orphan' });
  peers.push(await connectFunctionsWorkerPeer({ url: `${url.replace(/^http/, 'ws')}/__pyric/sandbox`, ctx, sandboxId: 'functions-orphan-peer' }));
  const serving = await waitFor(async () => {
    const response = await fetch(`${url}/${PROJECT_ID}/us-central1/pyricHttpEcho`).catch(() => null);
    return response?.status === 200 ? true : null;
  }, 30_000);
  if (!serving) throw new Error(`functions did not start:\n${output}`);
  const [childPid] = functionsChildrenOf(cli.pid!);
  if (childPid === undefined) throw new Error('no Functions child found under pyric sandbox');
  childPids.push(childPid);
  return { cli, childPid };
}

afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close().catch(() => undefined);
  for (const cli of started.splice(0)) if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
  // Whatever the assertions said, never leave a child behind.
  for (const pid of childPids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
});

linuxOnly('the Functions child does not outlive its parent', () => {
  test('SIGKILL of pyric sandbox ends its child within ~2 s, without spinning', async () => {
    const { cli, childPid } = await sandboxWithServingChild();
    const ticksAtKill = cpuTicks(childPid) ?? 0;
    let lastTicks = ticksAtKill;
    cli.kill('SIGKILL');
    // Sample CPU for as long as the child lives, so a child that spins and then exits still counts.
    const exited = await waitFor(() => {
      const ticks = cpuTicks(childPid);
      if (ticks !== null) lastTicks = ticks;
      return alive(childPid) ? null : true;
    }, 2_500);
    expect(exited).toBe(true);
    expect((lastTicks - ticksAtKill) / CLOCK_TICKS_PER_SECOND).toBeLessThan(0.5);
  }, 90_000);

  test('the child exits on SIGTERM while its host is still running', async () => {
    const { cli, childPid } = await sandboxWithServingChild();
    // The host is alive and the channel open, so only the child's SIGTERM handler can end it here.
    expect(cli.exitCode).toBeNull();
    expect(alive(childPid)).toBe(true);
    process.kill(childPid, 'SIGTERM');
    const exited = await waitFor(() => (alive(childPid) ? null : true), 2_500);
    expect(exited).toBe(true);
  }, 90_000);
});
