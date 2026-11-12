/** `/__pyric/` namespace + HTML injection (plan step 1.4). */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace, createEventHub } from '../../src/serve/namespace.js';
import { injectServeTags } from '../../src/serve/html-injection.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { createStateStore, type StateStore } from '../../src/serve/state-store.js';
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
    const token = 'activity-boot-token';
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      activity: () => {},
      sessionToken: token,
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: silentServeLogger(),
      namespaceHandler: ns,
      sessionToken: token,
    });
    handles.push(h);

    const authHeaders = { 'x-pyric-session-token': token };
    const first = await (await fetch(h.url + '/__pyric/init.json', { headers: authHeaders })).json() as { activityToken: string };
    const second = await (await fetch(h.url + '/__pyric/init.json', { headers: authHeaders })).json() as { activityToken: string };
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
    const token = 'live-init-token';
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules, rulesHash: rules ? 'h' : null, storageRules: null, storageRulesHash: null, bridgeUrl: null }),
      sessionToken: token,
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      portScanLimit: 200,
      logger: silentServeLogger(),
      namespaceHandler: ns,
      sessionToken: token,
      transformHtml: (html) => injectServeTags(html),
    });
    handles.push(h);

    // Default sandbox init.json serves rules/bridge payload on loopback while withholding sessionToken and Set-Cookie
    const unauthInit = await fetch(h.url + '/__pyric/init.json');
    expect(unauthInit.headers.get('set-cookie')).toBeNull();
    const unauthBody = (await unauthInit.json()) as Record<string, unknown>;
    expect(unauthBody).toMatchObject({
      rules: null,
      rulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      thresholds: false,
      rateCaptures: false,
    });
    expect(unauthBody.sessionToken).toBeUndefined();

    // Authenticated init.json reflects LIVE state and stamps sessionToken + cookie
    const authHeaders = { 'x-pyric-session-token': token };
    const authInit = await fetch(h.url + '/__pyric/init.json', { headers: authHeaders });
    expect(authInit.headers.get('set-cookie')).toContain(`__pyric_session_${h.port}=${token}`);
    expect(await authInit.json()).toEqual(
      expect.objectContaining({ rules: null, rulesHash: null, bridgeUrl: null, sessionToken: token }),
    );
    rules = "rules_version = '2';";
    const updatedUnauth = (await (await fetch(h.url + '/__pyric/init.json')).json()) as Record<string, unknown>;
    expect(updatedUnauth).toMatchObject({
      rules: "rules_version = '2';",
      rulesHash: 'h',
      storageRulesHash: null,
    });
    expect(updatedUnauth.sessionToken).toBeUndefined();
    expect(((await (await fetch(h.url + '/__pyric/init.json', { headers: authHeaders })).json()) as { rules: string }).rules).toContain('rules_version');

    // sdk files stream with JS content type; traversal flattens to basename
    const auth = await fetch(h.url + '/__pyric/sdk/auth.js');
    expect(auth.status).toBe(200);
    expect(auth.headers.get('content-type')).toContain('javascript');
    expect(auth.headers.get('set-cookie')).toBeNull();
    const sameOriginSdk = await fetch(h.url + '/__pyric/sdk/init.js', {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(sameOriginSdk.status).toBe(200);
    expect(sameOriginSdk.headers.get('set-cookie')).toContain(`__pyric_session_${h.port}=${token}`);
    const database = await fetch(h.url + '/__pyric/sdk/database.js');
    expect(database.status).toBe(200);
    expect(database.headers.get('content-type')).toContain('javascript');
    const storage = await fetch(h.url + '/__pyric/sdk/storage.js');
    expect(storage.status).toBe(200);
    expect(storage.headers.get('content-type')).toContain('javascript');
    expect((await fetch(h.url + '/__pyric/sdk/../../etc/passwd')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/sdk/nope.js')).status).toBe(404);
    expect((await fetch(h.url + '/__pyric/unknown')).status).toBe(404);

    // served HTML carries the injection and bootstraps the HttpOnly session cookie
    const pageRes = await fetch(h.url + '/');
    expect(pageRes.headers.get('set-cookie')).toContain(`__pyric_session_${h.port}=${token}`);
    const html = await pageRes.text();
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

  it('withholds session capability token from unauthenticated /__pyric/init.json in both sandbox and requireSessionToken modes and enforces method + origin + tunnel guards', async () => {
    const { site, sdk } = fixture();
    const token = 'init-capability-token';
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: "rules_version = '2';", rulesHash: 'rh', storageRules: null, storageRulesHash: null, bridgeUrl: 'ws://127.0.0.1:1/__pyric/sandbox', hosted: true, instanceId: 'inst-1', sessionToken: token }),
      sessionToken: token,
      requireSessionToken: true,
      boundHost: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
      logger: silentServeLogger(),
      namespaceHandler: ns,
      sessionToken: token,
    });
    handles.push(h);

    const unauth = await fetch(h.url + '/__pyric/init.json');
    expect(unauth.status).toBe(200);
    expect(unauth.headers.get('set-cookie')).toBeNull();
    expect(await unauth.json()).toEqual({
      instanceId: 'inst-1',
      hosted: true,
      rulesHash: 'rh',
      databaseRulesHash: null,
      storageRulesHash: null,
    });

    // Unauthenticated tunnel Host is refused with 403 even when allowedHosts lists it
    const tunnelUnauth = await fetch(h.url + '/__pyric/init.json', {
      headers: { host: 'preview.tunnel.example' },
    });
    expect(tunnelUnauth.status).toBe(403);

    // Authenticated tunnel Host succeeds
    const tunnelAuthed = await fetch(h.url + '/__pyric/init.json', {
      headers: { host: 'preview.tunnel.example', 'x-pyric-session-token': token },
    });
    expect(tunnelAuthed.status).toBe(200);

    const postRes = await fetch(h.url + '/__pyric/init.json', { method: 'POST' });
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get('allow')).toBe('GET, HEAD');

    const badHost = await fetch(h.url + '/__pyric/init.json', { headers: { host: 'evil.example' } });
    expect(badHost.status).toBe(403);

    const crossPort = await fetch(h.url + '/__pyric/init.json', {
      headers: { origin: `http://127.0.0.1:${h.port === 3000 ? 3001 : 3000}`, cookie: `__pyric_session=${token}` },
    });
    expect(crossPort.status).toBe(403);

    const crossSite = await fetch(h.url + '/__pyric/init.json', {
      headers: { 'sec-fetch-site': 'cross-site', cookie: `__pyric_session=${token}` },
    });
    expect(crossSite.status).toBe(403);

    const authed = await fetch(h.url + '/__pyric/init.json', {
      headers: { cookie: `__pyric_session=${token}` },
    });
    expect(authed.status).toBe(200);
    const init = (await authed.json()) as { sessionToken: string; rules: string };
    expect(init.sessionToken).toBe(token);
    expect(init.rules).toContain('rules_version');
  });

  describe('a client on another machine', () => {
    const SECRETS = {
      rules: 'rules source',
      rulesHash: 'h',
      storageRules: 'storage rules',
      storageRulesHash: 'h',
      bridgeUrl: 'ws://localhost:5000/__pyric/sandbox',
      seed: { 'users/a': { private: true } },
      seedState: { firestore: { 'users/a': { private: true } } },
      authUsers: [{ uid: 'a', email: 'a@example.com', password: 'pw' }],
      projectKey: '/project/dir',
      databaseRules: { rules: { '.read': true } },
      hosted: true,
      instanceId: 'boot',
    };

    function call(
      ns: ReturnType<typeof createPyricNamespace>,
      path: string,
      remoteAddress: string | undefined,
      extraHeaders: Record<string, string> = {},
      method = 'GET',
    ) {
      let body = '';
      let status = 0;
      const headersOut = new Map<string, string | string[]>();
      const req = { method, headers: { host: 'localhost:5000', ...extraHeaders }, socket: { remoteAddress, localPort: 5000 } };
      const res = {
        getHeader(name: string) { return headersOut.get(name.toLowerCase()); },
        setHeader(name: string, val: string | string[]) { headersOut.set(name.toLowerCase(), val); return res; },
        writeHead(code: number) { status = code; return res; },
        end(chunk?: string) { body = chunk ?? ''; return res; },
      };
      return Promise.resolve(ns(req as never, res as never, new URL(`http://localhost:5000${path}`))).then(() => ({ status, body, headersOut }));
    }

    function namespace(sessionToken = 'local-peer-token', requireSessionToken = false) {
      return createPyricNamespace({
        sdkDir: fixture().sdk,
        initPayload: () => ({ ...SECRETS, sessionToken }),
        activity: () => {},
        sessionToken,
        requireSessionToken,
      });
    }

    it('reads an init payload with no project data and no capability, whatever Host it sends', async () => {
      const ns = namespace();
      for (const peer of ['10.0.0.5', '192.168.1.20', '::ffff:10.0.0.5', undefined]) {
        const { status, body } = await call(ns, '/__pyric/init.json', peer);
        expect(status).toBe(200);
        expect(JSON.parse(body)).toEqual({
          instanceId: 'boot', hosted: true, remotePeer: true,
          rules: null, rulesHash: null, storageRules: null, storageRulesHash: null, bridgeUrl: null, seed: null,
        });
      }
      expect((await call(ns, '/__pyric/init.json', '10.0.0.5', {}, 'POST')).status).toBe(405);
    });

    it('serves sandbox init without sessionToken by default and minimal readiness when requireSessionToken is true', async () => {
      const sandboxNs = namespace('local-peer-token', false);
      const strictNs = namespace('local-peer-token', true);
      for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const sandboxUnauthRes = await call(sandboxNs, '/__pyric/init.json', peer);
        expect(sandboxUnauthRes.headersOut.get('set-cookie')).toBeUndefined();
        const sandboxUnauth = JSON.parse(sandboxUnauthRes.body) as Record<string, unknown>;
        expect(sandboxUnauth.sessionToken).toBeUndefined();
        expect(sandboxUnauth.rules).toBe('rules source');
        expect(typeof sandboxUnauth.activityToken).toBe('string');

        const unauth = JSON.parse((await call(strictNs, '/__pyric/init.json', peer)).body) as Record<string, unknown>;
        expect(unauth).toEqual({
          instanceId: 'boot',
          hosted: true,
          rulesHash: 'h',
          databaseRulesHash: null,
          storageRulesHash: 'h',
        });

        const authed = JSON.parse(
          (await call(strictNs, '/__pyric/init.json', peer, { 'x-pyric-session-token': 'local-peer-token' })).body,
        ) as Record<string, unknown>;
        expect(authed.sessionToken).toBe('local-peer-token');
        expect(typeof authed.activityToken).toBe('string');
        expect(authed.authUsers).toEqual(SECRETS.authUsers);
        expect(authed.projectKey).toBe('/project/dir');
        expect(authed.remotePeer).toBeUndefined();
      }
    });

    it('is refused at every guarded route', async () => {
      const ns = namespace();
      for (const path of ['/__pyric/diagnostics', '/__pyric/ai-proxy/v1/models', '/__pyric/denials']) {
        expect((await call(ns, path, '10.0.0.5')).status).toBe(403);
      }
    });
  });

  it('enforces host, origin, Sec-Fetch-Site, and optional requireSessionToken guards on /__pyric/events', async () => {
    const { site, sdk } = fixture();
    const events = createEventHub();
    const token = 'events-sec-token';
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      events,
      sessionToken: token,
      requireSessionToken: true,
      boundHost: '127.0.0.1',
    });
    const sandboxEvents = createEventHub();
    const sandboxNs = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      events: sandboxEvents,
      sessionToken: token,
      boundHost: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: ns,
      sessionToken: token,
    });
    const sandboxHandle = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
      logger: silentServeLogger(),
      namespaceHandler: sandboxNs,
      sessionToken: token,
    });
    handles.push(h, sandboxHandle);

    try {
      // 1. Rejected if unapproved Host
      const badHostRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { host: 'attacker.example.com', cookie: `__pyric_session=${token}` },
      });
      expect(badHostRes.status).toBe(403);

      // 2. Rejected if unapproved Origin
      const badOriginRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { origin: 'http://malicious-site.example.com', cookie: `__pyric_session=${token}` },
      });
      expect(badOriginRes.status).toBe(403);

      // 3. Rejected if Sec-Fetch-Site is cross-site even with session cookie
      const crossSiteRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { 'sec-fetch-site': 'cross-site', cookie: `__pyric_session=${token}` },
      });
      expect(crossSiteRes.status).toBe(403);

      // 4. Rejected with 401 when unauthenticated under requireSessionToken: true
      const unauthRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { origin: h.url },
      });
      expect(unauthRes.status).toBe(401);

      // 5. Allowed with loopback origin and valid session cookie
      const controller = new AbortController();
      const allowedRes = await fetch(`${h.url}/__pyric/events`, {
        headers: { origin: h.url, cookie: `__pyric_session=${token}` },
        signal: controller.signal,
      });
      expect(allowedRes.status).toBe(200);
      expect(allowedRes.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();

      // 6. Default sandbox allows loopback without token, but refuses --allowed-host tunnel Host/Origin with 403
      const sandboxTunnel = await fetch(`${sandboxHandle.url}/__pyric/events`, {
        headers: { host: 'preview.tunnel.example' },
      });
      expect(sandboxTunnel.status).toBe(403);
      const sandboxCtrl = new AbortController();
      const sandboxOpen = await fetch(`${sandboxHandle.url}/__pyric/events`, {
        headers: { origin: sandboxHandle.url },
        signal: sandboxCtrl.signal,
      });
      expect(sandboxOpen.status).toBe(200);
      sandboxCtrl.abort();
    } finally {
      events.close();
      sandboxEvents.close();
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

  it('enforces capability token under requireSessionToken and origin isolation on /__pyric/state and /__pyric/capture', async () => {
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
      requireSessionToken: true,
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

  it('allows loopback /__pyric/state and /__pyric/capture without token in default sandbox mode while keeping workspace and ai-proxy gated and refusing tunnel hosts', async () => {
    const { site, sdk } = fixture();
    const stateStore = createStateStore(site);
    stateStore.writeSection('auth', { users: [{ uid: 'admin', password: 'secret-pw' }] });
    let capturedData: string | null = 'sensitive-capture';

    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      state: stateStore,
      capture: { write: (json) => { capturedData = json; }, read: () => capturedData },
      studio: { workspace: diskWorkspace(site) },
      boundHost: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
      logger: silentServeLogger(),
      namespaceHandler: ns,
    });
    handles.push(h);

    // 1. Default sandbox allows loopback state and capture without token
    const unauthState = await fetch(`${h.url}/__pyric/state?section=auth`);
    expect(unauthState.status).toBe(200);
    expect(await unauthState.json()).toEqual({ users: [{ uid: 'admin', password: 'secret-pw' }] });

    const unauthCapture = await fetch(`${h.url}/__pyric/capture`);
    expect(unauthCapture.status).toBe(200);
    expect(await unauthCapture.text()).toBe('sensitive-capture');

    // 2. Tunnel host listed in allowedHosts is refused with 403 on unauthenticated sandbox routes
    expect((await fetch(`${h.url}/__pyric/state?section=auth`, { headers: { host: 'preview.tunnel.example' } })).status).toBe(403);
    expect((await fetch(`${h.url}/__pyric/capture`, { headers: { host: 'preview.tunnel.example' } })).status).toBe(403);
    expect((await fetch(`${h.url}/__pyric/init.json`, { headers: { host: 'preview.tunnel.example' } })).status).toBe(403);

    // 3. Workspace and AI proxy remain 401 without token even in default sandbox mode
    expect((await fetch(`${h.url}/__pyric/workspace?path=index.html`)).status).toBe(401);
    expect((await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, { method: 'POST', body: '{}' })).status).toBe(401);

    // 4. Unauthenticated init.json never leaks sessionToken; same-origin SDK load bootstraps the session cookie for workspace
    const unauthInit = (await (await fetch(`${h.url}/__pyric/init.json`)).json()) as { sessionToken?: string };
    expect(unauthInit.sessionToken).toBeUndefined();

    const sdkLoad = await fetch(`${h.url}/__pyric/sdk/init.js`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const setCookie = sdkLoad.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`__pyric_session_${h.port}=`);
    const cookieHeader = setCookie.split(';')[0]!;

    const authedWorkspace = await fetch(`${h.url}/__pyric/workspace?path=index.html`, {
      headers: { cookie: cookieHeader },
    });
    expect(authedWorkspace.status).toBe(200);
  });

  it('always requires session capability on ai-proxy and gemini-proxy while keeping diagnostics and denials loopback-open in default sandbox mode', async () => {
    const { site, sdk } = fixture();
    const token = 'proxy-diag-denial-token';
    const upstream = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return true;
      },
    });
    handles.push(upstream);

    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      sessionToken: token,
      boundHost: '127.0.0.1',
      aiProxyUpstream: `${upstream.url}/__pyric`,
    });
    const h = await startStaticServer({
      publicDir: site,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
      namespaceHandler: ns,
      sessionToken: token,
    });
    handles.push(h);

    const otherPort = h.port === 3000 ? 3001 : 3000;
    const routes: Array<{ path: string; method: string; body?: string; requiresTokenInSandbox: boolean; okStatus?: number }> = [
      { path: '/__pyric/diagnostics', method: 'GET', requiresTokenInSandbox: false, okStatus: 200 },
      { path: '/__pyric/ai-proxy/chat/completions', method: 'POST', body: '{}', requiresTokenInSandbox: true },
      { path: '/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.0-flash:generateContent', method: 'POST', body: '{}', requiresTokenInSandbox: true },
      { path: '/__pyric/denials', method: 'POST', body: JSON.stringify({ message: 'denied' }), requiresTokenInSandbox: false, okStatus: 204 },
    ];

    for (const route of routes) {
      const unauth = await fetch(`${h.url}${route.path}`, {
        method: route.method,
        headers: route.body ? { 'content-type': 'application/json' } : undefined,
        body: route.body,
      });
      expect(unauth.status).toBe(route.requiresTokenInSandbox ? 401 : route.okStatus!);

      // Cross-port Origin even WITH valid session cookie -> 403
      const crossPort = await fetch(`${h.url}${route.path}`, {
        method: route.method,
        headers: {
          cookie: `__pyric_session=${token}`,
          origin: `http://127.0.0.1:${otherPort}`,
          ...(route.body ? { 'content-type': 'application/json' } : {}),
        },
        body: route.body,
      });
      expect(crossPort.status).toBe(403);

      // Sec-Fetch-Site: cross-site without Origin even WITH valid session cookie -> 403
      const crossSite = await fetch(`${h.url}${route.path}`, {
        method: route.method,
        headers: {
          cookie: `__pyric_session=${token}`,
          'sec-fetch-site': 'cross-site',
          ...(route.body ? { 'content-type': 'application/json' } : {}),
        },
        body: route.body,
      });
      expect(crossSite.status).toBe(403);
    }

    // Authenticated same-origin requests succeed (never 401/403)
    expect((await fetch(`${h.url}/__pyric/diagnostics`, { headers: { 'x-pyric-session-token': token } })).status).toBe(200);
    expect((await fetch(`${h.url}/__pyric/ai-proxy/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `__pyric_session=${token}` },
      body: '{}',
    })).status).toBe(200);
    expect((await fetch(`${h.url}/__pyric/denials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-session-token': token },
      body: JSON.stringify({ message: 'denied' }),
    })).status).toBe(204);
  });

  it('refuses a request whose Origin is another local port', async () => {
    const { site, sdk } = fixture();
    const state: StateStore = {
      projectDir: site,
      path: join(site, 'state.json'),
      backupPath: join(site, 'state.json.bak'),
      exists: () => true,
      load: () => ({ version: 1, firestore: null, auth: null }),
      readSection: () => null,
      writeSection: () => {},
    };
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      state,
      sessionToken: 'origin-token',
      boundHost: '127.0.0.1',
    });
    const h = await startStaticServer({
      publicDir: site, port: 0, host: '127.0.0.1', logger: silentServeLogger(), namespaceHandler: ns,
    });
    handles.push(h);
    const headers = { 'x-pyric-session-token': 'origin-token' };
    const sameOrigin = await fetch(`${h.url}/__pyric/state`, { headers: { ...headers, origin: new URL(h.url).origin } });
    expect(sameOrigin.status).toBe(200);
    const otherPort = h.port === 3000 ? 3001 : 3000;
    const crossPort = await fetch(`${h.url}/__pyric/state`, { headers: { ...headers, origin: `http://127.0.0.1:${otherPort}` } });
    expect(crossPort.status).toBe(403);
    expect(await crossPort.text()).toContain('origin');
  });

  it('serves the bytes a state export refers to by hash, to the session only', async () => {
    const { site, sdk } = fixture();
    const sha256 = 'c'.repeat(64);
    const file = join(site, 'object.bin');
    writeFileSync(file, 'object bytes');
    const reference = { path: 'media/take.wav', sha256, size: 12, blobType: 'audio/wav', metadata: {} };
    const state: StateStore = {
      projectDir: site,
      path: join(site, 'state.sqlite'),
      backupPath: join(site, 'state.archive'),
      exists: () => true,
      load: () => ({ version: 1, firestore: null, auth: null, storage: [reference] as never }),
      readSection: (section) => (section === 'storage' ? [reference] : null),
      writeSection: () => {},
      objectFile: (hash) => (hash === sha256 ? file : undefined),
    };
    const ns = createPyricNamespace({
      sdkDir: sdk,
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
      state,
      sessionToken: 'export-token',
      requireSessionToken: true,
      boundHost: '127.0.0.1',
    });
    const h = await startStaticServer({
      publicDir: site, port: 0, host: '127.0.0.1', logger: silentServeLogger(), namespaceHandler: ns,
    });
    handles.push(h);
    const headers = { 'x-pyric-session-token': 'export-token' };
    const exported = await fetch(`${h.url}/__pyric/state?section=storage`, { headers });
    expect(await exported.json()).toEqual([reference]);

    const object = await fetch(`${h.url}/__pyric/state/objects/${sha256}`, { headers });
    expect(object.status).toBe(200);
    expect(object.headers.get('content-length')).toBe('12');
    expect(await object.text()).toBe('object bytes');

    expect((await fetch(`${h.url}/__pyric/state/objects/${sha256}`)).status).toBe(401);
    expect((await fetch(`${h.url}/__pyric/state/objects/${'d'.repeat(64)}`, { headers })).status).toBe(404);
    expect((await fetch(`${h.url}/__pyric/state/objects/..%2Fstate.sqlite`, { headers })).status).toBe(400);
  });
});
