/**
 * Local-surface and loopback route security hardening (ADR 0024 Decision 5):
 *   1. Per-boot capability token (`x-pyric-session-token`, `?token=`, or
 *      `__pyric_session` `HttpOnly; SameSite=Strict; Path=/__pyric` cookie)
 *      required (`401` on HTTP, upgrade refused on WS) on all state-bearing,
 *      cost-bearing, and mutating `/__pyric/*` routes; minimal readiness probes
 *      on `/__pyric/init.json` and `/__pyric/health`.
 *   2. Cross-origin (`Origin`) and cross-site (`Sec-Fetch-Site: cross-site` /
 *      `same-site` without `Origin`) refusal (`403`) enforced before token/cookie
 *      checks so ambient `localhost` cookies never authorize another origin/port.
 *   3. Loopback `Host` header enforced unconditionally on `/__pyric/*` and
 *      `WS /__pyric/sandbox` even when `allowedHosts: true` is configured, and
 *      `.pyric/serve.json` / `.pyric/session.json` written with `0o600` mode.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { WebSocket } from 'ws';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';
import { pyric } from '../../src/serve/vite-plugin.js';

function rawHttpRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
`;

const runtimes: ServeRuntime[] = [];
const viteServers: ViteDevServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (viteServers.length) {
    await viteServers.pop()!.close();
  }
  while (runtimes.length) {
    await runtimes.pop()!.handle.stop();
  }
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function createProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-loopback-security-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, 'public'), { recursive: true });
  writeFileSync(join(cwd, 'public', 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>');
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-security' } }));
  writeFileSync(
    join(cwd, 'firebase.json'),
    JSON.stringify({
      firestore: { rules: 'firestore.rules' },
      hosting: { public: 'public' },
    }),
  );
  writeFileSync(join(cwd, 'firestore.rules'), RULES);
  writeFileSync(join(cwd, 'seed.json'), JSON.stringify({ 'users/u1': { name: 'Ada' } }));
  return cwd;
}

describe('loopback route security hardening (ADR 0024 Decision 5)', () => {
  it('writes .pyric/serve.json and .pyric/session.json with owner-only 0o600 permissions', async () => {
    const bridgeCwd = createProject();
    const bridgeRuntime = await startServe({
      cwd: bridgeCwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(bridgeCwd, '.cache'),
      bridge: true,
      persist: true,
      seed: 'seed.json',
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(bridgeRuntime);

    const sessionCwd = createProject();
    const sessionRuntime = await startServe({
      cwd: sessionCwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(sessionCwd, '.cache'),
      bridge: false,
      persist: true,
      seed: 'seed.json',
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(sessionRuntime);

    if (process.platform !== 'win32') {
      const serveMode = statSync(join(bridgeCwd, '.pyric', 'serve.json')).mode & 0o777;
      const sessionMode = statSync(join(sessionCwd, '.pyric', 'session.json')).mode & 0o777;
      expect(serveMode).toBe(0o600);
      expect(sessionMode).toBe(0o600);
    }
  }, 30_000);

  it('serves minimal readiness payloads without a token and mints an HttpOnly SameSite=Strict cookie when authenticated', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      seed: 'seed.json',
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const base = runtime.handle.url;

    const unauthInitRes = await fetch(`${base}/__pyric/init.json`);
    expect(unauthInitRes.status).toBe(200);
    expect(unauthInitRes.headers.get('set-cookie')).toBeNull();
    const unauthInit = (await unauthInitRes.json()) as Record<string, unknown>;
    expect(typeof unauthInit.rulesHash).toBe('string');
    expect(unauthInit.rules).toBeUndefined();
    expect(unauthInit.seed).toBeUndefined();
    expect(unauthInit.sessionToken).toBeUndefined();
    expect(unauthInit.bridgeUrl).toBeUndefined();

    const unauthHealthRes = await fetch(`${base}/__pyric/health`);
    expect(unauthHealthRes.status).toBe(200);
    const unauthHealth = (await unauthHealthRes.json()) as Record<string, unknown>;
    expect(unauthHealth).toEqual({
      status: 'ok',
      mode: 'sandbox',
      instanceId: expect.any(String),
      sandboxConnected: false,
    });
    expect(unauthHealth.project).toBeUndefined();
    expect(unauthHealth.version).toBeUndefined();

    expect((await fetch(`${base}/__pyric/init.json`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/__pyric/health`, { method: 'POST' })).status).toBe(405);

    const authInitRes = await fetch(`${base}/__pyric/init.json`, {
      headers: { 'x-pyric-session-token': runtime.sessionToken },
    });
    expect(authInitRes.status).toBe(200);
    const setCookie = authInitRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`__pyric_session=${encodeURIComponent(runtime.sessionToken)}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/__pyric');
    const authInit = (await authInitRes.json()) as Record<string, unknown>;
    expect(authInit.rules).toContain("rules_version = '2'");
    expect(authInit.sessionToken).toBe(runtime.sessionToken);

    const cookiePair = setCookie.split(';')[0]!;
    const cookieEvents = await fetch(`${base}/__pyric/events`, {
      headers: { cookie: cookiePair },
    });
    expect(cookieEvents.status).toBe(200);
    await cookieEvents.body?.cancel();
  }, 30_000);

  it('refuses unauthenticated requests with 401 across control, diagnostics, AI proxy, MCP, and WS routes', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      capture: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const base = runtime.handle.url;

    const unauthRoutes: Array<[string, string]> = [
      ['GET', '/__pyric/diagnostics'],
      ['GET', '/__pyric/events'],
      ['POST', '/__pyric/denials'],
      ['POST', '/__pyric/ai-proxy/chat/completions'],
      ['POST', '/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent'],
      ['POST', '/__pyric/mcp'],
      ['GET', '/__pyric/thresholds'],
      ['PUT', '/__pyric/thresholds'],
      ['GET', '/__pyric/indexes'],
      ['POST', '/__pyric/indexes'],
      ['GET', '/__pyric/state'],
      ['POST', '/__pyric/state?section=firestore'],
      ['GET', '/__pyric/rate-captures'],
      ['GET', '/__pyric/capture'],
    ];

    for (const [method, path] of unauthRoutes) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: method === 'POST' || method === 'PUT' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' || method === 'PUT' ? '{}' : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      await res.arrayBuffer();
    }

    const ws = new WebSocket(`ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`);
    const wsOpened = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      ws.once('close', () => resolve(false));
    });
    expect(wsOpened).toBe(false);
  }, 30_000);

  it('refuses cross-port Origin, Sec-Fetch-Site: cross-site/same-site, and DNS-rebound Host even with a valid cookie/token', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const base = runtime.handle.url;
    const cookie = `__pyric_session=${encodeURIComponent(runtime.sessionToken)}`;

    // Public asset honors explicit --allowed-host…
    const publicRes = await rawHttpRequest({
      port: runtime.handle.port,
      path: '/',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(publicRes.status).toBe(200);

    // …while every /__pyric/* route and WS upgrade refuses non-allowlisted Host even with valid credentials.
    for (const path of ['/__pyric/init.json', '/__pyric/health', '/__pyric/diagnostics', '/__pyric/mcp']) {
      const res = await rawHttpRequest({
        port: runtime.handle.port,
        path,
        method: path === '/__pyric/mcp' ? 'POST' : 'GET',
        headers: {
          host: 'app.evil.test',
          cookie,
          'x-pyric-session-token': runtime.sessionToken,
          ...(path === '/__pyric/mcp' ? { 'content-type': 'application/json' } : {}),
        },
        body: path === '/__pyric/mcp' ? '{}' : undefined,
      });
      expect(res.status, `rebound Host on ${path}`).toBe(403);
    }

    const reboundWs = new WebSocket(
      `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox?token=${encodeURIComponent(runtime.sessionToken)}`,
      { headers: { Host: 'app.evil.test', Origin: `http://127.0.0.1:${runtime.handle.port}` } },
    );
    const reboundOpened = await new Promise<boolean>((resolve) => {
      reboundWs.once('open', () => resolve(true));
      reboundWs.on('error', () => resolve(false));
      reboundWs.once('close', () => resolve(false));
    });
    expect(reboundOpened).toBe(false);

    // Cross-port localhost Origin + ambient __pyric_session cookie is refused with 403 before cookie evaluation.
    const crossPortRes = await fetch(`${base}/__pyric/diagnostics`, {
      headers: {
        origin: `http://127.0.0.1:${runtime.handle.port + 1}`,
        cookie,
        'x-pyric-session-token': runtime.sessionToken,
      },
    });
    expect(crossPortRes.status).toBe(403);
    await crossPortRes.arrayBuffer();

    // Browser cross-site / same-site navigation/subresource without Origin (e.g. GET / SSE / script) is refused with 403.
    for (const site of ['cross-site', 'same-site'] as const) {
      const fetchSiteRes = await fetch(`${base}/__pyric/events`, {
        headers: {
          'sec-fetch-site': site,
          cookie,
          'x-pyric-session-token': runtime.sessionToken,
        },
      });
      expect(fetchSiteRes.status, `sec-fetch-site=${site}`).toBe(403);
      await fetchSiteRes.arrayBuffer();
    }
  }, 30_000);

  it('refuses non-loopback Host on /__pyric/* and WS /__pyric/sandbox even when Vite server.allowedHosts is true', async () => {
    const cwd = createProject();
    writeFileSync(join(cwd, 'index.html'), '<!doctype html><html><head></head><body>vite ok</body></html>');
    const viteServer = await createViteServer({
      configFile: false,
      root: cwd,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: true,
      },
      plugins: [pyric({ bridge: { disableAuditLog: true }, ui: false })],
    });
    await viteServer.listen();
    viteServers.push(viteServer);
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('expected bound TCP port');
    const port = address.port;

    // Fetch local HTML to obtain the generation's stamped session token and cookie.
    const localHtml = await fetch(`http://127.0.0.1:${port}/`);
    expect(localHtml.status).toBe(200);
    const setCookie = localHtml.headers.get('set-cookie') ?? '';
    const htmlBody = await localHtml.text();
    const token = htmlBody.match(/"sessionToken":"([^"]+)"/)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(10);
    const cookie = setCookie.split(';')[0] ?? '';

    // Vite's public page honors server.allowedHosts: true…
    const tunnelPage = await rawHttpRequest({
      port,
      path: '/',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(tunnelPage.status).toBe(200);

    // …while Pyric's local surfaces still enforce loopback Host unconditionally.
    for (const path of ['/__pyric/init.json', '/__pyric/health', '/__pyric/diagnostics', '/__pyric/mcp']) {
      const res = await rawHttpRequest({
        port,
        path,
        method: path === '/__pyric/mcp' ? 'POST' : 'GET',
        headers: {
          host: 'app.evil.test',
          cookie,
          'x-pyric-session-token': token,
          ...(path === '/__pyric/mcp' ? { 'content-type': 'application/json' } : {}),
        },
        body: path === '/__pyric/mcp' ? '{}' : undefined,
      });
      expect(res.status, `Vite allowedHosts:true rebound Host on ${path}`).toBe(403);
    }

    const reboundWs = new WebSocket(
      `ws://127.0.0.1:${port}/__pyric/sandbox?token=${encodeURIComponent(token)}`,
      { headers: { Host: 'app.evil.test', Origin: `http://127.0.0.1:${port}` } },
    );
    const reboundOpened = await new Promise<boolean>((resolve) => {
      reboundWs.once('open', () => resolve(true));
      reboundWs.on('error', () => resolve(false));
      reboundWs.once('close', () => resolve(false));
    });
    expect(reboundOpened).toBe(false);
  }, 30_000);
});
