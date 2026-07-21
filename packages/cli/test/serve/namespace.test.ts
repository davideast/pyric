/** `/__pyric/` namespace + HTML injection (plan step 1.4). */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { injectServeTags } from '../../src/serve/html-injection.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

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

describe('namespace over the real server', () => {
  it('issues one activity capability per boot and requires it on reports', async () => {
    const { site, sdk } = fixture();
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      activity: () => {},
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

    const first = await (await fetch(h.url + '/__pyric/init.json')).json() as { activityToken: string };
    const second = await (await fetch(h.url + '/__pyric/init.json')).json() as { activityToken: string };
    expect(first.activityToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.activityToken).toBe(first.activityToken);

    const withoutCapability = await fetch(h.url + '/__pyric/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.url },
      body: '{}',
    });
    expect(withoutCapability.status).toBe(403);
    const withCapability = await fetch(h.url + '/__pyric/activity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: h.url,
        'x-pyric-activity-token': first.activityToken,
      },
      body: '{}',
    });
    expect(withCapability.status).toBe(400);
  });

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
