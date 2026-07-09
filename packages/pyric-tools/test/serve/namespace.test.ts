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
    expect((await fetch(h.url + '/__pyric/playground', { redirect: 'manual' })).status).toBe(301);
    expect(await (await fetch(h.url + '/__pyric/playground/?embed=studio')).text()).toContain('playground');
    expect(await (await fetch(h.url + '/__pyric/playground/playground?embed=studio')).text()).toContain('playground');
    expect((await fetch(h.url + '/__pyric/playground/_astro/app.js')).status).toBe(200);
  });
});
