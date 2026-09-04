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
  type PyricMiddleware,
  viteEntries as entries,
  warmViteWorkerBundle,
} from './vite-plugin-harness.js';

beforeAll(async () => { await warmViteWorkerBundle(); }, 180_000);

const plugin = pyric();

describe('M2 — transformIndexHtml in-page output (workerReady false, configureServer not run)', () => {
  it('forces the in-page path when workerReady is false', () => {
    const out = (plugin.transformIndexHtml as (h: string) => string)('<html><head></head></html>');
    expect(out).toContain('__PYRIC_FORCE_INPAGE__'); // in-page fallback
    expect(out).not.toContain('pyric-worker-v'); // no worker stamp
    expect(out).toContain(entries.init); // still boots the sandbox
  });
});

describe('M2 — worker bundle + persist (via the /__pyric middleware)', () => {
  let tmp: string;
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('serves the SharedWorker bundle at /__pyric/sdk/worker.js', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-worker-'));
    const handler = await bootPlugin({}, tmp);
    const w = await callPyric(handler, { path: '/__pyric/sdk/worker.js' });
    expect(w.statusCode).toBe(200);
    expect(w.body.length).toBeGreaterThan(1000); // the real (large) worker bundle, streamed via pipe
  });

  it('stamps the worker version into the page when the bundle is ready (transformIndexHtml worker path)', async () => {
    // Drive configureServer with a stub so the worker bundle (cache-warmed in
    // beforeAll) flips workerReady=true, then assert the transformIndexHtml output.
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-stamp-'));
    const p = pyric({});
    const stub = {
      config: { root: tmp, logger: { info() {}, warn() {} }, server: { allowedHosts: [], host: 'localhost' } },
      middlewares: { use() {} },
      watcher: { add() {}, on() {} },
    };
    await (p.configureServer as (s: unknown) => Promise<void>)(stub);
    const html = (p.transformIndexHtml as (h: string) => string)('<html><head></head></html>');
    expect(html).toContain('pyric-worker-v'); // staleness stamp ⇒ worker path active
    expect(html).not.toContain('__PYRIC_FORCE_INPAGE__'); // NOT the in-page fallback
    expect(html).toContain(entries.init); // boots the sandbox
  });

  it('changes the worker version when the configured AI model changes', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-ai-epoch-'));
    const first = await bootPluginInstance({ ai: { model: 'model-a' } }, tmp);
    const second = await bootPluginInstance({ ai: { model: 'model-b' } }, tmp);

    expect((await initJson(first.handler)).ai.engine.model).toBe('model-a');
    expect((await initJson(second.handler)).ai.engine.model).toBe('model-b');

    const htmlFor = (p: ReturnType<typeof pyric>): string =>
      (p.transformIndexHtml as (h: string) => string)('<html><head></head></html>');
    const epochFrom = (html: string): string | undefined =>
      html.match(/name="pyric-worker-v" content="([^"]+)"/)?.[1];

    const firstEpoch = epochFrom(htmlFor(first.plugin));
    const secondEpoch = epochFrom(htmlFor(second.plugin));
    expect(firstEpoch).toBeTruthy();
    expect(secondEpoch).toBeTruthy();
    expect(secondEpoch).not.toBe(firstEpoch);
  });
  it('persist mounts the /__pyric/state channel and sets persist in the payload', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-persist-'));
    const handler = await bootPlugin({ persist: true }, tmp);
    const init = await initJson(handler);
    expect(init.persist).toBe(true); // persist wired into the payload
    // A PUT heartbeat claims the writer lock → 204 proves the state route is mounted.
    const put = await callPyric(handler, { method: 'PUT', path: '/__pyric/state', headers: { 'x-pyric-writer': 'test', 'x-pyric-session-token': init.sessionToken as string } });
    expect(put.statusCode).toBe(204);
  });

  it('without persist, the payload reports persist:false and the state route is unmounted', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-nopersist-'));
    const handler = await bootPlugin({}, tmp);
    expect((await initJson(handler)).persist).toBe(false);
    // /__pyric/state is unmounted → the middleware passes through (next()) → 404 in a real server.
    const put = await callPyric(handler, { method: 'PUT', path: '/__pyric/state', headers: { 'x-pyric-writer': 'test' } });
    expect(put.nexted).toBe(true);
  });
});

