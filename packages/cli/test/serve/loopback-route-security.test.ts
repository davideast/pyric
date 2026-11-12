/**
 * Local-surface and loopback route security hardening (ADR 0024 Decision 5):
 *   1. Live mode (`liveHost`) and explicit `--session-token` / `sessionToken: true`
 *      require a per-boot capability token (`x-pyric-session-token` or
 *      `__pyric_session` `HttpOnly; SameSite=Strict; Path=/__pyric` cookie;
 *      never `?token=`) across every `/__pyric/*` route, MCP, and `WS /__pyric/sandbox`,
 *      with minimal readiness probes on `/__pyric/init.json` and `/__pyric/health`.
 *   2. Default sandbox mode requires the session token only on project-file routes
 *      (`/__pyric/workspace*`, `/__pyric/projects*`), the AI proxy (`/__pyric/ai-proxy*`),
 *      and `/__pyric/live/*`, while never returning `sessionToken` on unauthenticated
 *      `GET /__pyric/init.json` and never writing `.pyric/capability-token`.
 *   3. Unauthenticated routes accept loopback/`boundHost` names only (refusing
 *      `--allowed-host` / `server.allowedHosts` tunnel hosts with `403` / WS destroy).
 *   4. Cross-origin (`Origin`), cross-site (`Sec-Fetch-Site: cross-site` / `same-site`
 *      without `Origin`), and `allowedHosts: true` non-loopback `Host` refusal (`403`)
 *      remain enforced in every mode, and `.pyric/serve.json` / `.pyric/session.json`
 *      are written with `0o600` mode.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { WebSocket } from 'ws';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { pyric } from '../../src/serve/vite-plugin.js';

function rawHttpRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function tryWsUpgrade(url: string, headers?: Record<string, string>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    ws.once('open', () => {
      finish(true);
      ws.close();
    });
    ws.on('error', () => finish(false));
    ws.once('close', () => finish(false));
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
const staticHandles: ServeHandle[] = [];
const viteServers: ViteDevServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (viteServers.length) {
    await viteServers.pop()!.close();
  }
  while (staticHandles.length) {
    await staticHandles.pop()!.stop();
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
  it('writes 0o600 .pyric/serve.json and .pyric/session.json, omits ?token= from mcpUrl, and never writes .pyric/capability-token', async () => {
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

    expect(existsSync(join(bridgeCwd, '.pyric', 'capability-token'))).toBe(false);
    expect(existsSync(join(sessionCwd, '.pyric', 'capability-token'))).toBe(false);
    expect(bridgeRuntime.mcpUrl).toBe(`${bridgeRuntime.handle.url}/__pyric/mcp`);
    const pointer = JSON.parse(readFileSync(join(bridgeCwd, '.pyric', 'serve.json'), 'utf8')) as {
      mcpUrl?: string;
      token?: string;
    };
    expect(pointer.mcpUrl).toBe(`${bridgeRuntime.handle.url}/__pyric/mcp`);
    expect(pointer.token).toBe(bridgeRuntime.sessionToken);

    if (process.platform !== 'win32') {
      const serveMode = statSync(join(bridgeCwd, '.pyric', 'serve.json')).mode & 0o777;
      const sessionMode = statSync(join(sessionCwd, '.pyric', 'session.json')).mode & 0o777;
      expect(serveMode).toBe(0o600);
      expect(sessionMode).toBe(0o600);
    }
  }, 30_000);

  it('scopes token enforcement in default sandbox mode to workspace, projects, and ai-proxy while never leaking sessionToken on unauthenticated init.json', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      capture: true,
      ui: true,
      seed: 'seed.json',
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const base = runtime.handle.url;

    // Unauthenticated loopback init.json returns sandbox init without sessionToken or Set-Cookie.
    const unauthInitRes = await fetch(`${base}/__pyric/init.json`);
    expect(unauthInitRes.status).toBe(200);
    expect(unauthInitRes.headers.get('set-cookie')).toBeNull();
    const unauthInit = (await unauthInitRes.json()) as Record<string, unknown>;
    expect(unauthInit.sessionToken).toBeUndefined();
    expect(String(unauthInit.rules ?? '')).toContain("rules_version = '2'");
    expect(unauthInit.bridgeUrl).toBe(`ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`);

    // Unauthenticated loopback health returns full sandbox health.
    const unauthHealthRes = await fetch(`${base}/__pyric/health`);
    expect(unauthHealthRes.status).toBe(200);
    const unauthHealth = (await unauthHealthRes.json()) as Record<string, unknown>;
    expect(unauthHealth.status).toBe('ok');
    expect(unauthHealth.mode).toBe('sandbox');
    expect(typeof unauthHealth.project).toBe('string');

    expect((await fetch(`${base}/__pyric/init.json`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/__pyric/health`, { method: 'POST' })).status).toBe(405);

    // High-risk project-file and AI-proxy routes still require sessionToken (401 without).
    for (const [method, path] of [
      ['GET', '/__pyric/workspace?path=firestore.rules'],
      ['GET', '/__pyric/workspace/list'],
      ['GET', '/__pyric/projects'],
      ['POST', '/__pyric/ai-proxy/chat/completions'],
      ['POST', '/__pyric/ai-proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent'],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(res.status, `${method} ${path} should require session token`).toBe(401);
      await res.arrayBuffer();
    }

    // Sandbox-only routes and WS /__pyric/sandbox answer loopback callers without a token.
    for (const [method, path] of [
      ['GET', '/__pyric/diagnostics'],
      ['POST', '/__pyric/denials'],
      ['GET', '/__pyric/thresholds'],
      ['GET', '/__pyric/indexes'],
      ['GET', '/__pyric/state'],
      ['GET', '/__pyric/rate-captures'],
      ['GET', '/__pyric/capture'],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(res.status, `${method} ${path} should not return 401`).not.toBe(401);
      expect(res.status, `${method} ${path} should not return 403`).not.toBe(403);
      await res.arrayBuffer();
    }
    const eventsRes = await fetch(`${base}/__pyric/events`);
    expect(eventsRes.status).toBe(200);
    await eventsRes.body?.cancel();

    const mcpInitRes = await fetch(`${base}/__pyric/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    expect(mcpInitRes.status).toBe(200);
    await mcpInitRes.text();

    expect(await tryWsUpgrade(`ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`)).toBe(true);

    // Authenticated init.json stamps sessionToken and mints HttpOnly SameSite=Strict cookie.
    const authInitRes = await fetch(`${base}/__pyric/init.json`, {
      headers: { 'x-pyric-session-token': runtime.sessionToken },
    });
    expect(authInitRes.status).toBe(200);
    const setCookie = authInitRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`__pyric_session_${runtime.handle.port}=${encodeURIComponent(runtime.sessionToken)}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/__pyric');
    const authInit = (await authInitRes.json()) as Record<string, unknown>;
    expect(authInit.sessionToken).toBe(runtime.sessionToken);

    const cookiePair = setCookie.split(';')[0]!;
    const authedWorkspace = await fetch(`${base}/__pyric/workspace?path=firestore.rules`, {
      headers: { cookie: cookiePair },
    });
    expect(authedWorkspace.status).toBe(200);
  }, 30_000);

  it('enforces sessionToken across every route when opted in via sessionToken/pyric.json and unconditionally in live mode (ignoring pyric.json sessionToken: false and rejecting ?token=)', async () => {
    const cwd = createProject();
    writeFileSync(join(cwd, 'pyric.json'), JSON.stringify({ sessionToken: true }));
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

    const unauthInit = (await (await fetch(`${base}/__pyric/init.json`)).json()) as Record<string, unknown>;
    expect(unauthInit.rules).toBeUndefined();
    expect(unauthInit.sessionToken).toBeUndefined();
    expect(typeof unauthInit.rulesHash).toBe('string');

    const unauthHealth = (await (await fetch(`${base}/__pyric/health`)).json()) as Record<string, unknown>;
    expect(unauthHealth.project).toBeUndefined();

    const gatedRoutes: Array<[string, string]> = [
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

    for (const [method, path] of gatedRoutes) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: method === 'POST' || method === 'PUT' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' || method === 'PUT' ? '{}' : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      await res.arrayBuffer();
    }

    // ?token= query parameter is rejected on both HTTP and WS.
    const queryDiag = await fetch(`${base}/__pyric/diagnostics?token=${encodeURIComponent(runtime.sessionToken)}`);
    expect(queryDiag.status).toBe(401);
    expect(await tryWsUpgrade(`ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`)).toBe(false);
    expect(
      await tryWsUpgrade(
        `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox?token=${encodeURIComponent(runtime.sessionToken)}`,
      ),
    ).toBe(false);
    expect(
      await tryWsUpgrade(`ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`, {
        'x-pyric-session-token': runtime.sessionToken,
      }),
    ).toBe(true);

    // Live mode ignores pyric.json { sessionToken: false } and still requires token on every route.
    const liveCwd = createProject();
    writeFileSync(join(liveCwd, 'pyric.json'), JSON.stringify({ sessionToken: false }));
    const liveRuntime = await startServe({
      cwd: liveCwd,
      port: 0,
      host: '127.0.0.1',
      cacheRoot: join(liveCwd, '.cache'),
      bridge: true,
      sessionToken: false,
      disableAuditLog: true,
      logger: silentServeLogger(),
      liveHost: {
        project: { projectId: 'demo-security', source: '.firebaserc' },
        writeRefusal: (write) => new Error(`refused ${write.action}`),
      },
    });
    runtimes.push(liveRuntime);
    expect((await fetch(`${liveRuntime.handle.url}/__pyric/diagnostics`)).status).toBe(401);
    expect((await fetch(`${liveRuntime.handle.url}/__pyric/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(await tryWsUpgrade(`ws://127.0.0.1:${liveRuntime.handle.port}/__pyric/sandbox`)).toBe(false);
  }, 45_000);

  it('refuses --allowed-host tunnel Hosts on unauthenticated routes while honoring cross-port Origin, Sec-Fetch-Site, and DNS-rebinding guards', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      ui: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const base = runtime.handle.url;
    const cookie = `__pyric_session=${encodeURIComponent(runtime.sessionToken)}`;

    // Public asset honors explicit --allowed-host without minting cookie or stamping token…
    const publicRes = await rawHttpRequest({
      port: runtime.handle.port,
      path: '/',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers['set-cookie']).toBeUndefined();
    expect(publicRes.body).not.toContain(runtime.sessionToken);

    // …while EVERY unauthenticated sandbox route and WS upgrade refuses the tunnel Host with 403 / destroy!
    for (const path of [
      '/__pyric/init.json',
      '/__pyric/health',
      '/__pyric/diagnostics',
      '/__pyric/state',
      '/__pyric/events',
      '/__pyric/mcp',
      '/__pyric/flow/manifest.json',
    ]) {
      const res = await rawHttpRequest({
        port: runtime.handle.port,
        path,
        method: path === '/__pyric/mcp' ? 'POST' : 'GET',
        headers: {
          host: 'preview.tunnel.example',
          ...(path === '/__pyric/mcp' ? { 'content-type': 'application/json' } : {}),
        },
        body: path === '/__pyric/mcp' ? '{}' : undefined,
      });
      expect(res.status, `tunnel Host on unauthenticated ${path}`).toBe(403);
    }
    expect(
      await tryWsUpgrade(`ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`, {
        Host: 'preview.tunnel.example',
        Origin: 'http://preview.tunnel.example',
      }),
    ).toBe(false);

    // Token-gated routes return 401 without token on tunnel Host, and non-allowlisted Host returns 403 even with credentials.
    const unauthTunnelWorkspace = await rawHttpRequest({
      port: runtime.handle.port,
      path: '/__pyric/workspace?path=firestore.rules',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(unauthTunnelWorkspace.status).toBe(401);

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

    expect(
      await tryWsUpgrade(`ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`, {
        Host: 'app.evil.test',
        Origin: `http://127.0.0.1:${runtime.handle.port}`,
        'x-pyric-session-token': runtime.sessionToken,
      }),
    ).toBe(false);

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

    // Browser cross-site / same-site navigation/subresource without Origin is refused with 403.
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

  it('refuses non-loopback and tunnel Hosts on unauthenticated Vite /__pyric/* routes under both server.allowedHosts: true and explicit server.allowedHosts', async () => {
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

    // Vite's public page honors server.allowedHosts: true without stamping session capabilities.
    const tunnelPage = await rawHttpRequest({
      port,
      path: '/',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(tunnelPage.status).toBe(200);
    expect(tunnelPage.body).not.toContain(token);
    expect(tunnelPage.headers['set-cookie']).toBeUndefined();

    // Foreign iframe and subresource fetches never bootstrap session capabilities on Vite HTML.
    const crossPortIframe = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    });
    expect(crossPortIframe.status).toBe(200);
    expect(crossPortIframe.body).not.toContain(token);
    expect(crossPortIframe.headers['set-cookie']).toBeUndefined();

    const foreignSubresource = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'empty',
      },
    });
    expect(foreignSubresource.status).toBe(200);
    expect(foreignSubresource.body).not.toContain(token);
    expect(foreignSubresource.headers['set-cookie']).toBeUndefined();

    // Top-level document navigations and same-origin iframes still bootstrap cleanly.
    const topLevelNav = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(topLevelNav.status).toBe(200);
    expect(topLevelNav.body).toContain(token);
    expect(String(topLevelNav.headers['set-cookie'] ?? '')).toContain(`__pyric_session_${port}=`);

    const sameOriginIframe = await rawHttpRequest({
      port,
      path: '/',
      headers: {
        host: `127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    });
    expect(sameOriginIframe.status).toBe(200);
    expect(sameOriginIframe.body).toContain(token);
    expect(String(sameOriginIframe.headers['set-cookie'] ?? '')).toContain(`__pyric_session_${port}=`);

    // …while Pyric's local surfaces still enforce loopback Host unconditionally.
    for (const path of ['/__pyric/init.json', '/__pyric/health', '/__pyric/diagnostics', '/__pyric/mcp', '/__pyric/flow/manifest.json']) {
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

    expect(
      await tryWsUpgrade(`ws://127.0.0.1:${port}/__pyric/sandbox`, {
        Host: 'app.evil.test',
        Origin: `http://127.0.0.1:${port}`,
        'x-pyric-session-token': token,
      }),
    ).toBe(false);
    await viteServers.pop()!.close();

    // Vite opt-in pyric({ sessionToken: true }) enforces 401 on unauthenticated loopback routes.
    const strictCwd = createProject();
    writeFileSync(join(strictCwd, 'index.html'), '<!doctype html><html><head></head><body>strict vite</body></html>');
    const strictVite = await createViteServer({
      configFile: false,
      root: strictCwd,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['preview.tunnel.example'],
      },
      plugins: [pyric({ sessionToken: true, bridge: { disableAuditLog: true }, ui: false })],
    });
    await strictVite.listen();
    viteServers.push(strictVite);
    const strictAddr = strictVite.httpServer?.address();
    if (!strictAddr || typeof strictAddr === 'string') throw new Error('expected bound TCP port');
    expect((await fetch(`http://127.0.0.1:${strictAddr.port}/__pyric/diagnostics`)).status).toBe(401);
    expect(
      (
        await rawHttpRequest({
          port: strictAddr.port,
          path: '/__pyric/init.json',
          headers: { host: 'preview.tunnel.example' },
        })
      ).status,
    ).toBe(403);
  }, 30_000);

  it('guards static server and Studio HTML bootstrap against tunnel Hosts and foreign iframes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-studio-bootstrap-'));
    dirs.push(root);
    const publicDir = join(root, 'public');
    const sdkDir = join(root, 'sdk');
    const siteUiDir = join(root, 'site');
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(join(siteUiDir, 'studio'), { recursive: true });
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
    writeFileSync(join(sdkDir, 'entry.js'), 'export {};\n');
    writeFileSync(join(siteUiDir, 'studio-routes.json'), JSON.stringify({ routes: ['studio'] }));
    writeFileSync(join(siteUiDir, 'studio', 'index.html'), '<!doctype html><html><head></head><body>studio</body></html>');

    const token = 'studio-secret-session-token';
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
      sdkDir,
      siteUiDir,
      workerVersion: '0123456789abcdef',
      sessionToken: token,
      initPayload: () => ({
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
      }),
    });
    const handle = await startStaticServer({
      publicDir,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['preview.tunnel.example'],
      namespaceHandler: ns,
      sessionToken: token,
      transformHtml: (html, ctx) =>
        ctx.localPeer ? html.replace('</head>', `<script>window.__TOK=${JSON.stringify(token)}</script></head>`) : html,
      logger: silentServeLogger(),
    });
    staticHandles.push(handle);

    // Allowed tunnel Host serves public/Studio HTML without stamping token or minting cookie.
    const tunnelApp = await rawHttpRequest({
      port: handle.port,
      path: '/',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(tunnelApp.status).toBe(200);
    expect(tunnelApp.body).not.toContain(token);
    expect(tunnelApp.headers['set-cookie']).toBeUndefined();

    const tunnelStudio = await rawHttpRequest({
      port: handle.port,
      path: '/__pyric/ui/studio/',
      headers: { host: 'preview.tunnel.example' },
    });
    expect(tunnelStudio.status).toBe(403);
    expect(tunnelStudio.body).not.toContain(token);
    expect(tunnelStudio.headers['set-cookie']).toBeUndefined();

    // Cross-port iframe on Studio HTML gets SAMEORIGIN framing protection and zero token/cookie.
    const framedStudio = await rawHttpRequest({
      port: handle.port,
      path: '/__pyric/ui/studio/',
      headers: {
        host: `127.0.0.1:${handle.port}`,
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'iframe',
      },
    });
    expect(framedStudio.status).toBe(200);
    expect(framedStudio.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(framedStudio.body).not.toContain(token);
    expect(framedStudio.headers['set-cookie']).toBeUndefined();

    // Top-level local navigation to Studio HTML stamps token and sets HttpOnly cookie.
    const localStudio = await rawHttpRequest({
      port: handle.port,
      path: '/__pyric/ui/studio/',
      headers: {
        host: `127.0.0.1:${handle.port}`,
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    });
    expect(localStudio.status).toBe(200);
    expect(localStudio.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(localStudio.body).toContain(token);
    expect(String(localStudio.headers['set-cookie'] ?? '')).toContain(`__pyric_session_${handle.port}=`);
  });

  it('requires session token on flow bundles, refuses unauthenticated storage existence probes, and fails closed in Vite middlewareMode / pre-middleware SSR', async () => {
    const cwd = createProject();
    writeFileSync(
      join(cwd, 'storage.rules'),
      "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /items/{id} { allow read, write: if true; }\n  }\n}\n",
    );
    writeFileSync(join(cwd, 'custom-flow.js'), "export const flowLabel = 'internal-flow-module';\n");
    const rawHtml = '<!doctype html><html><head><title>App</title></head><body><div id="app"></div></body></html>';
    writeFileSync(join(cwd, 'index.html'), rawHtml);

    const customSsrPlugin = {
      name: 'custom-ssr-shell',
      enforce: 'pre' as const,
      configureServer(srv: import('vite').ViteDevServer) {
        srv.middlewares.use(async (req, res, next) => {
          if (req.url === '/ssr-page') {
            const html = await srv.transformIndexHtml(req.url, rawHtml);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(html);
            return;
          }
          next();
        });
      },
    };

    const ssrVite = await createViteServer({
      configFile: false,
      root: cwd,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: ['tunnel.example'],
      },
      plugins: [
        customSsrPlugin,
        pyric({
          bridge: { disableAuditLog: true },
          sessionToken: true,
          ui: false,
          flow: {
            treatments: [{ id: 'org:custom-one', label: 'Custom One', module: './custom-flow.js' }],
          },
        }),
      ],
    });
    await ssrVite.listen();
    viteServers.push(ssrVite);
    const addr = ssrVite.httpServer?.address();
    if (!addr || typeof addr === 'string') throw new Error('expected bound TCP port');
    const port = addr.port;

    const flowManifest = await rawHttpRequest({
      port,
      path: '/__pyric/flow/manifest.json',
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(flowManifest.status).toBe(401);

    const flowBundle = await rawHttpRequest({
      port,
      path: '/__pyric/flow/custom/org%3Acustom-one.js',
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(flowBundle.status).toBe(401);

    const storageTunnel = await rawHttpRequest({
      port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media',
      headers: { host: 'tunnel.example' },
    });
    expect(storageTunnel.status).toBe(403);

    const { createStorageByteRoute } = await import('../../src/serve/hosted/storage-byte-route.js');
    let probedObjectFile = false;
    const byteRoute = createStorageByteRoute({
      storage: {
        async objectFile() {
          probedObjectFile = true;
          return undefined;
        },
        async appendUpload() {
          throw new Error('unexpected');
        },
        async uploadProgress() {
          return undefined;
        },
      },
      sessionToken: 'byte-route-secret',
      uploadToken: () => undefined,
    });
    const byteServer = await startStaticServer({
      publicDir: null,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: (req, res, url) => byteRoute(req, res, url),
      logger: silentServeLogger(),
    });
    staticHandles.push(byteServer);

    const storageLoopbackNoToken = await rawHttpRequest({
      port: byteServer.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media',
      headers: { host: `127.0.0.1:${byteServer.port}` },
    });
    expect(storageLoopbackNoToken.status).toBe(403);
    expect(storageLoopbackNoToken.body).not.toContain('No such object.');
    expect(probedObjectFile).toBe(false);

    const storageEmptyDownloadToken = await rawHttpRequest({
      port: byteServer.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media&token=',
      headers: { host: `127.0.0.1:${byteServer.port}` },
    });
    expect(storageEmptyDownloadToken.status).toBe(403);
    expect(storageEmptyDownloadToken.body).not.toContain('No such object.');
    expect(probedObjectFile).toBe(false);

    const storageSdkAuthed = await rawHttpRequest({
      port: byteServer.port,
      path: '/__pyric/storage/v0/b/bucket-a/o/items%2Fitem-1?alt=media',
      headers: {
        host: `127.0.0.1:${byteServer.port}`,
        'x-pyric-session-token': 'byte-route-secret',
      },
    });
    expect(storageSdkAuthed.status).toBe(404);

    const remoteSsr = await rawHttpRequest({
      port,
      path: '/ssr-page',
      headers: {
        host: 'tunnel.example',
        origin: 'https://other.example',
        'sec-fetch-site': 'cross-site',
        'x-pyric-remote-peer': '1',
      },
    });
    expect(remoteSsr.status).toBe(200);
    expect(remoteSsr.body).not.toContain('"sessionToken"');
    expect(remoteSsr.body).not.toContain('data-project-key=');

    const localSsr = await rawHttpRequest({
      port,
      path: '/ssr-page',
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(localSsr.status).toBe(200);
    expect(localSsr.body).toContain('"sessionToken"');

    const middlewareVite = await createViteServer({
      configFile: false,
      root: cwd,
      logLevel: 'silent',
      appType: 'custom',
      server: {
        middlewareMode: true,
        allowedHosts: ['tunnel.example'],
      },
      plugins: [pyric({ sessionToken: true, ui: false })],
    });
    viteServers.push(middlewareVite);
    const middlewareRendered = await middlewareVite.transformIndexHtml('/', rawHtml);
    expect(middlewareRendered).not.toContain('"sessionToken"');
  }, 30_000);

  it('scopes resolveSessionTokenForTarget to matching loopback ports and project boundaries, and replaces symlinks atomically in writeMode600FileSync', () => {
    const {
      resolveSessionTokenForTarget,
      writeMode600FileSync,
    } = require('../../src/serve/local-session-token.js') as typeof import('../../src/serve/local-session-token.js');

    const root = mkdtempSync(join(tmpdir(), 'pyric-token-scope-'));
    dirs.push(root);
    const siblingWebPyric = join(root, 'web', '.pyric');
    const otherProject = join(root, 'other-project');
    mkdirSync(siblingWebPyric, { recursive: true });
    mkdirSync(otherProject, { recursive: true });
    writeFileSync(join(otherProject, 'package.json'), '{"name":"other-project"}\n');
    writeFileSync(
      join(siblingWebPyric, 'serve.json'),
      JSON.stringify({
        url: 'http://127.0.0.1:3473',
        port: 3473,
        pid: process.pid,
        instanceId: 'inst-a',
        token: 'tok-project-a',
      }),
    );

    expect(
      resolveSessionTokenForTarget({
        cwd: otherProject,
        url: 'http://127.0.0.2:4999',
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveSessionTokenForTarget({
        cwd: join(root, 'web'),
        url: 'http://remote.example:3473',
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveSessionTokenForTarget({
        cwd: join(root, 'web'),
        url: 'http://127.0.0.2:3473',
        env: {},
      }),
    ).toBe('tok-project-a');

    const externalTarget = join(root, 'external-note.txt');
    writeFileSync(externalTarget, 'UNCHANGED');
    const pointerDir = join(otherProject, '.pyric');
    mkdirSync(pointerDir, { recursive: true });
    const symlinkPointer = join(pointerDir, 'serve.json');
    const { lstatSync, symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(externalTarget, symlinkPointer);

    writeMode600FileSync(symlinkPointer, '{"token":"fresh-secret"}\n');
    expect(readFileSync(externalTarget, 'utf8')).toBe('UNCHANGED');
    expect(lstatSync(symlinkPointer).isSymbolicLink()).toBe(false);
    expect(readFileSync(symlinkPointer, 'utf8')).toContain('fresh-secret');
  });

  it('rejects wildcard 0.0.0.0 Host, scheme-mismatched Origin, forged Origin + cross-site Sec-Fetch-Site, foreign OPTIONS preflights, and sibling ports on extra allowedHosts', async () => {
    const cwd = createProject();
    const runtime = await startServe({
      cwd,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      cacheRoot: join(cwd, '.cache'),
      bridge: true,
      persist: true,
      sessionToken: true,
      ui: true,
      disableAuditLog: true,
      logger: silentServeLogger(),
    });
    runtimes.push(runtime);
    const port = runtime.handle.port;
    const token = runtime.sessionToken;

    // 1. Wildcard Host 0.0.0.0:<port> is never accepted as loopback.
    for (const path of ['/', '/__pyric/init.json', '/__pyric/ui/studio', '/__pyric/mcp']) {
      const res = await rawHttpRequest({
        port,
        path,
        method: path === '/__pyric/mcp' ? 'POST' : 'GET',
        headers: {
          host: `0.0.0.0:${port}`,
          'x-pyric-session-token': token,
        },
        body: path === '/__pyric/mcp' ? '{}' : undefined,
      });
      expect(res.status, `0.0.0.0 Host on ${path}`).toBe(403);
    }

    // 2. Scheme-mismatched Origin (https://localhost:<port> against http server) is rejected with 403.
    const schemeMismatch = await rawHttpRequest({
      port,
      path: '/__pyric/diagnostics',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `https://127.0.0.1:${port}`,
        'x-pyric-session-token': token,
      },
    });
    expect(schemeMismatch.status).toBe(403);

    // 3. Same-origin Origin paired with Sec-Fetch-Site: cross-site or same-site is rejected with 403.
    for (const site of ['cross-site', 'same-site'] as const) {
      const forged = await rawHttpRequest({
        port,
        path: '/__pyric/diagnostics',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'sec-fetch-site': site,
          'x-pyric-session-token': token,
        },
      });
      expect(forged.status, `Origin + Sec-Fetch-Site:${site}`).toBe(403);
    }

    // 4. Foreign OPTIONS preflights are rejected with 403 across local surfaces.
    for (const path of ['/__pyric/init.json', '/__pyric/flow/manifest.json', '/__pyric/mcp', '/__pyric/ui/studio']) {
      const preflight = await rawHttpRequest({
        port,
        path,
        method: 'OPTIONS',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: 'https://attacker.example',
          'sec-fetch-site': 'cross-site',
          'x-pyric-session-token': token,
        },
      });
      expect(preflight.status, `OPTIONS ${path}`).toBe(403);
    }

    // 5. Extra allowedHosts entry does not admit sibling ports on Origin.
    const siblingPortTunnel = await rawHttpRequest({
      port,
      path: '/__pyric/init.json',
      headers: {
        host: `tunnel.example:${port}`,
        origin: `http://tunnel.example:${port + 1}`,
        'sec-fetch-site': 'same-site',
        'x-pyric-session-token': token,
      },
    });
    expect(siblingPortTunnel.status).toBe(403);
  }, 30_000);
});
