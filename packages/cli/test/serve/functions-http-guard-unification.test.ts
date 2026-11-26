/**
 * Adversarial remote-access negative & loopback/CORS positive security tests
 * for unified `evaluateGuard` enforcement on Functions HTTP and Callable routes
 * across `startStaticServer` (`server.ts`), `createFunctionsHttpGateway`
 * (`gateway.ts`), `private-origin.ts`, and `attachViteGenerationFunctions`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { HttpFunctionInfo } from '../../src/functions/http/discovery.js';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import {
  createFunctionsGuardPolicy,
  evaluateFunctionsRequestGuard,
} from '../../src/functions/http/request-guard.js';
import { hostingRewrites } from '../../src/functions/http/rewrites.js';
import type { BridgeMount } from '../../src/serve/bridge-mount.js';
import {
  getHeader,
  isAllowedOriginOnPorts,
  isForeignFetchSite,
  requestSocketScheme,
  silentServeLogger,
  startStaticServer,
  type ServeHandle,
} from '../../src/serve/server.js';
import type { ViteFunctionsDevelopmentOptions } from '../../src/serve/vite-functions-development.js';
import { attachViteGenerationFunctions } from '../../src/serve/vite-generation-functions.js';

const handles: ServeHandle[] = [];
const plainServers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.stop();
  }
  while (plainServers.length > 0) {
    const srv = plainServers.pop();
    if (srv !== undefined) {
      srv.closeAllConnections();
      await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function listenLoopback(server: Server): Promise<number> {
  plainServers.push(server);
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server.address() as AddressInfo).port);
    });
  });
}

function rawHttp(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolveCall, rejectCall) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method ?? 'POST', headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolveCall({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', rejectCall);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const PUBLIC_FN: HttpFunctionInfo = {
  exportName: 'publicApi', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null,
};
const PRIVATE_FN: HttpFunctionInfo = {
  exportName: 'privateApi', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: true, timeoutSeconds: null,
};
const CALLABLE_FN: HttpFunctionInfo = {
  exportName: 'callGreeting', regions: ['us-central1'], platform: 'gcfv2', kind: 'callable', privateInvoker: false, timeoutSeconds: null,
};

async function createFakeChild(): Promise<{ port: number; hits: () => number }> {
  let count = 0;
  const port = await listenLoopback(
    createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        count += 1;
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': String(req.headers.origin ?? '*'),
            'access-control-allow-methods': 'POST, OPTIONS',
          });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, target: req.headers['x-pyric-function-target'] ?? 'unknown' }));
      });
    }),
  );
  return { port, hits: () => count };
}

function makeReadyGateway(childPort: number) {
  const gateway = createFunctionsHttpGateway({
    projectId: 'demo-app',
    initial: { kind: 'starting' },
    rewrites: hostingRewrites({ hosting: { rewrites: [{ source: '/api/**', function: 'publicApi' }] } }),
    plane: 'pyric-sandbox',
  });
  gateway.update({
    kind: 'ready',
    http: { port: childPort, token: 'child-secret', functions: [PUBLIC_FN, PRIVATE_FN, CALLABLE_FN] },
  });
  return gateway;
}

function originCheckFor(extraHosts: readonly string[]) {
  return (incoming: IncomingMessage): boolean => {
    let ports: number[] = [];
    if (incoming.socket.localPort !== undefined) {
      ports = [incoming.socket.localPort];
    }
    const scheme = requestSocketScheme(incoming);
    return (
      isAllowedOriginOnPorts(getHeader(incoming, 'origin'), '127.0.0.1', extraHosts, ports, scheme) &&
      !isForeignFetchSite(incoming, '127.0.0.1', ports, scheme, extraHosts)
    );
  };
}

describe('Functions HTTP / Callable unified evaluateGuard enforcement', () => {
  it('1. enforces allowPeers, remoteAccess, sessionToken, stale cookie unlock, and static HTML fallthrough on startStaticServer', async () => {
    const child = await createFakeChild();
    const gateway = makeReadyGateway(child.port);
    const publicDir = makeTempDir('pyric-fn-guard-1-');
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><h1>unlock-ready</h1>');
    const token = 'fn-guard-secret-token-1';

    const server = await startStaticServer({
      publicDir,
      port: 0,
      host: '127.0.0.1',
      spaRewrite: true,
      sessionToken: token,
      remoteAccess: { allowedHosts: ['devbox.example.com'], allowPeers: 'loopback', trustProxy: 'loopback' },
      logger: silentServeLogger(),
      functionsHandler: (req, res) => gateway.handle(req, res, originCheckFor(['devbox.example.com'])),
    });
    handles.push(server);

    // Unauthenticated remote Host on emulator path (public & callable) and SPA-matching rewrite GET -> 401 unlock_required.
    for (const path of ['/demo-app/us-central1/publicApi', '/demo-app/us-central1/callGreeting', '/api/secret']) {
      let method = 'POST';
      if (path === '/api/secret') method = 'GET';
      const unauthed = await rawHttp({ port: server.port, path, method, headers: { Host: 'devbox.example.com' } });
      expect(unauthed.status).toBe(401);
      expect(JSON.parse(unauthed.body)).toMatchObject({
        error: 'unlock_required',
        reason: 'missing-session-token',
        unlockPath: '/__pyric/unlock',
      });
    }

    // Stale cookie on remote Host -> 401 invalid-session-token with unlock_required.
    const staleCookie = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: 'devbox.example.com', Cookie: `__pyric_session_${server.port}=old-boot-token` },
    });
    expect(staleCookie.status).toBe(401);
    expect(JSON.parse(staleCookie.body)).toMatchObject({
      error: 'unlock_required',
      reason: 'invalid-session-token',
      unlockPath: '/__pyric/unlock',
    });

    // Invalid header token -> 401 invalid-session-token (without unlock_required).
    const badHeader = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: 'devbox.example.com', 'x-pyric-session-token': 'wrong-token' },
    });
    expect(badHeader.status).toBe(401);
    expect(JSON.parse(badHeader.body)).toMatchObject({ reason: 'invalid-session-token' });

    // Marked remote peer when allowPeers is 'loopback' -> 403 remote-peer even with valid token.
    const markedRemote = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: `127.0.0.1:${server.port}`, 'x-pyric-remote-peer': '1', 'x-pyric-session-token': token },
    });
    expect(markedRemote.status).toBe(403);
    expect(JSON.parse(markedRemote.body)).toMatchObject({ reason: 'remote-peer' });

    // Remote cross-origin CSRF attempt even with valid cookie -> 403 origin-mismatch.
    const remoteCsrf = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/publicApi',
      headers: {
        Host: 'devbox.example.com',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
        'X-Forwarded-Proto': 'https',
        Cookie: `__pyric_session_${server.port}=${token}`,
      },
    });
    expect(remoteCsrf.status).toBe(403);
    expect(JSON.parse(remoteCsrf.body)).toMatchObject({ reason: 'origin-mismatch' });
    expect(child.hits()).toBe(0);

    // Unauthenticated static HTML / SPA page still serves 200 so browser can load /__pyric/unlock.
    const staticHtml = await rawHttp({ port: server.port, path: '/', method: 'GET', headers: { Host: 'devbox.example.com' } });
    expect(staticHtml.status).toBe(200);
    expect(staticHtml.body).toContain('unlock-ready');

    // Authenticated remote caller succeeds on emulator path, callable, and rewrite.
    const authedHeader = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/callGreeting',
      headers: { Host: 'devbox.example.com', 'x-pyric-session-token': token },
      body: '{"data":{}}',
    });
    expect(authedHeader.status).toBe(200);

    const authedCookie = await rawHttp({
      port: server.port,
      path: '/api/hello',
      method: 'GET',
      headers: {
        Host: 'devbox.example.com',
        Origin: 'https://devbox.example.com',
        'Sec-Fetch-Site': 'same-origin',
        'X-Forwarded-Proto': 'https',
        Cookie: `__pyric_session_${server.port}=${token}`,
      },
    });
    expect(authedCookie.status).toBe(200);
    expect(child.hits()).toBe(2);
  });

  it('2. refuses legacy allowedHosts without remoteAccess and enforces guard on custom functionsHandler stubs', async () => {
    const child = await createFakeChild();
    const gateway = makeReadyGateway(child.port);
    const dir = makeTempDir('pyric-fn-guard-2-');
    const legacyServer = await startStaticServer({
      publicDir: dir,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      sessionToken: 'legacy-tok',
      logger: silentServeLogger(),
      functionsHandler: (req, res) => gateway.handle(req, res, () => true),
    });
    handles.push(legacyServer);

    const legacyRes = await rawHttp({
      port: legacyServer.port,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: 'tunnel.example' },
    });
    expect(legacyRes.status).toBe(403);
    expect(JSON.parse(legacyRes.body)).toMatchObject({ reason: 'disallowed-host' });
    expect(child.hits()).toBe(0);

    let customHits = 0;
    const customServer = await startStaticServer({
      publicDir: null,
      port: 0,
      host: '127.0.0.1',
      sessionToken: 'custom-tok',
      remoteAccess: { allowedHosts: ['devbox.example.com'], allowPeers: 'loopback' },
      logger: silentServeLogger(),
      functionsHandler: (_req, res) => {
        customHits += 1;
        res.writeHead(200).end('custom-ok');
        return true;
      },
    });
    handles.push(customServer);

    const blockedCustom = await rawHttp({
      port: customServer.port,
      path: '/demo-app/us-central1/custom',
      headers: { Host: 'devbox.example.com' },
    });
    expect(blockedCustom.status).toBe(401);
    expect(customHits).toBe(0);

    const allowedCustom = await rawHttp({
      port: customServer.port,
      path: '/demo-app/us-central1/custom',
      headers: { Host: 'devbox.example.com', 'x-pyric-session-token': 'custom-tok' },
    });
    expect(allowedCustom.status).toBe(200);
    expect(customHits).toBe(1);
  });

  it('3. preserves loopback zero-config invocation, public CORS/OPTIONS preflight, and private-function origin refusal', async () => {
    const child = await createFakeChild();
    const gateway = makeReadyGateway(child.port);
    const dir = makeTempDir('pyric-fn-guard-3-');
    const server = await startStaticServer({
      publicDir: dir,
      port: 0,
      host: '127.0.0.1',
      sessionToken: 'loopback-secret',
      logger: silentServeLogger(),
      functionsHandler: (req, res) => gateway.handle(req, res, originCheckFor([])),
    });
    handles.push(server);

    const host = `127.0.0.1:${server.port}`;
    const corsPost = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: host, Origin: 'https://thirdparty.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(corsPost.status).toBe(200);

    const preflight = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/callGreeting',
      method: 'OPTIONS',
      headers: { Host: host, Origin: 'https://thirdparty.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://thirdparty.example');

    const foreignPrivate = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/privateApi',
      headers: { Host: host, Origin: 'https://attacker.example' },
    });
    expect(foreignPrivate.status).toBe(403);
    expect(foreignPrivate.body).toContain("invoker: 'private'");

    const sameOriginPrivate = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/privateApi',
      headers: { Host: host, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(sameOriginPrivate.status).toBe(200);

    const curlPrivate = await rawHttp({ port: server.port, path: '/demo-app/us-central1/privateApi', headers: { Host: host } });
    expect(curlPrivate.status).toBe(200);
    expect(child.hits()).toBe(4);
  });

  it('4. enforces two-hop reverse proxy remote access across public and private functions', async () => {
    const child = await createFakeChild();
    const gateway = makeReadyGateway(child.port);
    const dir = makeTempDir('pyric-fn-guard-4-');
    const token = 'two-hop-fn-token';
    const proxyHost = 'abc123.proxy.example.com';

    const server = await startStaticServer({
      publicDir: dir,
      port: 0,
      host: '127.0.0.1',
      sessionToken: token,
      remoteAccess: { allowedHosts: ['.proxy.example.com'], allowPeers: 'any', trustProxy: 'loopback' },
      logger: silentServeLogger(),
      functionsHandler: (req, res) => gateway.handle(req, res, () => false),
    });
    handles.push(server);

    const baseHeaders = {
      Host: `localhost:${server.port}`,
      'X-Forwarded-Host': proxyHost,
      'X-Forwarded-Proto': 'https',
      Origin: `https://${proxyHost}`,
      'Sec-Fetch-Site': 'same-origin',
      'x-pyric-remote-peer': '1',
    };

    const unauthed = await rawHttp({ port: server.port, path: '/demo-app/us-central1/publicApi', headers: baseHeaders });
    expect(unauthed.status).toBe(401);
    expect(JSON.parse(unauthed.body)).toMatchObject({ error: 'unlock_required', reason: 'missing-session-token' });

    const badForwarded = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/publicApi',
      headers: {
        ...baseHeaders,
        'X-Forwarded-Host': 'evil.example.net',
        Origin: 'https://evil.example.net',
        Cookie: `__pyric_session_${server.port}=${token}`,
      },
    });
    expect(badForwarded.status).toBe(403);
    expect(JSON.parse(badForwarded.body)).toMatchObject({ reason: 'disallowed-host' });

    const downgraded = await rawHttp({
      port: server.port,
      path: '/demo-app/us-central1/publicApi',
      headers: { ...baseHeaders, Origin: `http://${proxyHost}`, Cookie: `__pyric_session_${server.port}=${token}` },
    });
    expect(downgraded.status).toBe(403);
    expect(JSON.parse(downgraded.body)).toMatchObject({ reason: 'scheme-mismatch' });
    expect(child.hits()).toBe(0);

    for (const path of ['/demo-app/us-central1/publicApi', '/demo-app/us-central1/privateApi']) {
      const okRes = await rawHttp({
        port: server.port,
        path,
        headers: { ...baseHeaders, Cookie: `__pyric_session_${server.port}=${token}` },
      });
      expect(okRes.status).toBe(200);
    }
    expect(child.hits()).toBe(2);
  });

  it('5. Vite plane ignores server.allowedHosts: true and enforces evaluateGuard via attachViteGenerationFunctions', async () => {
    const child = await createFakeChild();
    const gateway = makeReadyGateway(child.port);
    const token = 'vite-fn-secret-token';
    let captured: ViteFunctionsDevelopmentOptions | undefined;

    attachViteGenerationFunctions({
      server: {
        config: { server: { host: '127.0.0.1', allowedHosts: true }, logger: { warn: () => undefined } },
        httpServer: {},
        middlewares: { use: () => undefined },
        watcher: {},
      } as unknown as ViteDevServer,
      projectDir: '/project',
      cliRoot: '/cli',
      bridge: { sessionToken: token } as unknown as BridgeMount,
      remoteAccess: { allowedHosts: ['devbox.example.com'], allowPeers: 'loopback', trustProxy: 'loopback' },
      resolved: { options: {}, project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' }, projectId: 'demo-app' },
      registerModuleUrl: () => 'file:///register.js',
      fileExists: () => false,
      attach: (opts) => {
        captured = opts;
        return { close: async () => undefined };
      },
    });
    if (captured === undefined) throw new Error('attach was not called');
    const viteOpts = captured;

    const vitePort = await listenLoopback(
      createServer((req, res) => {
        if (!viteOpts.isAllowedRequest(req)) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('disallowed-host');
          return;
        }
        void gateway.handle(req, res, viteOpts.allowsAppOrigin).then((handled) => {
          if (!handled) res.writeHead(200, { 'content-type': 'text/html' }).end('vite-page');
        });
      }),
    );

    const rebound = await rawHttp({ port: vitePort, path: '/demo-app/us-central1/publicApi', headers: { Host: 'attacker.example' } });
    expect(rebound.status).toBe(403);

    const page = await rawHttp({ port: vitePort, path: '/index.html', method: 'GET', headers: { Host: 'devbox.example.com' } });
    expect(page.status).toBe(200);
    expect(page.body).toBe('vite-page');

    const unauthed = await rawHttp({ port: vitePort, path: '/demo-app/us-central1/publicApi', headers: { Host: 'devbox.example.com' } });
    expect(unauthed.status).toBe(401);
    expect(JSON.parse(unauthed.body)).toMatchObject({ error: 'unlock_required', reason: 'missing-session-token' });

    const remotePeer = await rawHttp({
      port: vitePort,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: `127.0.0.1:${vitePort}`, 'x-pyric-remote-peer': '1', 'x-pyric-session-token': token },
    });
    expect(remotePeer.status).toBe(403);
    expect(JSON.parse(remotePeer.body)).toMatchObject({ reason: 'remote-peer' });
    expect(child.hits()).toBe(0);

    const authed = await rawHttp({
      port: vitePort,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: 'devbox.example.com', 'x-pyric-session-token': token },
    });
    expect(authed.status).toBe(200);

    const loopback = await rawHttp({
      port: vitePort,
      path: '/demo-app/us-central1/publicApi',
      headers: { Host: `127.0.0.1:${vitePort}`, Origin: 'https://cors.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(loopback.status).toBe(200);
    expect(child.hits()).toBe(2);
  });

  it('6. refuses non-loopback direct peer sockets when allowPeers is loopback or CIDR-restricted', () => {
    const loopbackOnlyPolicy = createFunctionsGuardPolicy({
      boundHost: '127.0.0.1',
      sessionToken: 'tok-cidr',
      remoteAccess: { allowedHosts: ['devbox.example.com'], allowPeers: 'loopback' },
    });
    const blockedDirect = evaluateFunctionsRequestGuard(
      {
        method: 'POST',
        headers: { host: 'devbox.example.com', 'x-pyric-session-token': 'tok-cidr' },
        socket: { remoteAddress: '203.0.113.10', localPort: 3473, encrypted: false },
      },
      loopbackOnlyPolicy,
    );
    expect(blockedDirect.ok).toBe(false);
    if (!blockedDirect.ok) {
      expect(blockedDirect.status).toBe(403);
      expect(blockedDirect.reason).toBe('remote-peer');
    }

    const cidrPolicy = createFunctionsGuardPolicy({
      boundHost: '0.0.0.0',
      sessionToken: 'tok-cidr',
      remoteAccess: { allowedHosts: ['devbox.example.com'], allowPeers: ['100.64.0.0/10'] },
    });
    const allowedCidr = evaluateFunctionsRequestGuard(
      {
        method: 'POST',
        headers: { host: 'devbox.example.com', 'x-pyric-session-token': 'tok-cidr' },
        socket: { remoteAddress: '100.64.12.34', localPort: 3473, encrypted: false },
      },
      cidrPolicy,
    );
    expect(allowedCidr.ok).toBe(true);

    const outsideCidr = evaluateFunctionsRequestGuard(
      {
        method: 'POST',
        headers: { host: 'devbox.example.com', 'x-pyric-session-token': 'tok-cidr' },
        socket: { remoteAddress: '198.51.100.7', localPort: 3473, encrypted: false },
      },
      cidrPolicy,
    );
    expect(outsideCidr.ok).toBe(false);
    if (!outsideCidr.ok) {
      expect(outsideCidr.status).toBe(403);
      expect(outsideCidr.reason).toBe('remote-peer');
    }
  });
});
