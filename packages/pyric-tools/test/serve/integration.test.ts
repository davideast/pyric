/** `pyric dev` end-to-end over HTTP (plan step 1.7) — a real fixture
 *  project served by `startServe`, asserted the way a browser would see it.
 *  (The in-browser 6/6 behavioral check is the scripted manual gate — see
 *  the step doc; no playwright dep in pyric-tools.) */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHosting, serveJsonLine, startServe, wantsSpaRewrite, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger, type ServeLogger } from '../../src/serve/server.js';
import { CAPTURE_RELATIVE_PATH } from '../../src/serve/capture-store.js';

/** Logger that records every line so a test can assert on the banner. */
function capturingLogger(): { logger: ServeLogger; info: string[]; note: string[] } {
  const info: string[] = [];
  const note: string[] = [];
  return { logger: { info: (m) => info.push(m), note: (m) => note.push(m) }, info, note };
}

const RULES = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tasks/{id} { allow read: if isAuthenticated(); }
  }
}`;

function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-proj-'));
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({
      firestore: { rules: 'firestore.rules' },
      hosting: { public: 'public', rewrites: [{ source: '**', destination: '/index.html' }] },
    }),
  );
  writeFileSync(join(dir, 'firestore.rules'), RULES);
  mkdirSync(join(dir, 'public'));
  writeFileSync(
    join(dir, 'public', 'index.html'),
    `<!doctype html><html><head><title>app</title></head><body>
<script type="module">
  // The canonical real-world idiom — the page must load with an unmodified
  // firebase/app initializeApp(config) entry point (flow-doc gap #1).
  import { initializeApp } from 'firebase/app';
  import { getAuth } from 'firebase/auth';
  import { getFirestore } from 'firebase/firestore';
  import { getStorage } from 'firebase/storage';
  const app = initializeApp({ apiKey: 'fake', projectId: 'demo' });
  getAuth(app); getFirestore(app); getStorage(app);
