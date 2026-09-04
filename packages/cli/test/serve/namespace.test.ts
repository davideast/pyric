/** `/__pyric/` namespace + HTML injection (plan step 1.4). */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace, createEventHub } from '../../src/serve/namespace.js';
import { injectServeTags } from '../../src/serve/html-injection.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { createStateStore } from '../../src/serve/state-store.js';
import { diskWorkspace } from '../../src/serve/studio/index.js';

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
    expect(await (await fetch(h.url + '/__pyric/init.json')).json()).toEqual(
      expect.objectContaining({ rules: null, rulesHash: null, bridgeUrl: null }),
    );
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
    const token = 'capture-test-token-123';
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      capture: { write: (json) => { stored = json; }, read: () => stored },
      sessionToken: token,
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
    const empty = await fetch(h.url + '/__pyric/capture', {
      headers: { 'x-pyric-session-token': token },
    });
    expect(empty.status).toBe(404);

    // POST writes verbatim; GET reads it back byte-for-byte.
    const body = JSON.stringify({ schema: 'pyric.verify.fixture.v1', events: [{ id: 'e1' }], services: {} });
    const post = await fetch(h.url + '/__pyric/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-session-token': token },
      body,
    });
    expect(post.status).toBe(204);

    const got = await fetch(h.url + '/__pyric/capture', {
      headers: { 'x-pyric-session-token': token },
    });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toContain('json');
    expect(await got.text()).toBe(body);

    // Unsupported method → 405 advertising GET, POST.
    const del = await fetch(h.url + '/__pyric/capture', {
      method: 'DELETE',
      headers: { 'x-pyric-session-token': token },
    });
    expect(del.status).toBe(405);
    expect(del.headers.get('allow')).toBe('GET, POST');
  });

  it('serves session capability token in /__pyric/init.json', async () => {
    const { site, sdk } = fixture();
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    const init = (await (await fetch(h.url + '/__pyric/init.json')).json()) as { sessionToken: string };
    expect(typeof init.sessionToken).toBe('string');
    expect(init.sessionToken.length).toBeGreaterThan(10);
  });

  it('enforces host and origin guards and token validation on /__pyric/events', async () => {
    const { site, sdk } = fixture();
    const events = createEventHub();
    const token = 'events-test-token-123';
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      events,
      sessionToken: token,
      boundHost: '127.0.0.1',
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    try {
      // 1. Rejected if unapproved Host
      const badHostRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { host: 'attacker.example.com' },
      });
      expect(badHostRes.status).toBe(403);

      // 2. Rejected if unapproved Origin
      const badOriginRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { origin: 'http://malicious-site.example.com' },
      });
      expect(badOriginRes.status).toBe(403);

      // 3. Rejected if wrong token provided
      const badTokenRes = await fetch(`${h.url}/__pyric/events?token=wrong-token`, {
        headers: { origin: h.url },
      });
      expect(badTokenRes.status).toBe(401);

      // 4. Allowed without token for in-page runtime hot-reload
      const controller = new AbortController();
      const allowedRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { origin: h.url },
        signal: controller.signal,
      });
      expect(allowedRes.status).toBe(200);
      expect(allowedRes.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();
    } finally {
      events.close();
    }
  });

  it('isolates state persistence writer lock from studio workspace writer lock', async () => {
    const { site, sdk } = fixture();
    const ws = diskWorkspace(site);
    const stateStore = createStateStore(site);

    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      state: stateStore,
      studio: { workspace: ws },
      sessionToken: 'ns-session-token',
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    // Tab 1 claims state writer lock on /__pyric/state
    const stateLockRes = await fetch(`${h.url}/__pyric/state`, {
      method: 'PUT',
      headers: {
        'x-pyric-writer': 'tab-1-state-holder',
        'x-pyric-session-token': 'ns-session-token',
      },
    });
    expect(stateLockRes.status).toBe(204);

    // Tab 2 writes a workspace file on /__pyric/workspace
    // Should NOT be locked out by Tab 1's state lock
    const wsRes = await fetch(`${h.url}/__pyric/workspace?path=state-isolate.txt`, {
      method: 'PUT',
      headers: {
        'x-pyric-session-token': 'ns-session-token',
        'x-pyric-writer': 'tab-2-studio-writer',
      },
      body: 'hello from studio',
    });
    expect(wsRes.status).toBe(204);
  });

  it('enforces capability token and origin isolation on /__pyric/state and /__pyric/capture', async () => {
    const { site, sdk } = fixture();
    const stateStore = createStateStore(site);
    let capturedData: string | null = null;
    const token = 'ns-sec-token-xyz';

    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      state: stateStore,
      capture: { write: (json) => { capturedData = json; }, read: () => capturedData },
      sessionToken: token,
      boundHost: '127.0.0.1',
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    // 1. /__pyric/state without token returns 401
    const unauthState = await fetch(`${h.url}/__pyric/state?section=firestore`);
    expect(unauthState.status).toBe(401);

    // 2. /__pyric/state with wrong token returns 401
    const wrongTokenState = await fetch(`${h.url}/__pyric/state?section=firestore`, {
      headers: { 'x-pyric-session-token': 'wrong-token' },
    });
    expect(wrongTokenState.status).toBe(401);

    // 3. /__pyric/state with invalid host returns 403
    const badHostState = await fetch(`${h.url}/__pyric/state?section=firestore`, {
      headers: { host: 'evil-host.com', 'x-pyric-session-token': token },
    });
    expect(badHostState.status).toBe(403);

    // 4. /__pyric/state with cross-origin origin header returns 403
    const crossOriginState = await fetch(`${h.url}/__pyric/state?section=firestore`, {
      headers: { origin: 'https://evil-cross-origin.com', 'x-pyric-session-token': token },
    });
    expect(crossOriginState.status).toBe(403);

    // 5. /__pyric/capture without token returns 401
    const unauthCapture = await fetch(`${h.url}/__pyric/capture`);
    expect(unauthCapture.status).toBe(401);

    // 6. /__pyric/capture with wrong token returns 401
    const wrongTokenCapture = await fetch(`${h.url}/__pyric/capture`, {
      headers: { 'x-pyric-session-token': 'wrong-token' },
    });
    expect(wrongTokenCapture.status).toBe(401);

    // 7. /__pyric/capture with cross-origin origin returns 403
    const crossOriginCapture = await fetch(`${h.url}/__pyric/capture`, {
      headers: { origin: 'https://evil.com', 'x-pyric-session-token': token },
    });
    expect(crossOriginCapture.status).toBe(403);

    // 8. /__pyric/state with valid token and loopback origin returns 404 (empty state)
    const validState = await fetch(`${h.url}/__pyric/state?section=firestore`, {
      headers: { 'x-pyric-session-token': token, origin: h.url },
    });
    expect(validState.status).toBe(404);

    // 9. /__pyric/capture with valid token and loopback origin returns 404 (empty capture)
    const validCapture = await fetch(`${h.url}/__pyric/capture`, {
      headers: { 'x-pyric-session-token': token, origin: h.url },
    });
    expect(validCapture.status).toBe(404);
  });

  it('unconditionally enforces capability token on /__pyric/state and /__pyric/capture when sessionToken is omitted in options (fail closed)', async () => {
    const { site, sdk } = fixture();
    const stateStore = createStateStore(site);
    stateStore.writeSection('auth', { users: [{ uid: 'admin', password: 'secret-pw' }] });
    let capturedData: string | null = 'sensitive-capture';

    // sessionToken omitted in options, mimicking default dev server in sandbox-session.ts
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      state: stateStore,
      capture: { write: (json) => { capturedData = json; }, read: () => capturedData },
      boundHost: '127.0.0.1',
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    // 1. Unauthenticated request without token must receive 401
    const unauthState = await fetch(`${h.url}/__pyric/state?section=auth`);
    expect(unauthState.status).toBe(401);

    // 2. Request with bogus token must receive 401
    const bogusState = await fetch(`${h.url}/__pyric/state?section=auth`, {
      headers: { 'x-pyric-session-token': 'completely-bogus-token' },
    });
    expect(bogusState.status).toBe(401);

    // 3. Unauthenticated capture request must receive 401
    const unauthCapture = await fetch(`${h.url}/__pyric/capture`);
    expect(unauthCapture.status).toBe(401);

    // 4. Request with generated token from init.json succeeds
    const init = (await (await fetch(`${h.url}/__pyric/init.json`)).json()) as { sessionToken: string };
    expect(init.sessionToken).toBeDefined();
    const authedState = await fetch(`${h.url}/__pyric/state?section=auth`, {
      headers: { 'x-pyric-session-token': init.sessionToken },
    });
    expect(authedState.status).toBe(200);
    expect(await authedState.json()).toEqual({ users: [{ uid: 'admin', password: 'secret-pw' }] });

    const authedCapture = await fetch(`${h.url}/__pyric/capture`, {
      headers: { 'x-pyric-session-token': init.sessionToken },
    });
    expect(authedCapture.status).toBe(200);
    expect(await authedCapture.text()).toBe('sensitive-capture');
  });
});
