/**
 * Focused regression suite for issue #1543: `pyric sandbox` Functions RTDB
 * clean SIGTERM stop within 5,000 ms when peers remain connected or a child
 * handler/close path stalls.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_TEARDOWN_DEADLINE_MS,
  runBoundedTeardown,
} from '../../src/cli/sandbox-process-guard.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { buildChildEnv } from '../../src/cli/sandbox-runner.js';
import { trackTempDirs } from '../use-temp-dirs.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from './worker-peer.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const registerUrl = new URL('../../dist/register/index.js', import.meta.url).href;
const childModuleUrl = new URL('../../dist/functions/child.js', import.meta.url);
const tempDirs = trackTempDirs('pyric-1543-');

let activeCommand: ChildProcess | undefined;
let activeChild: FunctionsChildHandle | undefined;
let activePeer: { close(): Promise<void> } | undefined;
let activeObserver: RemoteSandbox | undefined;
let activeRuntime: ServeRuntime | undefined;

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error('timed out waiting for #1543 condition');
}

function writeWedgedFunctionsProject(cwd: string): string {
  mkdirSync(join(cwd, 'public'));
  mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
  writeFileSync(
    join(cwd, 'firebase.json'),
    JSON.stringify({ hosting: { public: 'public' }, functions: { source: 'functions' } }),
  );
  writeFileSync(
    join(cwd, 'functions/package.json'),
    JSON.stringify({ name: 'wedged-functions', private: true, type: 'commonjs', main: 'index.cjs' }),
  );
  const entry = join(cwd, 'functions/index.cjs');
  writeFileSync(
    entry,
    `const { onValueCreated } = require('firebase-functions/v2/database');
const keepLoopOpen = setInterval(() => {}, 10_000);
void keepLoopOpen;
exports.stallOnCreate = onValueCreated(
  '/jobs/{jobId}/input',
  async (event) => {
    await event.data.ref.parent.child('started').set(true);
    await new Promise(() => {});
  },
);
`,
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'functions/node_modules/firebase-functions'),
  );
  return entry;
}

afterEach(async () => {
  activeObserver?.close();
  activeObserver = undefined;
  if (activePeer !== undefined) {
    await activePeer.close().catch((error: unknown) => { void error; });
    activePeer = undefined;
  }
  if (activeChild !== undefined) {
    await activeChild.stop().catch((error: unknown) => { void error; });
    activeChild = undefined;
  }
  if (activeRuntime !== undefined) {
    await activeRuntime.handle.stop().catch((error: unknown) => { void error; });
    activeRuntime = undefined;
  }
  if (activeCommand !== undefined && activeCommand.exitCode === null) {
    activeCommand.kill('SIGKILL');
  }
  activeCommand = undefined;
  tempDirs.cleanupTempDirs();
});

describe('#1543 clean SIGTERM shutdown guarantees', () => {
  test('DEFAULT_TEARDOWN_DEADLINE_MS leaves >= 1,000 ms margin inside 5,000 ms SIGTERM budget', async () => {
    expect(DEFAULT_TEARDOWN_DEADLINE_MS).toBeLessThanOrEqual(4_000);
    const start = performance.now();
    await runBoundedTeardown(() => new Promise<void>(() => {}), 120);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });

  test('IPC stop exits cleanly with code 0 before SIGKILL when an in-flight trigger wedges close()', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
    const cwd = tempDirs.makeTempDir('pyric-1543-child-stop-');
    const entry = writeWedgedFunctionsProject(cwd);

    activeRuntime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      bridge: true,
      capture: false,
      watch: false,
    });
    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-1543-unit',
      instanceId: 'functions-1543-unit',
    });
    activePeer = await connectFunctionsWorkerPeer({
      url: `${activeRuntime.handle.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-1543-peer',
      cwd,
    });
    activeObserver = await connectRemoteSandbox({ url: activeRuntime.handle.url, cwd });

    activeChild = spawnFunctionsChild({
      cwd: join(cwd, 'functions'),
      entry,
      env: buildChildEnv(process.env, {
        serveUrl: activeRuntime.handle.url,
        registerUrl,
        beaconToken: activeRuntime.beaconToken,
        instanceId: activeRuntime.instanceId,
        sessionToken: activeRuntime.sessionToken,
      }),
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      projectId: 'demo-project',
      childModuleUrl,
    });
    await activeChild.ready;

    await activeObserver.rtdb.set('jobs/j1/input', 'run');
    await waitFor(async () => {
      if (activeObserver === undefined) return null;
      const started = await activeObserver.rtdb.get('jobs/j1/started');
      return started === true ? true : null;
    });

    const stopStart = performance.now();
    const exitCode = await activeChild.stop();
    const stopElapsed = performance.now() - stopStart;
    expect(exitCode).toBe(0);
    expect(stopElapsed).toBeLessThan(1_950);
  }, 25_000);

  test('pyric sandbox exits 0 within 5s of SIGTERM with connected peers and a wedged trigger', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
    const cwd = tempDirs.makeTempDir('pyric-1543-e2e-');
    writeWedgedFunctionsProject(cwd);

    let stdout = '';
    let stderr = '';
    activeCommand = spawn(
      'node',
      [cliEntry, 'sandbox', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    activeCommand.stdout?.setEncoding('utf8');
    activeCommand.stderr?.setEncoding('utf8');
    activeCommand.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    activeCommand.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    const pointer = await waitFor(() => {
      const pointerPath = join(cwd, '.pyric/serve.json');
      if (!existsSync(pointerPath)) return null;
      return JSON.parse(readFileSync(pointerPath, 'utf8')) as { url: string };
    });
    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-1543-e2e',
      instanceId: 'functions-1543-e2e',
    });
    activePeer = await connectFunctionsWorkerPeer({
      url: `${pointer.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
      ctx,
      sandboxId: 'functions-1543-e2e-peer',
      cwd,
    });
    activeObserver = await connectRemoteSandbox({ url: pointer.url, cwd });
    await waitFor(() => (stdout.includes('1 onValueCreated trigger') ? true : null));

    await activeObserver.rtdb.set('jobs/j1/input', 'go');
    await waitFor(async () => {
      if (activeObserver === undefined) return null;
      const started = await activeObserver.rtdb.get('jobs/j1/started');
      return started === true ? true : null;
    });

    const commandToStop = activeCommand;
    commandToStop.kill('SIGTERM');
    const code = await Promise.race([
      new Promise<number>((resolveExit) => {
        commandToStop.once('exit', (exit) => resolveExit(exit ?? 1));
      }),
      Bun.sleep(5_000).then(() => -1),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('Shutting down...');
    expect(stderr).not.toContain('Functions child exited unexpectedly');
  }, 30_000);
});