</script></body></html>`,
  );
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

describe('pyric dev end-to-end (HTTP)', () => {
  it('serves the fixture app exactly as a browser needs it', async () => {
    const cwd = fixtureProject();
    const cacheRoot = join(cwd, '.cache');
    const runtime = await startServe({ cwd, port: 0, cacheRoot, logger: silentServeLogger() });
    stops.push(runtime);
    const base = runtime.handle.url;

    // 1. HTML carries the import map BEFORE the app's module script + init tag
    const html = await (await fetch(base + '/')).text();
    const mapAt = html.indexOf('type="importmap"');
    const appAt = html.indexOf("from 'firebase/app'");
    expect(mapAt).toBeGreaterThan(-1);
    expect(mapAt).toBeLessThan(appAt);
    expect(html).toContain('"firebase/firestore":"/__pyric/sdk/firestore.js"');
    expect(html).toContain('"firebase/database":"/__pyric/sdk/database.js"');
    expect(html).toContain('"firebase/storage":"/__pyric/sdk/storage.js"');
    expect(html).toContain('"firebase/app":"/__pyric/sdk/app.js"');
    expect(html).toContain('/__pyric/sdk/init.js');

    // 2. the mapped SDK files are served, browser-standalone
    for (const mod of ['app', 'auth', 'firestore', 'database', 'storage', 'init']) {
      const res = await fetch(`${base}/__pyric/sdk/${mod}.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
      const body = await res.text();
      expect(body).not.toMatch(/from\s*["']firebase\//);
      expect(body).not.toMatch(/from\s*["']node:/);
    }

    // 3. init.json carries the RESOLVED rules (2+modules → plain v2)
    const payload = (await (await fetch(base + '/__pyric/init.json')).json()) as {
      rules: string; rulesHash: string; bridgeUrl: null;
    };
    expect(payload.rules).toContain("rules_version = '2'");
    expect(payload.rules).not.toContain('2+modules');
    expect(payload.rulesHash).toMatch(/^[0-9a-f]{12}$/);
    expect(payload.bridgeUrl).toBeNull();

    // 4. SPA rewrite from firebase.json
    expect(await (await fetch(base + '/some/route')).text()).toContain('importmap');

    // 4b. the --json stdout contract (agents parse this line)
    const machine = JSON.parse(serveJsonLine(runtime)) as Record<string, unknown>;
    expect(machine.url).toBe(base);
    expect(machine.port).toBe(runtime.handle.port);
    expect(machine.mcpUrl).toBeNull(); // bridge off
    expect(machine.rulesHash).toMatch(/^[0-9a-f]{12}$/);

    // 5. clean stop
    await runtime.handle.stop();
    stops.pop();
    await expect(fetch(base + '/')).rejects.toThrow();
  }, 30_000);

  it('fails fast on broken rules; serves without firebase.json', async () => {
    const broken = fixtureProject();
    writeFileSync(join(broken, 'firestore.rules'), 'rules_version = ;;;');
    await expect(
      startServe({ cwd: broken, port: 0, cacheRoot: join(broken, '.cache'), logger: silentServeLogger() }),
    ).rejects.toThrow(/failed to parse/);

    const bare = mkdtempSync(join(tmpdir(), 'pyric-serve-bare-'));
    writeFileSync(join(bare, 'index.html'), '<!doctype html><html><head></head><body>bare</body></html>');
    const runtime = await startServe({ cwd: bare, port: 0, cacheRoot: join(bare, '.cache'), logger: silentServeLogger() });
    stops.push(runtime);
    const html = await (await fetch(runtime.handle.url + '/')).text();
    expect(html).toContain('bare');
    expect(html).toContain('importmap'); // injection works without config too
    const payload = (await (await fetch(runtime.handle.url + '/__pyric/init.json')).json()) as { rules: null };
    expect(payload.rules).toBeNull();
  }, 30_000);

  it('always warns that the sandbox is browser-resident (keep the tab open)', async () => {
    const cwd = fixtureProject();
    const cap = capturingLogger();
    const runtime = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), logger: cap.logger });
    stops.push(runtime);
    const banner = cap.note.join('\n');
    expect(banner).toContain('runs IN the served page');
    expect(banner).toContain('keep the browser tab open');
    expect(banner).toContain('persistence stop when no page is open');
  }, 30_000);

  it('HARD-REFUSES a dist that inlined the real firebase SDK (no marker)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-serve-inlined-'));
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'dist' } }),
    );
    mkdirSync(join(cwd, 'dist'));
    mkdirSync(join(cwd, 'dist', 'assets'));
    writeFileSync(join(cwd, 'dist', 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    writeFileSync(
      join(cwd, 'dist', 'assets', 'index-abc.js'),
      'fetch("https://identitytoolkit.googleapis.com/v1/accounts")',
    );
    await expect(
      startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), logger: silentServeLogger() }),
    ).rejects.toThrow(/bundles the REAL firebase SDK/);
  }, 30_000);

  it('TRUSTS a marked sandbox build even when an asset carries a fingerprint', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-serve-marked-'));
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({ hosting: { public: 'dist' } }),
    );
    mkdirSync(join(cwd, 'dist'));
    mkdirSync(join(cwd, 'dist', 'assets'));
    // The marker in index.html short-circuits the scan (marker → trusted), so
    // even a stray fingerprint string in a bundled adapter must not trip it.
    writeFileSync(
      join(cwd, 'dist', 'index.html'),
      '<!doctype html><html><head><meta name="pyric-sandbox-build" content="1" data-pyric-sandbox-build></head><body></body></html>',
    );
    writeFileSync(
      join(cwd, 'dist', 'assets', 'index-abc.js'),
      'const host = "identitytoolkit.googleapis.com"; // referenced but never real',
    );
    const runtime = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), logger: silentServeLogger() });
    stops.push(runtime);
    expect(runtime.handle.url).toContain('http://');

    // The marked page is served WITHOUT the serve-time injection — the bundle
    // owns the sandbox (a second injected runtime double-inits: two banners,
    // two bridge peers). Only the worker staleness meta is added.
    const html = await (await fetch(runtime.handle.url + '/')).text();
    expect(html).not.toContain('importmap');
    expect(html).not.toContain('/__pyric/sdk/init.js');
    expect(html).toContain('pyric-worker-v');
    // The init-payload path the bundled runtime/worker uses stays live.
    const init = await fetch(runtime.handle.url + '/__pyric/init.json');
    expect(init.status).toBe(200);
  }, 30_000);

  it('serves a default favicon instead of 404ing every page load', async () => {
    const cwd = fixtureProject();
    const runtime = await startServe({ cwd, port: 0, cacheRoot: join(cwd, '.cache'), logger: silentServeLogger() });
    stops.push(runtime);
    const res = await fetch(runtime.handle.url + '/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('svg');
  }, 30_000);
});

