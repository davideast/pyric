/**
 * Vite-plugin parity for RTDB-triggered Cloud Functions — the same slice
 * `pyric dev` runs (`onValueCreated`), now reachable under `pyric()`.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { bundleWorker, workerSourceHash } from '../../src/serve/bundler.js';
import { discoverFunctionsRtdbProject } from '../../src/functions-rtdb/project.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { connectFunctionsWorkerPeer, createFunctionsWorkerHostCtx } from '../functions-rtdb/worker-peer.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const builtChild = join(cliRoot, 'dist/functions-rtdb/child.js');

let server: ViteDevServer | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;

/** A real ephemeral port. Vite treats `port: 0` as "unset" and defaults to
 *  5173, so any dev server already on 5173 (another project's `vite dev`)
 *  wedges these tests — observed in the field. Bind-and-release instead. */
async function freePort(): Promise<number> {
  const { createServer: createNetServer } = await import('node:net');
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

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

describe('pyric() Functions RTDB parity', () => {
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
        plugins: [pyric({ ui: false })],
        server: { port: await freePort(), strictPort: true, host: '127.0.0.1' },
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
    const pointer = JSON.parse(readFileSync(join(cwd, '.pyric', 'serve.json'), 'utf8')) as {
      project: string;
    };
    expect(pointer.project).toBe('demo-project');

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
    // The RTDB write and the child's IPC execution event travel back to this
    // process independently. The observable effect may therefore arrive one
    // turn before Vite's logger records the completed export.
    await waitFor(() => logs.some((l) => l.includes('makeUppercase')) ? true : null);

    // Topology pin (functions block present, NO explicit `bridge` option): the
    // functions-forced bridge mount must not flip the page onto the in-page
    // sandbox. The served page stays on the SharedWorker path — worker version
    // meta, no `__PYRIC_FORCE_INPAGE__` — and the init payload carries the
    // bridge WS URL the worker-path peer relays agent/functions traffic through.
    const html = await server.transformIndexHtml(
      '/index.html',
      '<html><head></head><body></body></html>',
    );
    expect(html).toContain('pyric-worker-v');
    expect(html).not.toContain('__PYRIC_FORCE_INPAGE__');
    const init = (await (await fetch(`${base}/__pyric/init.json`)).json()) as {
      bridgeUrl: string | null;
    };
    expect(init.bridgeUrl).toStartWith('ws://');
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
        plugins: [pyric({ ui: false })],
        server: { port: await freePort(), strictPort: true, host: '127.0.0.1' },
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

  test('functions: false suppresses discovery, the child, and the functions-forced bridge mount', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-vite-functions-off-'));
    mkdirSync(join(cwd, 'public'));
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
    // A functions block whose source dir does NOT exist: discovery would throw
    // at dev-server start, so a clean start is proof discovery never ran.
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'public' }, functions: { source: 'functions' } }),
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
        plugins: [pyric({ ui: false, functions: false })],
        server: { port: await freePort(), strictPort: true, host: '127.0.0.1' },
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
    await new Promise((r) => setTimeout(r, 300));

    // No bridge mount was forced on functions' behalf: no serve.json pointer,
    // and no functions banner ever logged.
    expect(existsSync(join(cwd, '.pyric', 'serve.json'))).toBe(false);
    expect(logs.some((l) => l.includes('onValueCreated'))).toBe(false);
  }, 40_000);

  test('region/instance options flow to the child, and a save hot-reloads it (redeploy semantics)', async () => {
    if (!existsSync(builtChild)) throw new Error(`build the CLI first: ${builtChild}`);
    await withTimeout(
      bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) }),
      180_000,
      'bundleWorker',
    );

    const cwd = mkdtempSync(join(tmpdir(), 'pyric-vite-functions-reload-'));
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
      JSON.stringify({ name: 'vite-functions-reload', private: true, type: 'commonjs', main: 'index.cjs' }),
    );
    const entry = join(cwd, 'functions/index.cjs');
    // v1 echoes the event's instance + location back into the tree — the only
    // observable spot the plugin's `functions: { region, instance }` reaches.
    writeFileSync(
      entry,
      `const { onValueCreated } = require('firebase-functions/v2/database');
exports.echoMeta = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('meta')
    .set(event.instance + '|' + event.location),
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
        plugins: [
          pyric({
            ui: false,
            functions: { region: 'europe-west1', instance: 'custom-instance' },
          }),
        ],
        server: { port: await freePort(), strictPort: true, host: '127.0.0.1' },
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
    const base = `http://127.0.0.1:${port}`;
    peer = await withTimeout(connectWorkerPeer(`${base.replace(/^http/, 'ws')}/__pyric/sandbox`), 10_000, 'peer');
    observer = await withTimeout(connectRemoteSandbox({ url: base }), 10_000, 'observer');
    await waitFor(() => logs.some((l) => l.includes('onValueCreated')) ? true : null, 20_000);

    // Option flow: the trigger observes the plugin-configured instance/region.
    await observer.rtdb.set('messages/m1/original', 'x');
    await waitFor(
      async () => (await observer!.rtdb.get('messages/m1/meta')) === 'custom-instance|europe-west1' ? true : null,
      15_000,
    );

    // Hot reload: two rapid saves coalesce (300ms debounce) into ONE restart.
    const reloadCount = (): number => logs.filter((l) => l.includes('functions reloaded')).length;
    writeFileSync(
      entry,
      `const { onValueCreated } = require('firebase-functions/v2/database');
exports.echoMeta = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('meta').set('v2:' + event.data.val()),
);
`,
    );
    writeFileSync(entry, readFileSync(entry)); // second save inside the debounce window
    await waitFor(() => (reloadCount() >= 1 ? true : null), 20_000);
    await new Promise((r) => setTimeout(r, 700)); // past any second debounce
    expect(reloadCount()).toBe(1);
    expect(logs.some((l) => l.includes('functions reloaded (1 trigger)'))).toBe(true);

    // The NEW module serves post-reload writes (redeploy semantics: m1's data
    // is the new child's baseline and did not re-fire).
    await observer.rtdb.set('messages/m2/original', 'y');
    await waitFor(
      async () => (await observer!.rtdb.get('messages/m2/meta')) === 'v2:y' ? true : null,
      15_000,
    );

    // Broken save: the old child is gone, so functions go DOWN (no last-good).
    writeFileSync(entry, `throw new Error('boom');\n`);
    await waitFor(
      () => logs.some((l) => l.includes('functions are down until the next good save')) ? true : null,
      20_000,
    );

    // Next good save recovers.
    writeFileSync(
      entry,
      `const { onValueCreated } = require('firebase-functions/v2/database');
exports.echoMeta = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('meta').set('v3:' + event.data.val()),
);
`,
    );
    await waitFor(() => (reloadCount() >= 2 ? true : null), 20_000);
    await observer.rtdb.set('messages/m3/original', 'z');
    await waitFor(
      async () => (await observer!.rtdb.get('messages/m3/meta')) === 'v3:z' ? true : null,
      15_000,
    );
  }, 120_000);

  test('functions: { watch: false } disables hot-reload', async () => {
    if (!existsSync(builtChild)) throw new Error(`build the CLI first: ${builtChild}`);
    await withTimeout(
      bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) }),
      180_000,
      'bundleWorker',
    );

    const cwd = mkdtempSync(join(tmpdir(), 'pyric-vite-functions-nowatch-'));
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
      JSON.stringify({ name: 'vite-functions-nowatch', private: true, type: 'commonjs', main: 'index.cjs' }),
    );
    const entry = join(cwd, 'functions/index.cjs');
    writeFileSync(
      entry,
      `const { onValueCreated } = require('firebase-functions/v2/database');
exports.noop = onValueCreated('/messages/{pushId}/original', () => {});
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
        plugins: [pyric({ ui: false, functions: { watch: false } })],
        server: { port: await freePort(), strictPort: true, host: '127.0.0.1' },
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
    const base = `http://127.0.0.1:${port}`;
    peer = await withTimeout(connectWorkerPeer(`${base.replace(/^http/, 'ws')}/__pyric/sandbox`), 10_000, 'peer');
    await waitFor(() => logs.some((l) => l.includes('onValueCreated')) ? true : null, 20_000);

    // A save must NOT restart the child. Write the file AND drive the watcher
    // directly (belt and braces against fs-event latency), then give a full
    // debounce-plus-respawn window to elapse.
    writeFileSync(entry, readFileSync(entry));
    server.watcher.emit('change', entry);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(logs.filter((l) => l.includes('functions reloaded')).length).toBe(0);
    expect(logs.filter((l) => l.includes('onValueCreated')).length).toBe(1);
  }, 60_000);
});
