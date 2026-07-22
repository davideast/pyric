import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pyric } from '../../src/serve/vite-plugin.js';
import { resolveSiteUiDir } from '../../src/serve/bundler.js';
import { createStateStore, STATE_FILE_VERSION } from '../../src/serve/state-store.js';
import {
  bootPlugin,
  bootPluginInstance,
  callPyric,
  callPyricStack,
  initJson,
  MockRes,
  type PyricReq,
  type PyricMiddleware,
  viteEntries as entries,
  warmViteWorkerBundle,
} from './vite-plugin-harness.js';

beforeAll(async () => { await warmViteWorkerBundle(); }, 180_000);

const userImporter = '/some/app/src/main.ts';

// ── integration: the plugin works inside a REAL Vite dev server ───────────────
describe('integration — real vite dev pluginContainer', () => {
  let server: { pluginContainer: { resolveId: (s: string, i?: string) => Promise<{ id: string } | null> }; close: () => Promise<void> } | null = null;
  afterAll(async () => {
    if (server) await server.close();
  });

  it('swaps firebase/firestore and firebase/storage through Vite resolution', async () => {
    const { createServer } = await import('vite');
    server = (await createServer({
      configFile: false,
      logLevel: 'silent',
      root: path.dirname(entries.init), // any real dir; we only test resolution
      plugins: [pyric()],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
    })) as unknown as typeof server;
    const r = await server!.pluginContainer.resolveId('firebase/firestore', userImporter);
    expect(r?.id).toBe(entries.firestore);
    const storage = await server!.pluginContainer.resolveId('firebase/storage', userImporter);
    expect(storage?.id).toBe(entries.storage);
  });
});

// ── integration: the BRIDGE mounts inside a REAL Vite dev server (middlewareMode,
// binds NO port). The unit tests above drive a hand-rolled stub; this proves the
// plugin actually registers its `/__pyric` middleware into real Vite's connect
// stack AND that the real handler (closed over the real `createBridgeMount`)
// serves the bridge tier. We pull OUR layer out of `server.middlewares.stack` and
// drive it with a mock req/res — so Vite's other internal middlewares don't choke
// on the mock req, and (per the section -above lesson) we never `listen()` or `fetch()`.
// middlewareMode has no httpServer, so the WS upgrade + port-derived `bridgeUrl`
// are NOT covered here — that's the env-gated e2e (vite-plugin-bridge-e2e.test.ts).
describe('integration — bridge mounts in a real vite dev server (middlewareMode)', () => {
  let server: { middlewares: { stack: Array<{ route: string; handle: PyricMiddleware }> }; close: () => Promise<void> } | null = null;
  afterAll(async () => { if (server) await server.close(); });

  it('registers /__pyric and serves the bridge health route from real Vite', async () => {
    const { createServer } = await import('vite');
    server = (await createServer({
      configFile: false,
      logLevel: 'silent',
      root: path.dirname(entries.init), // any real dir; rules optional (no firebase.json)
      plugins: [pyric({ bridge: { disableAuditLog: true } })],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
    })) as unknown as typeof server;

    // The plugin registered its connect layer under the /__pyric mount.
    const layer = server!.middlewares.stack.find((l) => l.route === '/__pyric');
    expect(layer).toBeTruthy();

    // The bridge mount (real createBridgeMount) answers /__pyric/health.
    const health = await callPyric(layer!.handle, { path: '/__pyric/health' });
    expect(health.statusCode).toBe(200);
    expect(health.nexted).toBe(false); // handled by the mount, not passed through
    const body = JSON.parse(health.body);
    expect(body.mode).toBe('sandbox');
    expect(body.status).toBe('ok');

    // A non-bridge, non-namespace route still falls through (next()).
    const miss = await callPyric(layer!.handle, { path: '/__pyric/nope-not-a-route' });
    expect(miss.nexted).toBe(true);
  }, 60_000); // bounded: middlewareMode binds NO port, but cap it so it can't wall-clock
});

// ── integration: the /__pyric runtime surface, driven WITHOUT a real dev server ─
// WHY NO createServer/listen/fetch: spinning a real Vite dev server + fetching it
// proved fragile across environments — it HANGS in CI (Vite/esbuild teardown
// deadlock; once a 6-hour wall-clock) and ConnectionRefuses in a Linux container,
// while passing on macOS. So we run `configureServer` with a minimal stub that
// captures the `/__pyric` connect middleware, then invoke it with mock req/res.
// No port binding, no network, no dep-optimizer: deterministic + fast everywhere.
// (Real Vite *resolution* is still covered by the middlewareMode pluginContainer
// test above, which binds no port.)