describe('hosting config helpers', () => {
  it('extractHosting handles object/array/absent; wantsSpaRewrite detects the idiom', () => {
    expect(extractHosting(null)).toBeNull();
    expect(extractHosting({ hosting: { public: 'dist' } })?.public).toBe('dist');
    expect(extractHosting({ hosting: [{ public: 'a' }, { public: 'b' }] })?.public).toBe('a');
    expect(wantsSpaRewrite({ rewrites: [{ source: '**', destination: '/index.html' }] })).toBe(true);
    expect(wantsSpaRewrite({ rewrites: [{ source: '/api/**', destination: '/fn' }] })).toBe(false);
    expect(wantsSpaRewrite(null)).toBe(false);
  });
});

describe('/__pyric/capture endpoint (serve-capture)', () => {
  it('POST writes fixture to .pyric/last-session.json; GET returns 405', async () => {
    // The browser-push half of capture (the onEvent flush in runtime.ts) runs
    // only in a real browser — this test asserts the SERVER endpoint + file
    // write, which is the node-testable surface.
    const cwd = fixtureProject();
    const cacheRoot = join(cwd, '.cache');
    const runtime = await startServe({ cwd, port: 0, cacheRoot, capture: true, logger: silentServeLogger() });
    stops.push(runtime);

    const base = runtime.handle.url;
    const capturePath = join(cwd, CAPTURE_RELATIVE_PATH);
    const fixture = {
      rules: 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /{d} { allow read, write; } } }',
      events: [],
      state: { 'tasks/a': { title: 'hello' } },
    };

    // 1. POST → 204 and the file is written
    const postRes = await fetch(`${base}/__pyric/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    expect(postRes.status).toBe(204);
    expect(existsSync(capturePath)).toBe(true);

    // 2. File content round-trips exactly to what was posted
    const written = JSON.parse(readFileSync(capturePath, 'utf8')) as typeof fixture;
    expect(written.rules).toBe(fixture.rules);
    expect(written.state).toEqual(fixture.state);
    expect(written.events).toEqual(fixture.events);

    // 3. Non-POST → 405
    const getRes = await fetch(`${base}/__pyric/capture`, { method: 'GET' });
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get('allow')).toBe('POST');
  }, 30_000);

  it('capture: false omits the route (static server falls through)', async () => {
    const cwd = fixtureProject();
    const cacheRoot = join(cwd, '.cache');
    const runtime = await startServe({ cwd, port: 0, cacheRoot, capture: false, logger: silentServeLogger() });
    stops.push(runtime);
    const res = await fetch(`${runtime.handle.url}/__pyric/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // With capture off the namespace handler returns false for /__pyric/capture.
    // The static server then falls through to the method guard (line 162 in
    // server.ts: POST is not GET/HEAD) and returns 405, not 404.
    expect(res.status).toBe(405);
    // Also check no file was written
    const { existsSync: exists } = await import('node:fs');
    const capturePath = join(cwd, CAPTURE_RELATIVE_PATH);
    expect(exists(capturePath)).toBe(false);
  }, 30_000);
});
