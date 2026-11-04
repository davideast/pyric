/**
 * Live mode's refusals through a real Vite dev server with `pyricLive()` and
 * Chromium. The page's own calls that live mode does not serve throw
 * `PYRIC_LIVE_REFUSED` before any request leaves: a named Firestore database
 * (Firestore points at a local server that counts every connection, and the
 * default database's read shows the counter works), the `firebase/*`
 * subpaths with no live row, and the SDK's own `@firebase/*` packages named
 * by app code, which would go around the rows. pyric's own writes are refused on the Node
 * host: an MCP tool's write, a pyric command's write over the hosted method
 * route, and a seed file at startup.
 *
 * The plan's replay-server scenario under `test/apps/` drives the same path
 * through the packed packages and the `pyric-live` command.
 */
import { createRequire } from 'node:module';
import { createServer as createNetServer, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createServer, type PluginOption, type ViteDevServer } from 'vite';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const liveDir = fileURLToPath(new URL('../../../live/', import.meta.url));
const require = createRequire(import.meta.url);
const firebaseDir = dirname(require.resolve('firebase/package.json'));

type Counter = { port: number; connections(): number; close(): Promise<void> };

/** A loopback server that counts and drops every connection. */
async function countingServer(): Promise<Counter> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return {
    port: address.port,
    connections: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function appSource(port: number): string {
  return `
import { initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, doc, getDocFromServer, getFirestore, initializeFirestore } from 'firebase/firestore';
const OPTIONS = { projectId: 'live-refusals', apiKey: 'live-refusals-key', appId: '1:1:web:1' };
const refusedApp = initializeApp(OPTIONS, 'refused');
const controlApp = initializeApp(OPTIONS, 'control');
const outcome = (call) => { try { call(); return 'returned'; } catch (error) { return error.code + ': ' + error.message; } };
window.refuseNamed = () => [
  outcome(() => getFirestore(refusedApp, 'reports')),
  outcome(() => initializeFirestore(refusedApp, { host: '127.0.0.1:${port}', ssl: false }, 'reports')),
];
window.readDefault = () => {
  const db = getFirestore(controlApp);
  connectFirestoreEmulator(db, '127.0.0.1', ${port});
  void getDocFromServer(doc(db, 'rooms/lobby')).catch(() => undefined);
  return 'sent';
};
const settle = (loading) => loading.then(() => 'loaded', (error) => error.message);
const IMPORTS = {
  'firebase/firestore/lite': () => import('firebase/firestore/lite'),
  'firebase/installations': () => import('firebase/installations'),
  'firebase/compat/app': () => import('firebase/compat/app'),
  '@firebase/firestore': () => import('@firebase/firestore'),
  '@firebase/storage': () => import('@firebase/storage'),
  '@firebase/database': () => import('@firebase/database'),
};
window.importRefused = (specifier) => settle(IMPORTS[specifier]());
// The SDK's own package, imported by name, around the live row.
window.scopedNamed = async () => {
  try {
    const scoped = await import('@firebase/firestore');
    const db = scoped.initializeFirestore(refusedApp, { host: '127.0.0.1:${port}', ssl: false }, 'reports');
    void scoped.getDocFromServer(scoped.doc(db, 'rooms/lobby')).catch(() => undefined);
    return 'served:reports';
  } catch (error) {
    return error.code + ': ' + error.message;
  }
};
document.querySelector('#status').textContent = 'Ready';
`;
}

type Project = { root: string; close(): Promise<void>; server: ViteDevServer; base: string };

async function liveProject(port: number, extra: Record<string, unknown> = {}): Promise<Project> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-refusals-')));
  mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
  symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
  symlinkSync(liveDir, join(root, 'node_modules/@pyric/live'));
  symlinkSync(firebaseDir, join(root, 'node_modules/firebase'));
  // The SDK's own packages at the top level, as a hoisted install puts them, so an app can name them.
  mkdirSync(join(root, 'node_modules/@firebase'));
  for (const name of ['firestore', 'storage', 'database']) {
    symlinkSync(join(dirname(realpathSync(firebaseDir)), '@firebase', name), join(root, 'node_modules/@firebase', name));
  }
  writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
  writeFileSync(join(root, 'main.js'), appSource(port));
  writeFileSync(join(root, 'seed.json'), JSON.stringify({ 'rooms/seeded': { v: 1 } }));
  // The plugin as the app installs it: @pyric/live, resolved from the app's own root.
  const { pyricLive } = await import(createRequire(join(root, 'package.json')).resolve('@pyric/live/vite')) as typeof import('../../../live/src/vite.js');
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      root, configFile: false, logLevel: 'silent',
      plugins: [pyricLive({ capture: false, ui: false, ...extra }) as PluginOption],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
  } catch (error) {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Vite did not expose a URL');
  const started = server;
  return {
    root, server: started, base: url.replace(/\/$/, ''),
    close: async () => {
      await started.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One JSON-RPC request to the dev server's MCP route, with the session it opened. */
function mcpClient(base: string) {
  let sessionId: string | null = null;
  return async (id: number | null, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== null) body.id = id;
    const response = await fetch(`${base}/__pyric/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    const text = await response.text();
    if (text.length === 0) return null;
    const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
    return JSON.parse(line.replace(/^data:\s*/, '')) as Record<string, unknown>;
  };
}

test("a live page's unserved calls throw before any request leaves, and pyric's own writes are refused", async ({ page }) => {
  const counter = await countingServer();
  const project = await liveProject(counter.port);
  try {
    await page.goto(project.base);
    await expect(page.locator('#status')).toHaveText('Ready');

    const named = await page.evaluate(() => (Reflect.get(window, 'refuseNamed') as () => string[])());
    expect(named).toHaveLength(2);
    for (const [index, call] of ['getFirestore', 'initializeFirestore'].entries()) {
      expect(named[index]?.startsWith('PYRIC_LIVE_REFUSED: ')).toBe(true);
      expect(named[index]).toContain(`@pyric/live: ${call} with the database "reports" is refused in live mode, from a page`);
    }
    const scoped = await page.evaluate(() => (Reflect.get(window, 'scopedNamed') as () => Promise<string>)());
    expect(scoped).toMatch(/^PYRIC_LIVE_REFUSED: /);
    expect(scoped).toContain('@pyric/live: @firebase/firestore (a Firebase SDK package; apps import firebase/firestore) is refused in live mode');
    await page.waitForTimeout(300);
    expect(counter.connections()).toBe(0);
    await page.evaluate(() => (Reflect.get(window, 'readDefault') as () => string)());
    await expect.poll(() => counter.connections(), { timeout: 10_000 }).toBeGreaterThan(0);

    const importRefused = (specifier: string) =>
      page.evaluate((name) => (Reflect.get(window, 'importRefused') as (s: string) => Promise<string>)(name), specifier);
    const refusedImports = [
      'firebase/firestore/lite', 'firebase/installations', 'firebase/compat/app',
      '@firebase/firestore', '@firebase/storage', '@firebase/database',
    ];
    for (const specifier of refusedImports) {
      expect(await importRefused(specifier)).toContain(`${specifier} `);
      expect(await importRefused(specifier)).toContain('is refused in live mode');
    }

    const mcp = mcpClient(project.base);
    await mcp(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-refusals', version: '0' } });
    await mcp(null, 'notifications/initialized');
    const call = await mcp(2, 'tools/call', { name: 'firestore_create_document', arguments: { path: 'rooms/agent', data: { v: 1 } } });
    expect(JSON.stringify(call)).toContain('firestore_create_document from an MCP tool is refused in live mode');

    const health = await (await fetch(`${project.base}/__pyric/health`)).json() as { instanceId: string };
    const method = await fetch(`${project.base}/__pyric/hosted/method`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: health.instanceId, projectDir: project.root, key: 'firestore.setDoc', args: { path: 'rooms/cli', data: { v: 1 } } }),
    });
    const result = await method.json() as { ok: boolean; summary: string; data?: { code?: string } };
    expect(result.ok).toBe(false);
    expect(result.data?.code).toBe('PYRIC_LIVE_REFUSED');
    expect(result.summary).toContain('firestore.setDoc from a pyric command is refused in live mode');
  } finally {
    await page.close();
    await project.close();
    await counter.close();
  }
});

test('a live dev server started with a seed file is refused before it serves', async () => {
  const counter = await countingServer();
  try {
    const started = liveProject(counter.port, { seed: 'seed.json' });
    await expect(started).rejects.toThrow('seed seed.json from the seed file is refused in live mode');
    await started.catch((error: Error & { code?: string }) => expect(error.code).toBe('PYRIC_LIVE_REFUSED'));
  } finally {
    await counter.close();
  }
});
