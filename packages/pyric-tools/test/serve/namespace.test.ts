/** `/__pyric/` namespace + HTML injection (plan step 1.4). */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace, injectServeTags, sdkImportMap } from '../../src/serve/namespace.js';
import { loopbackHosts, silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-ns-'));
  const site = join(dir, 'public');
  const sdk = join(dir, 'sdk');
  for (const d of [site, sdk]) require('node:fs').mkdirSync(d);
  writeFileSync(join(site, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  writeFileSync(join(sdk, 'auth.js'), 'export const getAuth = 1;');
  writeFileSync(join(sdk, 'database.js'), 'export const getDatabase = 1;');
  writeFileSync(join(sdk, 'storage.js'), 'export const getStorage = 1;');
  writeFileSync(join(sdk, 'init.js'), '// init');
  return { site, sdk };
}

const handles: ServeHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
});

describe('injectServeTags', () => {
  it('injects import map + init script at the start of <head>, idempotently', () => {
    const out = injectServeTags('<html><head><script type="module" src="/app.js"></script></head></html>');
    const mapAt = out.indexOf('type="importmap"');
    const initAt = out.indexOf('/__pyric/sdk/init.js');
    // match the script tag, not the import map's own ".../sdk/app.js" value
    const appAt = out.indexOf('src="/app.js"');
    expect(mapAt).toBeGreaterThan(-1);
    // the import map must precede the app's module script
    expect(mapAt).toBeLessThan(appAt);
    expect(initAt).toBeLessThan(appAt);
    expect(out).toContain('"firebase/auth":"/__pyric/sdk/auth.js"');
    expect(injectServeTags(out)).toBe(out); // idempotent
  });

  it('falls back when <head> is absent', () => {
    expect(injectServeTags('<html><body>x</body></html>')).toContain('importmap');
    expect(injectServeTags('no tags at all')).toContain('importmap');
  });

  it('stamps the worker version meta when provided (versioned SharedWorker name)', () => {
    const out = injectServeTags('<html><head></head></html>', undefined, 'abc123');
    expect(out).toContain('<meta name="pyric-worker-v" content="abc123"');
    // precedes the importmap so it's parsed before the runtime reads it
    expect(out.indexOf('pyric-worker-v')).toBeLessThan(out.indexOf('importmap'));
    // omitted by default → no meta
    expect(injectServeTags('<html><head></head></html>')).not.toContain('pyric-worker-v');
  });

  it('forces the in-page sandbox when forceInPage is set (worker-unavailable fallback), before init', () => {
    const out = injectServeTags('<html><head></head></html>', undefined, undefined, true);
    expect(out).toContain('__PYRIC_FORCE_INPAGE__=true');
    // must be set before the init script reads it
    expect(out.indexOf('__PYRIC_FORCE_INPAGE__')).toBeLessThan(out.indexOf('/__pyric/sdk/init.js'));
    // default (forceInPage off) does NOT force in-page
    expect(injectServeTags('<html><head></head></html>')).not.toContain('__PYRIC_FORCE_INPAGE__');
  });

  it('SKIPS injection for a marked sandbox build page (the bundle owns the sandbox)', () => {
    const marked =
      '<html><head><meta name="pyric-sandbox-build" content="1" data-pyric-sandbox-build></head><body></body></html>';
    const out = injectServeTags(marked, undefined, 'abc123');
    // no second runtime: neither the import map nor the injected init module
    expect(out).not.toContain('importmap');
    expect(out).not.toContain('/__pyric/sdk/init.js');
    // the ONE serve-time contribution: the worker staleness stamp
    expect(out).toContain('<meta name="pyric-worker-v" content="abc123"');
    // idempotent
    expect(injectServeTags(out, undefined, 'abc123')).toBe(out);
    // without a worker version, the marked page passes through untouched
    expect(injectServeTags(marked)).toBe(marked);
  });

  it('sdkImportMap covers the served modules', () => {
    expect(Object.keys(sdkImportMap()).sort()).toEqual([
      'firebase/app',
      'firebase/auth',
      'firebase/database',
      'firebase/firestore',
      'firebase/storage',
    ]);
  });
});