// ── M2: seed orchestration + persist validation ──────────────────────────────
// The diff's subtlest logic (seed precedence — invariant #3) + the eager
// state.load() fail-fast (the corrupt-file HIGH) — the paths the first review pass
// found unguarded. (Bundle-failure fallback — invariant #4 — is covered by source
// inspection; see the note at the end.)
describe('M2 — seed precedence + persist validation', () => {
  let tmp: string;
  const writeSeed = (obj: unknown): string => {
    writeFileSync(path.join(tmp, 'seed.json'), JSON.stringify(obj));
    return 'seed.json';
  };
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('keeps the existing Vite policy where fresh without persist is inert', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-fresh-inert-'));
    const init = await initJson(await bootPlugin({ fresh: true }, tmp));
    expect(init.persist).toBe(false);
  });

  it('seed as a bare "collection/doc" map (no persist) → payload.seed IS the map', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-seedmap-'));
    const map = { 'posts/p1': { title: 'hello' } };
    const init = await initJson(await bootPlugin({ seed: writeSeed(map) }, tmp));
    expect(init.seed).toEqual(map); // a bare map flows through verbatim as `seed`
    expect(init.seedState).toBeNull(); // NOT detected as a state-file envelope
    expect(init.persist).toBe(false);
  });

  it('seed as a state-file envelope (no persist) → seedState + authUsers, seed null', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-seedenv-'));
    const blob = { firestore: { 'posts/p1': { title: 'from-fixture' } } };
    const users = [{ uid: 'u1', email: 'u1@example.test' }];
    const init = await initJson(await bootPlugin({ seed: writeSeed({ version: STATE_FILE_VERSION, firestore: blob, auth: { users } }) }, tmp));
    expect(init.seed).toBeNull(); // an envelope is NOT a bare map
    expect(init.seedState).toEqual(blob); // firestore blob staged for in-page restore
    expect(init.authUsers).toEqual(users); // users staged
    expect(init.persist).toBe(false);
  });

  it('persist + envelope seed, FIRST run → primes the durable store; payload reads lived state', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-seedprime-'));
    const users = [{ uid: 'seed-user' }];
    const init = await initJson(await bootPlugin({ persist: true, seed: writeSeed({ version: STATE_FILE_VERSION, firestore: null, auth: { users } }) }, tmp));
    expect(init.persist).toBe(true);
    expect(init.seed).toBeNull(); // state now exists → the seed is inert
    expect(init.authUsers).toEqual(users); // primed into the store, read back out
    expect(existsSync(createStateStore(tmp).path)).toBe(true); // the prime wrote the file
  });

  it('precedence (invariant #3): lived persist state WINS over a seed on a re-run', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-seedprec-'));
    // A prior run already persisted a different user set.
    createStateStore(tmp).writeSection('auth', { users: [{ uid: 'lived-user' }] });
    const init = await initJson(await bootPlugin({ persist: true, seed: writeSeed({ version: STATE_FILE_VERSION, firestore: null, auth: { users: [{ uid: 'seed-user' }] } }) }, tmp));
    expect(init.seed).toBeNull();
    // The load-bearing assertion: lived state, NOT the seed's user.
    expect(init.authUsers).toEqual([{ uid: 'lived-user' }]);
  });

  it('persist + a version-mismatched state file FAILS THE START (eager load, fail-fast)', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-corrupt-'));
    // Plant a version-mismatched state file: the eager state.load() must throw
    // StateFileError at startup, NOT silently serve ephemeral (the HIGH the
    // first review pass caught — a deferred parse surfaced as a half-written 200).
    const store = createStateStore(tmp);
    mkdirSync(path.dirname(store.path), { recursive: true });
    writeFileSync(store.path, JSON.stringify({ version: 'NOPE-wrong-version', firestore: null, auth: null }));
    let threw = false;
    try { await bootPlugin({ persist: true }, tmp); } catch { threw = true; }
    expect(threw).toBe(true); // the corrupt file surfaced at start (configureServer threw), not at request time
  });

  // NOTE (invariant #4 — bundle-failure fallback): the catch wrapping
  // `await bundleWorker()` (keeps workerReady=false → in-page) is intentionally
  // NOT covered by a test. Forcing bundleWorker to throw in-process would require
  // mocking the SHARED ./bundler.js — and bun's mock.module is process-global +
  // retroactive, so it leaks into (and breaks) every sibling serve suite. The infra
  // seams don't reach it either (homedir() is cached by bun; the worker bundle is
  // cached at homedir so bundleWorker returns early). The observable half —
  // workerReady=false ⇒ __PYRIC_FORCE_INPAGE__ — IS covered by the in-page unit
  // test above; the catch is a trivial try/await/flag read off the source.
});

