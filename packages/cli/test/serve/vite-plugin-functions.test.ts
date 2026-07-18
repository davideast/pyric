/**
 * Vite-plugin parity for RTDB-triggered Cloud Functions — the same slice
 * `pyric dev` runs (`onValueCreated`), now reachable under `pyricSandbox()`.
 *
 * Mirrors `test/functions-rtdb/dev.e2e.test.ts`, but drives the plugin instead
 * of the CLI: a REAL Vite dev server listens, a worker-relay peer stands in for
 * the browser SharedWorker (so the plugin sees a connected sandbox and spawns
 * the Functions child), and an observer RemoteSandbox writes RTDB + reads the
 * trigger's effect back. The Functions child runs the UNCHANGED functions
 * module in an isolated node process, exactly as `pyric dev` does — so this
 * needs the built package (dist child + register loader), like `dev.e2e`.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { bundleWorker, workerSourceHash } from '../../src/serve/bundler.js';
import { discoverFunctionsRtdbProject } from '../../src/functions-rtdb/project.js';
import { pyricSandbox } from '../../src/serve/vite-plugin.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { connectFunctionsWorkerPeer, createFunctionsWorkerHostCtx } from '../functions-rtdb/worker-peer.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const builtChild = join(cliRoot, 'dist/functions-rtdb/child.js');

let server: ViteDevServer | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), guard]);
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for the plugin Functions outcome');
}

async function connectWorkerPeer(url: string): Promise<{ close(): Promise<void> }> {
  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'vite-functions',
    instanceId: 'vite-functions-e2e',
  });
  return connectFunctionsWorkerPeer({ url, ctx, sandboxId: 'vite-functions-peer' });
}

function portOf(dev: ViteDevServer): number {
  const addr = dev.httpServer?.address();
  return addr && typeof addr === 'object' ? addr.port : 0;
}

afterEach(async () => {
  observer?.close();
  observer = undefined;
  await peer?.close().catch(() => {});
  peer = undefined;
  await server?.close().catch(() => {});
  server = undefined;
});

describe('pyricSandbox() Functions RTDB parity', () => {
  test('discovers a functions codebase and fires an onValueCreated trigger through the plugin', async () => {
    if (!existsSync(builtChild)) throw new Error(`build the CLI first: ${builtChild}`);
    // Warm the SharedWorker bundle so configureServer's bundleWorker is a cache hit.
    await withTimeout(
      bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) }),
      180_000,
      'bundleWorker',
    );

    const cwd = mkdtempSync(join(tmpdir(), 'pyric-vite-functions-'));
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
      JSON.stringify({ name: 'vite-functions', private: true, type: 'commonjs', main: 'index.cjs' }),
    );
    writeFileSync(
      join(cwd, 'functions/index.cjs'),
      `const { onValueCreated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('uppercase')
    .set(event.data.val().toUpperCase()),
);
`,
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(cwd, 'functions/node_modules/firebase-functions'),
    );

    const logs: string[] = [];
    const record = (msg: string): void => { logs.push(msg); };

    const { createServer } = await import('vite');
    server = await withTimeout(
      createServer({
        appType: 'custom',
        configFile: false,
        logLevel: 'silent',
        root: cwd,
        plugins: [pyricSandbox({ ui: false })],
        server: { port: 0, host: '127.0.0.1' },
        optimizeDeps: { noDiscovery: true },
        customLogger: {
          info: record,
          warn: record,
          warnOnce: record,
          error: record,
          clearScreen: () => {},
          hasErrorLogged: () => false,
          hasWarned: false,
        },
      }),
      30_000,
      'createServer',
    );
    await withTimeout(server.listen(), 15_000, 'listen');
    const port = portOf(server);
    expect(port).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;

    // The worker-relay peer is the sandbox source of truth (the SharedWorker in
    // a real browser). Connecting it flips sandboxConnected → the plugin spawns
    // the Functions child.
    peer = await withTimeout(connectWorkerPeer(`${base.replace(/^http/, 'ws')}/__pyric/sandbox`), 10_000, 'peer');
    observer = await withTimeout(connectRemoteSandbox({ url: base }), 10_000, 'observer');

    // The child must reach "ready" (baseline subscribed) before the create — a
    // write observed before baseline is folded into the baseline, not a create.
    await waitFor(() => logs.some((l) => l.includes('onValueCreated')) ? true : null, 20_000);

    await observer.rtdb.set('messages/id/original', 'hello');
    const upper = await waitFor(
      async () => (await observer!.rtdb.get('messages/id/uppercase')) === 'HELLO' ? true : null,
      15_000,
    );
    expect(upper).toBe(true);
    expect(logs.some((l) => l.includes('makeUppercase'))).toBe(true);
  }, 60_000);

  test('with no functions config, nothing mounts (no bridge pointer, no functions child)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-vite-nofunctions-'));
    mkdirSync(join(cwd, 'public'));
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));

    // Discovery itself is silent-off without a `functions` block.
    expect(discoverFunctionsRtdbProject(cwd)).toBeNull();

    const logs: string[] = [];
    const record = (msg: string): void => { logs.push(msg); };
    const { createServer } = await import('vite');
    server = await withTimeout(
      createServer({
        appType: 'custom',
        configFile: false,
        logLevel: 'silent',
        root: cwd,
        plugins: [pyricSandbox({ ui: false })],
        server: { port: 0, host: '127.0.0.1' },
        optimizeDeps: { noDiscovery: true },
        customLogger: {
          info: record,
          warn: record,
          warnOnce: record,
          error: record,
          clearScreen: () => {},
          hasErrorLogged: () => false,
          hasWarned: false,
        },
      }),
      30_000,
      'createServer',
    );
    await withTimeout(server.listen(), 15_000, 'listen');
    // Give any (erroneous) after-listen mount a beat to write its pointer.
    await new Promise((r) => setTimeout(r, 300));

    // No functions + no bridge ⇒ no bridge mount ⇒ no serve.json pointer and no
    // functions banner. The bridge pointer is the observable "something mounted".
    expect(existsSync(join(cwd, '.pyric', 'serve.json'))).toBe(false);
    expect(logs.some((l) => l.includes('onValueCreated'))).toBe(false);
  }, 40_000);
});