describe('loopbackHosts (dual-family bind — the IPv4/IPv6 trap fix)', () => {
  it('localhost binds BOTH loopback families so 127.0.0.1 AND ::1 reach the server', () => {
    expect(loopbackHosts('localhost')).toEqual(['127.0.0.1', '::1']);
  });
  it('an explicit host binds only itself (never all-interfaces — sandbox stays off the LAN)', () => {
    expect(loopbackHosts('0.0.0.0')).toEqual(['0.0.0.0']);
    expect(loopbackHosts('192.168.1.5')).toEqual(['192.168.1.5']);
    expect(loopbackHosts('127.0.0.1')).toEqual(['127.0.0.1']);
  });
});

describe('namespace over the real server', () => {
  it('serves init.json (live payload), sdk files, 404s unknowns, injects into HTML', async () => {
    const { site, sdk } = fixture();
    let rules: string | null = null;
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules, rulesHash: rules ? 'h' : null, bridgeUrl: null }),
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: silentServeLogger(),
      namespaceHandler: ns,
      transformHtml: (html) => injectServeTags(html),
    });
    handles.push(h);

    // init.json reflects LIVE state (the P3 hot-reload contract)
    expect(await (await fetch(h.url + '/__pyric/init.json')).json()).toEqual({ rules: null, rulesHash: null, bridgeUrl: null });
    rules = "rules_version = '2';";
    expect(((await (await fetch(h.url + '/__pyric/init.json')).json()) as { rules: string }).rules).toContain('rules_version');

    // sdk files stream with JS content type; traversal flattens to basename
    const auth = await fetch(h.url + '/__pyric/sdk/auth.js');
    expect(auth.status).toBe(200);
    expect(auth.headers.get('content-type')).toContain('javascript');
    const database = await fetch(h.url + '/__pyric/sdk/database.js');
    expect(database.status).toBe(200);
    expect(database.headers.get('content-type')).toContain('javascript');
    const storage = await fetch(h.url + '/__pyric/sdk/storage.js');
    expect(storage.status).toBe(200);
    expect(storage.headers.get('content-type')).toContain('javascript');
    expect((await fetch(h.url + '/__pyric/sdk/../../etc/passwd')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/sdk/nope.js')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/unknown')).status).toBe(404);

    // served HTML carries the injection
    const html = await (await fetch(h.url + '/')).text();
    expect(html).toContain('type="importmap"');
    expect(html).toContain('/__pyric/sdk/init.js');
  });

  it('serves embedded Studio and Playground apps with SPA fallback', async () => {
    const { site, sdk } = fixture();
    const appRoot = join(site, 'apps');
    const studioRoot = join(appRoot, 'studio');
    const playgroundRoot = join(appRoot, 'playground');
    mkdirSync(join(studioRoot, 'assets'), { recursive: true });
    mkdirSync(join(playgroundRoot, '_astro'), { recursive: true });
    writeFileSync(join(studioRoot, 'index.html'), '<!doctype html>studio');
    writeFileSync(join(studioRoot, 'assets', 'app.js'), '// studio');
    writeFileSync(join(playgroundRoot, 'index.html'), '<!doctype html>playground');
    writeFileSync(join(playgroundRoot, '_astro', 'app.js'), '// playground');
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      studioUiDir: studioRoot,
      playgroundUiDir: playgroundRoot,
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    expect((await fetch(h.url + '/__pyric/ui', { redirect: 'manual' })).status).toBe(301);
    expect(await (await fetch(h.url + '/__pyric/ui/deep/link')).text()).toContain('studio');
    // History-API deep links with dots (e.g. a Storage object path) still
    // fall back to index.html…
    expect(await (await fetch(h.url + '/__pyric/ui/storage/uploads/logo.png')).text()).toContain('studio');
    // …but the content-hashed asset dir keeps hard 404s for real misses.
    expect((await fetch(h.url + '/__pyric/ui/assets/app.js')).status).toBe(200);
    expect((await fetch(h.url + '/__pyric/ui/assets/missing.js')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/playground', { redirect: 'manual' })).status).toBe(301);
    expect(await (await fetch(h.url + '/__pyric/playground/?embed=studio')).text()).toContain('playground');
    expect(await (await fetch(h.url + '/__pyric/playground/playground?embed=studio')).text()).toContain('playground');
    expect((await fetch(h.url + '/__pyric/playground/_astro/app.js')).status).toBe(200);
  });

it('serves the embedded docs site (dir index, .md twin, index.json, assets) and 404s misses — never Studio shell', async () => {
    const { site, sdk } = fixture();
    // Mirror the site-docs `dist/` built with base /__pyric/ui/: pages under
    // `docs/`, shared assets at `_astro/` (base root, NOT under docs/).
    const studioRoot = join(site, 'apps', 'studio');
    const docsRoot = join(site, 'apps', 'docs');
    mkdirSync(join(studioRoot, 'assets'), { recursive: true });
    writeFileSync(join(studioRoot, 'index.html'), '<!doctype html>STUDIO-SHELL');
    mkdirSync(join(docsRoot, 'docs', 'pyric-tools'), { recursive: true });
    mkdirSync(join(docsRoot, '_astro'), { recursive: true });
    writeFileSync(join(docsRoot, 'docs', 'pyric-tools', 'index.html'), '<!doctype html>DOC PAGE');
    writeFileSync(join(docsRoot, 'docs', 'pyric-tools.md'), '# raw markdown twin');
    writeFileSync(join(docsRoot, 'docs', 'index.json'), '{"shape":"x","pages":[]}');
    writeFileSync(join(docsRoot, '_astro', 'doc.css'), 'body{}');
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      studioUiDir: studioRoot,
      docsUiDir: docsRoot,
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    // Directory-format page: trailing slash resolves to <slug>/index.html.
    const page = await fetch(h.url + '/__pyric/ui/docs/pyric-tools/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('DOC PAGE');

    // Extensionless directory without slash → 301 to the trailing-slash form.
    const noSlash = await fetch(h.url + '/__pyric/ui/docs/pyric-tools', { redirect: 'manual' });
    expect(noSlash.status).toBe(301);
    expect(noSlash.headers.get('location')).toBe('/__pyric/ui/docs/pyric-tools/');

    // The .md agent twin (flat) serves 200.
    const twin = await fetch(h.url + '/__pyric/ui/docs/pyric-tools.md');
    expect(twin.status).toBe(200);
    expect(await twin.text()).toContain('raw markdown twin');

    // index.json — the Studio Docs-tab probe requires application/json.
    const idx = await fetch(h.url + '/__pyric/ui/docs/index.json');
    expect(idx.status).toBe(200);
    expect(idx.headers.get('content-type')).toContain('application/json');

    // Shared assets live at /__pyric/ui/_astro/ (base root), served from docs.
    expect((await fetch(h.url + '/__pyric/ui/_astro/doc.css')).status).toBe(200);

    // A genuinely missing docs page 404s — it must NOT fall through to Studio's
    // index.html (no SPA fallback inside the docs mount).
    const miss = await fetch(h.url + '/__pyric/ui/docs/does-not-exist');
    expect(miss.status).toBe(404);
    expect(await miss.text()).not.toContain('STUDIO-SHELL');
  });

  it('GET /__pyric/capture returns the fixture (200) or 404 when absent; POST writes it', async () => {
    const { site, sdk } = fixture();
    let stored: string | null = null;
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      capture: { write: (json) => { stored = json; }, read: () => stored },
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    // Nothing captured yet → 404 (worker boot skips hydration cleanly).
    const empty = await fetch(h.url + '/__pyric/capture');
    expect(empty.status).toBe(404);

    // POST writes verbatim; GET reads it back byte-for-byte.
    const body = JSON.stringify({ schema: 'pyric.verify.fixture.v1', events: [{ id: 'e1' }], services: {} });
    const post = await fetch(h.url + '/__pyric/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(post.status).toBe(204);

    const got = await fetch(h.url + '/__pyric/capture');
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toContain('json');
    expect(await got.text()).toBe(body);

    // Unsupported method → 405 advertising GET, POST.
    const del = await fetch(h.url + '/__pyric/capture', { method: 'DELETE' });
    expect(del.status).toBe(405);
    expect(del.headers.get('allow')).toBe('GET, POST');
  });
});