// ── M3: the MCP bridge fold (wiring only — NO real dev server) ────────────────
// Tests the PLUGIN WIRING: that `bridge` composes createBridgeMount into the
// /__pyric middleware, surfaces a bridgeUrl, attaches the WS upgrade, and forces
// the in-page path. The WS round-trip + MCP protocol are covered by the bridge
// package's own tests + serve's bridge tests — not re-tested here.
describe('M3 — bridge fold (handler-based)', () => {
  let tmp: string;
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  it('bridge:true → init.json carries the absolute ws bridgeUrl (stub port 5173)', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-bridgeurl-'));
    const init = await initJson(await bootPlugin({ bridge: true }, tmp));
    expect(init.bridgeUrl).toBe('ws://localhost:5173/__pyric/sandbox');
  });

  it('bridge:true → GET /__pyric/health is handled by the mount (200 health JSON), not passed through', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-bridgehealth-'));
    const handler = await bootPlugin({ bridge: true }, tmp);
    const health = await callPyric(handler, { path: '/__pyric/health' });
    expect(health.statusCode).toBe(200);
    expect(health.nexted).toBe(false); // the mount handled it (did NOT fall through)
    const body = JSON.parse(health.body);
    expect(body.mode).toBe('sandbox'); // the bridge's health report shape
    expect(body.status).toBe('ok');
  });

  it('bridge:true → transformIndexHtml uses the SharedWorker path (no force-in-page) when the bundle is ready', async () => {
    // The critical correctness bit: bridge no longer forks an in-page sandbox.
    // The bridge peer routes agent tool-calls THROUGH the worker
    // (connectBridgePeer), so the app stays on the SharedWorker and shares the
    // ONE sandbox with Studio + the agent.
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-bridgeworker-'));
    const p = pyric({ bridge: true });
    const stub = {
      config: { root: tmp, logger: { info() {}, warn() {} }, server: { allowedHosts: [], host: 'localhost' } },
      middlewares: { use() {} },
      watcher: { add() {}, on() {} },
      httpServer: { address: () => ({ port: 5173 }), on() {}, once() {} },
    };
    await (p.configureServer as (s: unknown) => Promise<void>)(stub); // flips workerReady=true (cache-warmed bundle)
    const html = (p.transformIndexHtml as (h: string) => string)('<html><head></head></html>');
    expect(html).not.toContain('__PYRIC_FORCE_INPAGE__'); // NOT forced in-page under bridge anymore
    expect(html).toContain('pyric-worker-v'); // the SharedWorker path (one shared backend)
    expect(html).toContain(entries.init); // still boots the sandbox
  });

  it('bridge:true → attaches the WS upgrade listener to the http server', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-bridgews-'));
    const events: string[] = [];
    const stub = {
      config: { root: tmp, logger: { info() {}, warn() {} }, server: { allowedHosts: [], host: 'localhost' } },
      middlewares: { use() {} },
      watcher: { add() {}, on() {} },
      httpServer: { address: () => ({ port: 5173 }), on(ev: string) { events.push(ev); }, once() {} },
    };
    await (pyric({ bridge: true }).configureServer as (s: unknown) => Promise<void>)(stub);
    expect(events).toContain('upgrade'); // attachUpgrade wired the peer listener
  });

  it('bridge OFF (default) → bridgeUrl null; /__pyric/mcp + /__pyric/health pass through', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-nobridge-'));
    const handler = await bootPlugin({}, tmp);
    expect((await initJson(handler)).bridgeUrl).toBeNull();
    // No mount → the bridge routes are unmounted → middleware falls through (next()).
    expect((await callPyric(handler, { path: '/__pyric/health' })).nexted).toBe(true);
    expect((await callPyric(handler, { method: 'POST', path: '/__pyric/mcp' })).nexted).toBe(true);
  });

  it('bridge as an options object ({ disableAuditLog }) → still mounts + surfaces the bridgeUrl', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-bridgeopts-'));
    const handler = await bootPlugin({ bridge: { disableAuditLog: true } }, tmp);
    expect((await initJson(handler)).bridgeUrl).toBe('ws://localhost:5173/__pyric/sandbox');
    expect((await callPyric(handler, { path: '/__pyric/health' })).statusCode).toBe(200);
  });
});

