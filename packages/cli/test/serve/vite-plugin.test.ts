/** `@pyric/cli/vite` — the dev-only firebase→sandbox swap plugin. Unit-tests
 *  the resolver/load/config/html contract (calling the hooks directly), one
 *  resolution check through a real Vite pluginContainer (middlewareMode, binds no
 *  port), and the /__pyric runtime surface by driving the captured connect
 *  middleware with mock req/res (NO real dev server — see the integration block's
 *  header for why). The full browser e2e lives in the M1 spike (plans/pyric-vite-plugin.md section 7b). */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path, { join } from 'node:path';
import { Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { pyricSandbox } from '../../src/serve/vite-plugin.js';
import {
  SDK_MODULES,
  defaultSdkEntries,
  resolveStudioUiDir,
  pyricPackageRoot,
  bundleWorker,
  workerSourceHash,
} from '../../src/serve/bundler.js';
import { createStateStore, STATE_FILE_VERSION } from '../../src/serve/state-store.js';

const entries = defaultSdkEntries();
const pyricRoot = pyricPackageRoot();
const userImporter = '/some/app/src/main.ts';
const pyricImporter = path.join(pyricRoot, 'dist', 'firestore', 'index.js');

// Pre-warm the SharedWorker bundle so the per-test dev-server starts (each bundles
// it in configureServer) hit the disk cache — a cold bundle inside a single test
// could exceed the timeout on a slow CI runner. Also a smoke that it bundles.
beforeAll(async () => {
  await bundleWorker({ outDir: join(homedir(), '.pyric', 'vite-worker', workerSourceHash()) });
}, 180_000);

// The hooks are plain functions on the returned plugin; call them directly.
const plugin = pyricSandbox();
const resolveId = (s: string, i?: string): unknown => (plugin.resolveId as (s: string, i?: string) => unknown)(s, i);
const load = (id: string): unknown => (plugin.load as (id: string) => unknown)(id);
const config = (): { optimizeDeps?: { exclude?: string[]; esbuildOptions?: { plugins?: unknown[] } }; server?: { fs?: { allow?: string[] } } } =>
  (plugin.config as (c: unknown, env: unknown) => never)({}, { command: 'serve', mode: 'development' });

/** Call the `apply` function with a (command, mode) env. */
const applies = (p: typeof plugin, command: 'serve' | 'build', mode = 'production'): boolean =>
  (p.apply as (c: unknown, env: { command: string; mode: string }) => boolean)({}, { command, mode });

describe('pyricSandbox — plugin shape', () => {
  it('is a pre-enforced plugin whose apply gates build on the mode', () => {
    expect(plugin.name).toBe('pyric:sandbox');
    expect(typeof plugin.apply).toBe('function');
    expect(plugin.enforce).toBe('pre');
  });

  it('apply: always on for `vite dev`', () => {
    expect(applies(plugin, 'serve', 'production')).toBe(true);
    expect(applies(plugin, 'serve', 'development')).toBe(true);
  });

  it('apply: `vite build` swaps only for a NON-production mode (default)', () => {
    expect(applies(plugin, 'build', 'production')).toBe(false); // plain prod build → real firebase
    expect(applies(plugin, 'build', 'development')).toBe(true); // sandbox build
    expect(applies(plugin, 'build', 'staging')).toBe(true); // any non-prod custom mode
  });

  it('apply: swapInBuild option overrides the mode default in both directions', () => {
    const forcedOn = pyricSandbox({ swapInBuild: true });
    expect(applies(forcedOn, 'build', 'production')).toBe(true); // forced sandbox even in prod mode
    const forcedOff = pyricSandbox({ swapInBuild: false });
    expect(applies(forcedOff, 'build', 'development')).toBe(false); // never swap in build
    expect(applies(forcedOff, 'serve', 'production')).toBe(true); // dev still always on
  });

  it('sandbox build: transformIndexHtml stamps ONLY the marker (no init/@fs, no force-in-page)', () => {
    const p = pyricSandbox();
    // Flag the plugin as a build (apply already gated it upstream).
    (p.config as (c: unknown, env: unknown) => unknown)({}, { command: 'build', mode: 'development' });
    const out = (p.transformIndexHtml as (h: string) => string)('<html><head></head><body></body></html>');
    expect(out).toContain('data-pyric-sandbox-build'); // the deploy-refusal / dev-trust marker
    expect(out).not.toContain('/@fs/'); // pyric dev injects init at serve time, not the build
    expect(out).not.toContain('__PYRIC_FORCE_INPAGE__');
    // idempotent
    expect((p.transformIndexHtml as (h: string) => string)(out)).toBe(out);
  });
});

describe('resolveId — the importer-aware swap', () => {
  it('swaps the served firebase subpaths to the sandbox entries for app/library code', () => {
    expect(resolveId('firebase/app', userImporter)).toBe(entries.app);
    expect(resolveId('firebase/auth', userImporter)).toBe(entries.auth);
    expect(resolveId('firebase/firestore', userImporter)).toBe(entries.firestore);
    expect(resolveId('firebase/storage', userImporter)).toBe(entries.storage);
  });

  it('swaps a node_modules library importer too (transitive deps)', () => {
    const lib = '/app/node_modules/react-firebase-hooks/firestore/index.js';
    expect(resolveId('firebase/firestore', lib)).toBe(entries.firestore);
  });

  it('swaps RTDB and Storage from user/library code', () => {
    expect(resolveId('firebase/database', userImporter)).toBe(entries.database);
    expect(resolveId('firebase/storage', userImporter)).toBe(entries.storage);
  });

  it('does not false-positive on a user path containing "pyric"', () => {
    // section 8 refinement: keyed on the package ROOT, not a /pyric/ substring.
    const lookalike = '/home/me/projects/pyric-clone/src/main.ts';
    expect(resolveId('firebase/firestore', lookalike)).toBe(entries.firestore);
  });

  it('shims node builtins ONLY when reached from pyric/our code — never the user app or a library', () => {
    // pyric-internal (the rules module resolver reaches fs/path/url) → shim
    expect(resolveId('node:fs', pyricImporter)).toBe('\0pyric:node-shim:fs');
    expect(resolveId('fs', pyricImporter)).toBe('\0pyric:node-shim:fs');
    expect(resolveId('path', pyricImporter)).toBe('\0pyric:node-shim:path');
    expect(resolveId('node:url', pyricImporter)).toBe('\0pyric:node-shim:url');
    // user / third-party code's own node builtins are left to Vite (or the
    // user's own polyfill plugin) — we do NOT hijack them with pyric's lossy shim.
    expect(resolveId('path', userImporter)).toBeNull();
    expect(resolveId('node:fs', userImporter)).toBeNull();
    expect(resolveId('fs', '/app/node_modules/some-lib/index.js')).toBeNull();
  });

  it('ignores unrelated specifiers', () => {
    expect(resolveId('react', userImporter)).toBeNull();
    expect(resolveId('pyric/firestore', userImporter)).toBeNull();
  });
});

describe('load — node shims', () => {
  it('emits the node-builtin shim source', () => {
    expect(load('\0pyric:node-shim:fs') as string).toContain('readFileSync');
    expect(load('\0pyric:node-shim:path') as string).toContain('export const join');
    expect(load('\0pyric:node-shim:url') as string).toContain('fileURLToPath');
  });

  it('ignores ids it does not own', () => {
    expect(load('\0some/other/id')).toBeNull();
  });
});

describe('config — optimizer + fs', () => {
  it('excludes the served firebase subpaths from dep optimization and mirrors the resolver into esbuild', () => {
    const c = config();
    expect(c.optimizeDeps?.exclude).toEqual([...SDK_MODULES]);
    expect(c.optimizeDeps?.esbuildOptions?.plugins?.length).toBe(1);
  });

  it('AUGMENTS the resolved fs allow-list (does not clobber the app root)', () => {
    // configResolved must push pyric dirs WITHOUT removing Vite's root/workspace
    // entries — clobbering them 403s the app's own source.
    const resolved = { server: { fs: { allow: ['/the/app/root'] } } };
    (plugin.configResolved as (c: typeof resolved) => void)(resolved);
    const allow = resolved.server.fs.allow;
    expect(allow).toContain('/the/app/root'); // preserved (not clobbered)
    expect(allow).toContain(pyricRoot); // pyric dist added
    // The regression the review caught: the init entry's SIBLING worker/client.js
    // (statically imported by runtime.ts) must fall under an allowed dir — NOT
    // just entries/. Allowing the @pyric/cli package root covers it.
    const workerFile = path.join(path.dirname(path.dirname(entries.init)), 'worker', 'client.js');
    expect(allow.some((d) => workerFile.startsWith(d + path.sep))).toBe(true);
    expect(allow.some((d) => entries.init.startsWith(d + path.sep))).toBe(true);
  });
});

describe('transformIndexHtml — sandbox boot injection', () => {
  const xform = (html: string): string => (plugin.transformIndexHtml as (h: string) => string)(html);

  it('injects the init module into <head>', () => {
    const out = xform('<html><head></head><body></body></html>');
    expect(out).toContain('data-pyric-sandbox');
    expect(out).toContain('/@fs/');
    expect(out).toContain(entries.init);
    expect(out).toContain('</head>');
  });

  it('is idempotent', () => {
    const once = xform('<html><head></head></html>');
    const twice = xform(once);
    expect(twice).toBe(once);
  });
});

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
      plugins: [pyricSandbox()],
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
      plugins: [pyricSandbox({ bridge: { disableAuditLog: true } })],
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

/** http.ServerResponse stand-in: a Writable that records status/headers/body, so
 *  BOTH the namespace's writeHead+end paths AND its createReadStream().pipe(res)
 *  (sdk files) work. */
class MockRes extends Writable {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  headersSent = false;
  private chunks: Buffer[] = [];
  writeHead(code: number, h?: Record<string, unknown>): this {
    this.statusCode = code;
    if (h) for (const k of Object.keys(h)) this.headers[k.toLowerCase()] = h[k];
    this.headersSent = true;
    return this;
  }
  setHeader(k: string, v: unknown): void { this.headers[k.toLowerCase()] = v; }
  getHeader(k: string): unknown { return this.headers[k.toLowerCase()]; }
  override _write(chunk: Buffer | string, _enc: unknown, cb: (e?: Error) => void): void {
    this.chunks.push(Buffer.from(chunk as Buffer));
    cb();
  }
  get body(): string { return Buffer.concat(this.chunks).toString('utf8'); }
}
interface PyricReq { method: string; url: string; originalUrl: string; headers: Record<string, string> }
type PyricMiddleware = (req: PyricReq, res: MockRes, next: () => void) => void;

/** Build a plugin and run `configureServer` with a stub that captures the
 *  `/__pyric` middleware. This runs the FULL M2 prelude — rules load, capture,
 *  state eager-load (the fail-fast), seed orchestration, worker-bundle cache-hit,
 *  namespace mount — minus a real http server. */
async function bootPlugin(opts: Record<string, unknown>, root: string): Promise<PyricMiddleware> {
  let handler: PyricMiddleware | undefined;
  const stub = {
    config: { root, logger: { info() {}, warn() {} }, server: { allowedHosts: [], host: 'localhost' } },
    middlewares: { use(p: string, h: PyricMiddleware) { if (p === '/__pyric') handler = h; } },
    watcher: { add() {}, on() {} },
    // M3: a stub http server so the bridge's port-resolution (initPayload) and
    // attachUpgrade work without binding a real port. address() returns a fixed
    // port; `on` is a no-op here (the attachUpgrade spy test uses its own stub).
    httpServer: { address: () => ({ port: 5173 }), on() {}, once() {} },
  };
  await (pyricSandbox(opts).configureServer as (s: unknown) => Promise<void>)(stub);
  if (!handler) throw new Error('plugin did not mount the /__pyric middleware');
  return handler;
}
/** Invoke the captured middleware; resolve when it responds (res 'finish') OR
 *  passes through (next()). Returns the recorded response + whether it next()ed. */
async function callPyric(
  handler: PyricMiddleware,
  opts: { method?: string; path: string; host?: string; headers?: Record<string, string> },
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string; nexted: boolean }> {
  const req: PyricReq = {
    method: opts.method ?? 'GET',
    url: opts.path,
    originalUrl: opts.path,
    headers: { host: opts.host ?? 'localhost', ...(opts.headers ?? {}) },
  };
  const res = new MockRes();
  let nexted = false;
  await new Promise<void>((resolve, reject) => {
    res.on('finish', () => resolve());
    res.on('error', reject);
    try { handler(req, res, () => { nexted = true; resolve(); }); } catch (e) { reject(e as Error); }
  });
  return { statusCode: res.statusCode, headers: res.headers, body: res.body, nexted };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const initJson = async (handler: PyricMiddleware): Promise<any> =>
  JSON.parse((await callPyric(handler, { path: '/__pyric/init.json' })).body);

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
    // DNS-rebinding guard: a forged Host is refused before the namespace runs.
    const forged = await callPyric(handler, { path: '/__pyric/init.json', host: 'evil.example' });
    expect(forged.statusCode).toBe(403);
  });

  it('serves null rules when the project has none (no firebase.json, no firestore.rules)', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-norules-'));
    expect((await initJson(await bootPlugin({}, tmp))).rules).toBeNull();
  });

  it('fails fast when an explicit rules path does not exist', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-badrules-'));
    let threw = false;
    try { await bootPlugin({ rules: 'does-not-exist.rules' }, tmp); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

// NOTE (unit): asserts the workerReady===false → in-page output in ISOLATION
// (configureServer never ran → workerReady is its initial false). The worker-READY
// branch is covered in the next block; the bundle-FAILURE catch is covered by source
// inspection (see the section 4 note at the end of this file).
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
    const p = pyricSandbox({});
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

  it('persist mounts the /__pyric/state channel and sets persist in the payload', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pyric-vite-persist-'));
    const handler = await bootPlugin({ persist: true }, tmp);
    expect((await initJson(handler)).persist).toBe(true); // persist wired into the payload
    // A PUT heartbeat claims the writer lock → 204 proves the state route is mounted.
    const put = await callPyric(handler, { method: 'PUT', path: '/__pyric/state', headers: { 'x-pyric-writer': 'test' } });
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
    const p = pyricSandbox({ bridge: true });
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
    await (pyricSandbox({ bridge: true }).configureServer as (s: unknown) => Promise<void>)(stub);
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
// studio-ui assets vendored in this package's dist (the same bytes the standalone
// embeds). Requires the studio build (CI builds first; resolveStudioUiDir finds
// packages/studio/dist/app when run from src).
//
// Skip the app-serving case (only) when the studio build is absent, with a clear
// reason rather than a cryptic status mismatch; resolveStudioUiDir mirrors the
// production resolution. CI always builds first, so it exercises every case.
const studioBuilt = resolveStudioUiDir() !== null;

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

  // The workspace/project routes mount whenever `ui` is on (they need only the
  // disk-backed stores, not the built assets), so this runs regardless of the build.
  it('ui:true → mounts the Studio local-mode workspace route (handled, not passed through)', async () => {
    const tmp = mkTmp('pyric-vite-ui-ws-');
    const handler = await bootPlugin({ ui: true }, tmp);
    expect((await callPyric(handler, { path: '/__pyric/workspace' })).nexted).toBe(false);
  });

  // Default-ON: a plain pyricSandbox() (no `ui`) serves Studio + mounts its routes.
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
    await (pyricSandbox({ ui: true, bridge: true }).configureServer as (s: unknown) => Promise<void>)(stub);
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
    await (pyricSandbox({ bridge: true }).configureServer as (s: unknown) => Promise<void>)(
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
    await (pyricSandbox({}).configureServer as (s: unknown) => Promise<void>)(
      pointerStub(tmp, (cb) => { onListening = cb; }),
    );
    onListening?.();
    expect(existsSync(path.join(tmp, '.pyric', 'serve.json'))).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});
