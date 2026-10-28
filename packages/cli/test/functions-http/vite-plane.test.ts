/**
 * The Vite plane of functions-http: a real Vite dev server with `pyric()`
 * serves the unchanged capture fixture through its middleware stack, the same
 * routes `pyric sandbox` serves (oracle-conformance.test.ts drives that plane).
 * Needs the built CLI child, like `test/serve/vite-plugin-functions.test.ts`.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { functionsHttpCaptureDir } from '@pyric/conformance/functions-http-fixture';
import { doc, getDoc } from 'pyric/firestore';
import { bundleWorker, workerSourceHash } from '../../src/serve/bundler.js';
import { pyric } from '../../src/serve/vite-plugin.js';
import { connectFunctionsWorkerPeer, createFunctionsWorkerHostCtx } from '../functions-rtdb/worker-peer.js';
import { killFunctionsChildren } from './children.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const builtChild = join(cliRoot, 'dist/functions/child.js');
const PROJECT_ID = 'demo-functions-http';
const ALLOW_ALL_FIRESTORE = "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{document=**} { allow read, write: if true; } } }";

let server: ViteDevServer | undefined;
let peer: { close(): Promise<void> } | undefined;

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitFor(read: () => Promise<boolean>, timeoutMs: number, logs: readonly string[]): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out; dev server logs:\n${logs.slice(-30).join('\n')}`);
}

function stageFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-http-vite-'));
  cpSync(join(functionsHttpCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsHttpCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) {
    cpSync(join(functionsHttpCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  }
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'fixture/node_modules/firebase-functions'),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  // Under the /api/** rewrite, to show a file answers before the rewrite does.
  mkdirSync(join(cwd, 'api'));
  writeFileSync(join(cwd, 'api/static.txt'), 'a static file under /api');
  return cwd;
}

afterAll(async () => {
  await peer?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  // The plugin runs in this process, so its Functions child is this process's child.
  killFunctionsChildren(process.pid);
});

describe('functions-http on the Vite plane', () => {
  test('pyric() serves onRequest functions at the emulator path, 503 before a peer connects', async () => {
    if (!existsSync(builtChild)) throw new Error(`build the CLI first: ${builtChild}`);
    await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
    const cwd = stageFixture();
    const logs: string[] = [];
    const record = (message: string): void => { logs.push(message); };
    const { createServer } = await import('vite');
    server = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      root: cwd,
      plugins: [pyric({ ui: false })],
      server: { port: await freePort(), strictPort: true, host: '127.0.0.1' },
      optimizeDeps: { noDiscovery: true },
      customLogger: { info: record, warn: record, warnOnce: record, error: record, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;
    const echoUrl = `${base}/${PROJECT_ID}/us-central1/pyricHttpEcho`;

    for (const url of [echoUrl, `${base}/api/before-peer`]) {
      const beforePeer = await fetch(url);
      expect(beforePeer.status).toBe(503);
      expect(await beforePeer.text()).toMatch(/browser tab/);
    }

    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'functions-http-vite',
      instanceId: 'functions-http-vite',
      firestoreRules: ALLOW_ALL_FIRESTORE,
    });
    peer = await connectFunctionsWorkerPeer({ url: `${base.replace(/^http/, 'ws')}/__pyric/sandbox`, ctx, sandboxId: 'functions-http-vite-peer' });
    await waitFor(async () => (await fetch(echoUrl)).status === 200, 30_000, logs);

    const posted = await fetch(`${echoUrl}/items?x=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({ method: 'POST', path: '/items', url: '/items?x=1', query: { x: '1' }, body: { a: 1 } });

    expect((await fetch(`${base}/${PROJECT_ID}/us-east1/pyricHttpRegional`)).status).toBe(200);
    expect((await fetch(`${base}/${PROJECT_ID}/us-east1/pyricHttpEcho`)).status).toBe(404);

    const id = `vite-${Date.now()}`;
    expect((await fetch(`${echoUrl}?adminWrite=${id}`)).status).toBe(200);
    const written = await getDoc(doc(ctx.db, `pyric_oracle_http/${id}`));
    expect(written.data()).toEqual({ writtenBy: 'pyricHttpEcho', id });

    // An exception thrown from a timer after the response is caught in the child (owner decision,
    // functions-http#12): the same process answers the next request.
    const uncaughtUrl = `${base}/${PROJECT_ID}/us-central1/pyricHttpUncaught`;
    const before = (await (await fetch(uncaughtUrl)).json()) as { instanceId: string };
    expect((await fetch(`${uncaughtUrl}?mode=after-response`)).status).toBe(200);
    await Bun.sleep(300);
    const after = await fetch(uncaughtUrl);
    expect(after.status).toBe(200);
    expect(((await after.json()) as { instanceId: string }).instanceId).toBe(before.instanceId);
    expect(logs.some((line) => line.includes('PYRIC_EXPECTED_ONREQUEST_UNCAUGHT'))).toBe(true);

    // firebase.json rewrites /api/** to pyricHttpEcho; the function sees the full original URL.
    const rewritten = await fetch(`${base}/api/items/7?y=2`, { headers: { cookie: 'drop=1; __session=keep' } });
    expect(rewritten.status).toBe(200);
    expect(await rewritten.json()).toMatchObject({ path: '/api/items/7', url: '/api/items/7?y=2', headerValues: { cookie: '__session=keep' } });
    // A file the dev server serves wins over a rewrite that matches its path.
    const file = await fetch(`${base}/api/static.txt`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('a static file under /api');

    expect(logs.some((line) => line.includes('onRequest function'))).toBe(true);
    // One execution record per served request (functions-http#21).
    // A line is written when the response closes, which can trail the body the client read.
    // The line names the path only; the query string can carry tokens.
    for (const record of ['pyricHttpEcho ← POST /items 200', 'pyricHttpEcho ← GET /api/items/7 200']) {
      const lines = () => logs.filter((line) => line.includes(record));
      await waitFor(async () => lines().length > 0, 5_000, logs);
      expect(lines()).toHaveLength(1);
    }
  }, 240_000);
});