// `ui`: the `pyric dev --ui` equivalent. Studio app at /__pyric/ui/ + the
// disk-backed workspace/project routes Studio's local mode talks to. Resolves the
// Astro site assets vendored in this package's dist (the same bytes the standalone
// embeds). Requires the site build (CI builds first; resolveSiteUiDir finds
// packages/site-docs/dist when run from source).
//
// Skip the app-serving case (only) when the studio build is absent, with a clear
// reason rather than a cryptic status mismatch; resolveSiteUiDir mirrors the
// production resolution. CI always builds first, so it exercises every case.
const studioBuilt = resolveSiteUiDir() !== null;

describe('ui: Pyric Studio mount (parity with dev --ui)', () => {
  const tmps: string[] = [];
  const mkTmp = (prefix: string): string => {
    const d = mkdtempSync(path.join(tmpdir(), prefix));
    tmps.push(d);
    return d;
  };
  afterAll(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });

  it.skipIf(!studioBuilt)('ui:true → serves the built Studio app at /__pyric/ui/ (and 301s the bare path)', async () => {
    const tmp = mkTmp('pyric-vite-ui-');
    const handler = await bootPlugin({ ui: true }, tmp);
    const redirect = await callPyric(handler, { path: '/__pyric/ui' });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('/__pyric/ui/');
    const index = await callPyric(handler, { path: '/__pyric/ui/' });
    expect(index.statusCode).toBe(200);
    expect(String(index.headers['content-type'])).toContain('text/html');
    expect(index.body.toLowerCase()).toContain('<!doctype html');
  });

  it.skipIf(!studioBuilt)('serves Studio after Connect strips the /__pyric mount prefix', async () => {
    const tmp = mkTmp('pyric-vite-ui-mounted-');
    const handler = await bootPlugin({ ui: true }, tmp);
    const index = await callPyric(handler, {
      path: '/__pyric/ui/',
      mountedPath: '/ui/',
    });
    expect(index.nexted).toBe(false);
    expect(index.statusCode).toBe(200);
    expect(String(index.headers['content-type'])).toContain('text/html');
  });

  // The workspace/project routes mount whenever `ui` is on (they need only the
  // disk-backed stores, not the built assets), so this runs regardless of the build.
  it('ui:true → mounts the Studio local-mode workspace route (handled, not passed through)', async () => {
    const tmp = mkTmp('pyric-vite-ui-ws-');
    const handler = await bootPlugin({ ui: true }, tmp);
    expect((await callPyric(handler, { path: '/__pyric/workspace' })).nexted).toBe(false);
  });

  // Default-ON: a plain pyric() (no `ui`) serves Studio + mounts its routes.
  it.skipIf(!studioBuilt)('ui defaults ON → /__pyric/ui/ served and workspace mounted with no ui passed', async () => {
    const tmp = mkTmp('pyric-vite-ui-default-');
    const handler = await bootPlugin({}, tmp);
    expect((await callPyric(handler, { path: '/__pyric/ui/' })).statusCode).toBe(200);
    expect((await callPyric(handler, { path: '/__pyric/workspace' })).nexted).toBe(false);
  });

  it('ui:false → /__pyric/ui/ and /__pyric/workspace pass through (404 in a real server)', async () => {
    const tmp = mkTmp('pyric-vite-noui-');
    const handler = await bootPlugin({ ui: false }, tmp);
    expect((await callPyric(handler, { path: '/__pyric/ui/' })).nexted).toBe(true);
    expect((await callPyric(handler, { path: '/__pyric/workspace' })).nexted).toBe(true);
  });

  // ui + bridge is unified now (the bridge routes through the worker), so ui
  // defaults ON even under bridge: Studio mounts and observes the same sandbox.
  it('bridge without explicit ui → Studio defaults ON (workspace mounted)', async () => {
    const tmp = mkTmp('pyric-vite-bridge-ui-default-');
    const handler = await bootPlugin({ bridge: true }, tmp);
    expect((await callPyric(handler, { path: '/__pyric/workspace' })).nexted).toBe(false);
  });

  // ui + bridge is unified now (the bridge routes agent tool-calls through the
  // worker), so there is NO degraded-combo warning: Studio, app, and agent all
  // share the one sandbox.
  it('ui:true + bridge:true → no degraded-combo warning (unified via the worker)', async () => {
    const tmp = mkTmp('pyric-vite-ui-bridge-');
    const warnings: string[] = [];
    const stub = {
      config: { root: tmp, logger: { info() {}, warn(m: string) { warnings.push(String(m)); } }, server: { allowedHosts: [], host: 'localhost' } },
      middlewares: { use() {} },
      watcher: { add() {}, on() {} },
      httpServer: { address: () => ({ port: 5173 }), on() {}, once() {} },
    };
    await (pyric({ ui: true, bridge: true }).configureServer as (s: unknown) => Promise<void>)(stub);
    expect(warnings.some((w) => /ui \+ bridge/.test(w))).toBe(false);
  });
});