describe('integration — configureServer rules prelude + the /__pyric middleware', () => {
  const RULES = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /posts/{id} { allow read: if true; }\n  }\n}\n`;
  let tmp: string;
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('serves the project rules at /__pyric/init.json, and 403s a forged Host (DNS guard)', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-cfg-'));
    writeFileSync(path.join(tmp, 'firestore.rules'), RULES);
    const handler = await bootPlugin({ rules: 'firestore.rules' }, tmp);
    const init = await initJson(handler);
    expect(init.rules).toContain('rules_version');
    expect(typeof init.rulesHash).toBe('string');
    expect(init.persist).toBe(false);
    expect(init.messaging).toBe(true);
    // DNS-rebinding guard: a forged Host is refused before the namespace runs.
    const forged = await callPyric(handler, { path: '/__pyric/init.json', host: 'evil.example' });
    expect(forged.statusCode).toBe(403);
  });

  it('serves null rules when the project has none (no firebase.json, no firestore.rules)', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-norules-'));
    expect((await initJson(await bootPlugin({}, tmp))).rules).toBeNull();
  });

  it('carries the plugin AI engine into /__pyric/init.json (→ worker ctx.aiEngine)', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-ai-'));
    const init = await initJson(
      await bootPlugin(
        { ai: { engine: { kind: 'openai', baseUrl: '/__pyric/ai-proxy', model: 'llama3.2' } } },
        tmp,
      ),
    );
    expect(init.ai).toEqual({ engine: { kind: 'openai', baseUrl: '/__pyric/ai-proxy', model: 'llama3.2' } });
  });

  it('serves ai: null in init.json when no plugin engine is configured', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-noai-'));
    expect((await initJson(await bootPlugin({}, tmp))).ai).toBeNull();
  });

  it('serves configured Storage rules and their hash in the shared init payload', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-storage-rules-'));
    writeFileSync(path.join(tmp, 'firebase.json'), JSON.stringify({
      storage: { rules: 'storage.rules' },
    }));
    writeFileSync(path.join(tmp, 'storage.rules'), `service firebase.storage {
      match /b/{bucket}/o { match /{path=**} { allow read, write: if false; } }
    }`);

    const init = await initJson(await bootPlugin({}, tmp));
    expect(init.storageRules).toContain('service firebase.storage');
    expect(typeof init.storageRulesHash).toBe('string');
  });

  it('fails fast when an explicit rules path does not exist', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-badrules-'));
    let threw = false;
    try { await bootPlugin({ rules: 'does-not-exist.rules' }, tmp); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('closeBundle disposes the session in Vite middleware mode', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-close-'));
    let handler: PyricMiddleware | undefined;
    const p = pyric({ ui: false });
    const watcher = { add() {}, on() {}, off() {} };
    await (p.configureServer as (server: unknown) => Promise<void>)({
      config: { root: tmp, logger: { info() {}, warn() {} }, server: { allowedHosts: [], host: 'localhost' } },
      middlewares: { use(route: string, candidate: PyricMiddleware) { if (route === '/__pyric') handler = candidate; } },
      watcher,
      httpServer: null,
    });
    if (!handler) throw new Error('plugin did not mount middleware');

    const request = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/__pyric/events',
      originalUrl: '/__pyric/events',
      headers: { host: 'localhost' },
    }) as unknown as PyricReq;
    const response = new MockRes();
    handler(request, response, () => {});
    await Bun.sleep(0);
    expect(response.body).toContain(': connected');
    expect(response.writableEnded).toBe(false);

    await (p.closeBundle as () => Promise<void>)();
    await (p.closeBundle as () => Promise<void>)();
    expect(response.writableEnded).toBe(true);
  });

  it('reconfiguration and closeBundle remove all Functions watcher listeners', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-reconfigure-'));
    mkdirSync(path.join(tmp, 'functions'));
    writeFileSync(path.join(tmp, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' } }));
    writeFileSync(path.join(tmp, 'functions/package.json'), JSON.stringify({ main: 'index.js' }));
    writeFileSync(path.join(tmp, 'functions/index.js'), 'module.exports = {};');
    const p = pyric({ ui: false });

    const configure = async () => {
      const watcher = new EventEmitter() as EventEmitter & { add(path: string): void };
      watcher.add = () => {};
      const httpServer = Object.assign(new EventEmitter(), {
        listening: false,
        address: () => ({ port: 5173 }),
      });
      await (p.configureServer as (server: unknown) => Promise<void>)({
        config: { root: tmp, logger: { info() {}, warn() {}, error() {} }, server: { allowedHosts: [], host: 'localhost' } },
        middlewares: { use() {} },
        watcher,
        httpServer,
      });
      return { watcher, httpServer };
    };

    const first = await configure();
    expect(first.watcher.listenerCount('change')).toBe(1);
    expect(first.watcher.listenerCount('add')).toBe(1);
    expect(first.watcher.listenerCount('unlink')).toBe(1);

    const second = await configure();
    expect(first.watcher.listenerCount('change')).toBe(0);
    expect(first.watcher.listenerCount('add')).toBe(0);
    expect(first.watcher.listenerCount('unlink')).toBe(0);
    expect(first.httpServer.listenerCount('upgrade')).toBe(0);

    await (p.closeBundle as () => Promise<void>)();
    expect(second.watcher.listenerCount('change')).toBe(0);
    expect(second.watcher.listenerCount('add')).toBe(0);
    expect(second.watcher.listenerCount('unlink')).toBe(0);
    expect(second.httpServer.listenerCount('upgrade')).toBe(0);
  });

  it('reconfiguration bypasses disposed middleware on the same Connect stack', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-middleware-generation-'));
    const p = pyric({ bridge: { disableAuditLog: true }, ui: false });
    const handlers: PyricMiddleware[] = [];
    const watcher = { add() {}, on() {}, off() {} };
    const server = {
      config: { root: tmp, logger: { info() {}, warn() {}, error() {} }, server: { allowedHosts: [], host: 'localhost' } },
      middlewares: {
        use(route: string, handler: PyricMiddleware) {
          if (route === '/__pyric') handlers.push(handler);
        },
      },
      watcher,
      httpServer: null,
    };

    await (p.configureServer as (value: unknown) => Promise<void>)(server);
    await (p.configureServer as (value: unknown) => Promise<void>)(server);
    expect(handlers).toHaveLength(2);

    const health = await callPyricStack(handlers, { path: '/__pyric/health' });
    expect(health.statusCode).toBe(200);
    expect(health.nexted).toBe(false);
    expect(JSON.parse(health.body).status).toBe('ok');
    await (p.closeBundle as () => Promise<void>)();
  });
});

// NOTE (unit): asserts the workerReady===false → in-page output in ISOLATION
// (configureServer never ran → workerReady is its initial false). The worker-READY
// branch is covered in the next block; the bundle-FAILURE catch is covered by source
// inspection (see the section 4 note at the end of this file).