// A2: bridge writes the .pyric/serve.json discovery pointer on listen so the stdio
// mcp-proxy finds it by PORT (probing both loopback families) instead of a static URL.
describe('bridge: .pyric/serve.json discovery pointer (A2)', () => {
  const pointerStub = (root: string, onSet: (cb: () => void) => void) => ({
    config: { root, logger: { info() {}, warn() {} }, server: { allowedHosts: [], host: 'localhost' } },
    middlewares: { use() {} },
    watcher: { add() {}, on() {} },
    httpServer: { address: () => ({ port: 4321 }), on() {}, once(ev: string, cb: () => void) { if (ev === 'listening') onSet(cb); } },
  });

  it('writes the pointer (port + mcpUrl + project) when the server binds', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-pointer-'));
    let onListening: (() => void) | undefined;
    await (pyric({ bridge: true }).configureServer as (s: unknown) => Promise<void>)(
      pointerStub(tmp, (cb) => { onListening = cb; }),
    );
    expect(typeof onListening).toBe('function'); // hooked, not written until bound
    onListening!();
    const ptr = JSON.parse(readFileSync(path.join(tmp, '.pyric', 'serve.json'), 'utf8')) as { port: number; mcpUrl: string; project: string };
    expect(ptr.port).toBe(4321);
    expect(ptr.mcpUrl).toContain('/__pyric/mcp');
    expect(ptr.project).toBe('sandbox');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes NO pointer without bridge', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-nopointer-'));
    let onListening: (() => void) | undefined;
    await (pyric({}).configureServer as (s: unknown) => Promise<void>)(
      pointerStub(tmp, (cb) => { onListening = cb; }),
    );
    onListening?.();
    expect(existsSync(path.join(tmp, '.pyric', 'serve.json'))).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});
