import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import {
  formatRemoteAccessStartupLines,
  isAuthenticatedRemoteHtmlRequest,
  resolveRemoteAccessConfig,
} from '../../src/serve/remote-access-config.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { createUnlockHandler, LOGOUT_PATH, UNLOCK_PATH, validateUnlockNextPath } from '../../src/serve/unlock-route.js';
import {
  attachViteGenerationMiddleware,
  attachViteHtmlSessionBootstrap,
  currentViteHtmlPeerContext,
} from '../../src/serve/vite-generation-middleware.js';

const handles: ServeHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.stop();
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

function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function sampleInitPayload(): InitPayload {
  return {
    rules: 'rules_version = "2";',
    rulesHash: 'unlock-test-hash',
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: 'ws://localhost:5173/__pyric/sandbox',
    seed: null,
  };
}

describe('validateUnlockNextPath', () => {
  it('accepts safe single-leading-slash relative paths and rejects open redirects', () => {
    expect(validateUnlockNextPath('')).toBe('/');
    expect(validateUnlockNextPath('/')).toBe('/');
    expect(validateUnlockNextPath('/app/chat?tab=2#bottom')).toBe('/app/chat?tab=2#bottom');
    expect(validateUnlockNextPath('/__pyric/ui/studio/')).toBe('/__pyric/ui/studio/');

    expect(validateUnlockNextPath('//evil.example/path')).toBeNull();
    expect(validateUnlockNextPath('///evil.example')).toBeNull();
    expect(validateUnlockNextPath('https://evil.example/')).toBeNull();
    expect(validateUnlockNextPath('http://evil.example/')).toBeNull();
    expect(validateUnlockNextPath('javascript:alert(1)')).toBeNull();
    expect(validateUnlockNextPath('/\\evil.example')).toBeNull();
    expect(validateUnlockNextPath('/foo/../bar')).toBeNull();
    expect(validateUnlockNextPath('/foo\r\nLocation: evil')).toBeNull();
    expect(validateUnlockNextPath(' /app')).toBeNull();
    expect(validateUnlockNextPath('/__pyric/unlock')).toBeNull();
    expect(validateUnlockNextPath('/__pyric/logout')).toBeNull();
    expect(validateUnlockNextPath('relative/path')).toBeNull();
  });
});

describe('resolveRemoteAccessConfig and startup warnings', () => {
  it('ignores Vite server.allowedHosts: true and validates strict options and env vars', () => {
    const disabled = resolveRemoteAccessConfig({
      viteAllowedHosts: true,
      env: {},
    });
    expect(disabled.remoteAccess).toBeUndefined();
    expect(disabled.allowedHosts).toEqual([]);

    const fromViteTrue = resolveRemoteAccessConfig({
      option: true,
      viteAllowedHosts: true,
      env: {},
    });
    expect(fromViteTrue.allowedHosts).toEqual([]);
    expect(fromViteTrue.remoteAccess).toEqual({
      allowedHosts: [],
      allowPeers: 'loopback',
      trustProxy: 'loopback',
      browserUnlock: true,
      allowLiveRemotePeers: false,
    });

    const fromViteArray = resolveRemoteAccessConfig({
      option: true,
      viteAllowedHosts: ['.tailnet.ts.net', 'devbox.example.com'],
      env: {
        PYRIC_ALLOWED_HOSTS: 'extra.example.com',
        PYRIC_ALLOW_REMOTE_PEERS: '100.64.0.0/10',
        PYRIC_TRUST_PROXY: '10.0.0.0/24',
      },
    });
    expect(fromViteArray.allowedHosts).toEqual([
      '.tailnet.ts.net',
      'devbox.example.com',
      'extra.example.com',
    ]);
    expect(fromViteArray.remoteAccess?.allowPeers).toEqual(['100.64.0.0/10']);
    expect(fromViteArray.remoteAccess?.trustProxy).toEqual(['10.0.0.0/24']);

    expect(() =>
      resolveRemoteAccessConfig({
        option: { allowedHosts: ['.com'] },
      }),
    ).toThrow();
    expect(() =>
      resolveRemoteAccessConfig({
        env: { PYRIC_ALLOWED_HOSTS: '*' },
      }),
    ).toThrow();

    const plainLines = formatRemoteAccessStartupLines({
      remoteAccess: { allowedHosts: ['devbox.example.com'], trustProxy: false },
      sessionToken: 'secret-token-123',
      https: false,
    });
    expect(plainLines.some((line) => line.includes('/__pyric/unlock#code=secret-token-123'))).toBe(true);
    expect(plainLines.some((line) => line.includes('?code=') || line.includes('?token='))).toBe(false);
    expect(plainLines.some((line) => line.includes('ServiceWorker'))).toBe(true);

    const proxiedLines = formatRemoteAccessStartupLines({
      remoteAccess: { allowedHosts: ['devbox.example.com'], trustProxy: 'loopback' },
      sessionToken: 'secret-token-123',
      https: false,
    });
    expect(proxiedLines).toHaveLength(1);
  });
});

describe('/__pyric/unlock and /__pyric/logout routes', () => {
  it('mounts only when remoteAccess is enabled and pairs via cookie without query token leakage', async () => {
    const root = makeTempDir('pyric-unlock-e2e-');
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
    const token = 'unlock-session-secret-0123456789';

    // Default server (remoteAccess omitted) does NOT expose /__pyric/unlock.
    const defaultNs = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      initPayload: sampleInitPayload,
      sessionToken: token,
    });
    const defaultServer = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: defaultNs,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(defaultServer);
    const missingUnlock = await rawRequest({
      port: defaultServer.port,
      path: UNLOCK_PATH,
      headers: { Host: `127.0.0.1:${defaultServer.port}` },
    });
    expect(missingUnlock.status).toBe(404);

    // Remote-enabled server behind TLS-terminating loopback proxy.
    const remoteAccess = {
      allowedHosts: ['.tailnet.ts.net'],
      trustProxy: 'loopback' as const,
      browserUnlock: true,
    };
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      initPayload: sampleInitPayload,
      sessionToken: token,
      remoteAccess,
    });
    const server = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      namespaceHandler: ns,
      sessionToken: token,
      remoteAccess,
      transformHtml: (html, ctx) =>
        ctx.localPeer ? html.replace('</head>', '<meta name="pyric-stamped" content="yes"></head>') : html,
      logger: silentServeLogger(),
    });
    handles.push(server);

    // Disallowed Host on /__pyric/unlock returns 403.
    const badHost = await rawRequest({
      port: server.port,
      path: UNLOCK_PATH,
      headers: { Host: 'evil.example' },
    });
    expect(badHost.status).toBe(403);

    // Query-string secret ?token= or ?code= is strictly refused with 400.
    const queryToken = await rawRequest({
      port: server.port,
      path: `${UNLOCK_PATH}?token=${token}`,
      headers: { Host: 'box.tailnet.ts.net:8443' },
    });
    expect(queryToken.status).toBe(400);
    expect(queryToken.headers['cache-control']).toBe('no-store');

    // Open redirect probes on GET ?next= are rejected with 400.
    for (const evilNext of ['//evil.example', 'https://evil.example', '/\\evil', '/a/../b']) {
      const openRedirect = await rawRequest({
        port: server.port,
        path: `${UNLOCK_PATH}?next=${encodeURIComponent(evilNext)}`,
        headers: { Host: 'box.tailnet.ts.net:8443' },
      });
      expect(openRedirect.status).toBe(400);
    }

    // Valid GET /__pyric/unlock serves zero-data HTML with fragment scrubbing and strict headers.
    const page = await rawRequest({
      port: server.port,
      path: `${UNLOCK_PATH}?next=${encodeURIComponent('/app/room?id=42')}`,
      headers: { Host: 'box.tailnet.ts.net:8443' },
    });
    expect(page.status).toBe(200);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.body).toContain('history.replaceState');
    expect(page.body).not.toContain(token);
    expect(page.body).not.toContain('rules_version');

    // Cross-site POST /__pyric/unlock rejected (403).
    const csrfPost = await rawRequest({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://evil.example',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    expect(csrfPost.status).toBe(403);

    // Oversized POST body (> 1 KiB) rejected (413).
    const bigBody = JSON.stringify({ token: 'x'.repeat(1200) });
    const tooLarge = await rawRequest({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      body: bigBody,
    });
    expect(tooLarge.status).toBe(413);

    // Open redirect target inside POST JSON body rejected (400).
    const badNextPost = await rawRequest({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token, next: '//evil.example' }),
    });
    expect(badNextPost.status).toBe(400);

    // Valid POST /__pyric/unlock behind TLS proxy emits HttpOnly; SameSite=Strict; Secure cookie.
    const unlocked = await rawRequest({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token, next: '/app/room?id=42' }),
    });
    expect(unlocked.status).toBe(200);
    expect(JSON.parse(unlocked.body)).toEqual({ ok: true, next: '/app/room?id=42' });
    const setCookieHeader = Array.isArray(unlocked.headers['set-cookie'])
      ? unlocked.headers['set-cookie'][0] ?? ''
      : unlocked.headers['set-cookie'] ?? '';
    expect(setCookieHeader).toContain(`__pyric_session_${server.port}=`);
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Strict');
    expect(setCookieHeader).toContain('Path=/__pyric');
    expect(setCookieHeader).toContain('; Secure');

    // Cookie unlocks /__pyric/init.json over the same proxied HTTPS origin.
    const cookiePair = setCookieHeader.split(';', 1)[0] ?? '';
    const authedInit = await rawRequest({
      port: server.port,
      path: '/__pyric/init.json',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        Cookie: cookiePair,
      },
    });
    expect(authedInit.status).toBe(200);
    expect(JSON.parse(authedInit.body).sessionToken).toBe(token);

    // Unauthenticated HTML on remote Host stays unstamped; authenticated stamps localPeer=true.
    const unauthHtml = await rawRequest({
      port: server.port,
      path: '/',
      headers: { Host: 'box.tailnet.ts.net:8443', 'x-forwarded-proto': 'https' },
    });
    expect(unauthHtml.status).toBe(200);
    expect(unauthHtml.body).not.toContain('pyric-stamped');

    const authedHtml = await rawRequest({
      port: server.port,
      path: '/',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-session-token': token,
      },
    });
    expect(authedHtml.status).toBe(200);
    expect(authedHtml.body).toContain('pyric-stamped');

    // POST /__pyric/logout clears the port-scoped cookie with Max-Age=0.
    const loggedOut = await rawRequest({
      port: server.port,
      path: LOGOUT_PATH,
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
      },
    });
    expect(loggedOut.status).toBe(200);
    const logoutCookies = Array.isArray(loggedOut.headers['set-cookie'])
      ? loggedOut.headers['set-cookie'].join('\n')
      : loggedOut.headers['set-cookie'] ?? '';
    expect(logoutCookies).toContain(`__pyric_session_${server.port}=;`);
    expect(logoutCookies).toContain('Max-Age=0');
  });

  it('rate limits brute-force failed unlock attempts with 429 Retry-After', async () => {
    let clock = 10_000;
    const unlock = createUnlockHandler({
      boundHost: '127.0.0.1',
      allowedHosts: ['devbox.example.com'],
      remoteAccess: { allowedHosts: ['devbox.example.com'] },
      sessionToken: 'real-secret-token',
      rateLimit: { maxFailures: 3, windowMs: 60_000, now: () => clock },
    });
    const runPost = async (bodyToken: string): Promise<{ status: number; headers: Record<string, string> }> => {
      const headers: Record<string, string> = {};
      let status = 0;
      const bodyBuf = Buffer.from(JSON.stringify({ token: bodyToken }));
      const req = {
        method: 'POST',
        headers: {
          host: 'devbox.example.com:5173',
          origin: 'http://devbox.example.com:5173',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'content-length': String(bodyBuf.byteLength),
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
        async *[Symbol.asyncIterator]() {
          yield bodyBuf;
        },
        resume() {},
      };
      const res = {
        socket: { localPort: 5173, encrypted: false },
        getHeader(key: string) {
          return headers[key.toLowerCase()];
        },
        setHeader(key: string, val: string | string[]) {
          headers[key.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val);
        },
        writeHead(code: number, extra?: Record<string, string>) {
          status = code;
          if (extra) {
            for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = String(v);
          }
          return res;
        },
        end() {
          return res;
        },
      };
      await unlock(req as never, res as never, new URL('http://devbox.example.com:5173/__pyric/unlock'));
      return { status, headers };
    };

    expect((await runPost('wrong-1')).status).toBe(401);
    expect((await runPost('wrong-2')).status).toBe(401);
    const third = await runPost('wrong-3');
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);

    // Even the real token is blocked during the cooldown window.
    expect((await runPost('real-secret-token')).status).toBe(429);

    // After the window advances, the real token succeeds (and plain HTTP omits ; Secure).
    clock += 61_000;
    const ok = await runPost('real-secret-token');
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']).not.toContain('; Secure');
  });

  it('wires Vite HTML session bootstrap and middleware host checks for authenticated remote hosts', async () => {
    const stack: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const fakeServer = {
      config: { server: { host: '127.0.0.1', allowedHosts: true as const } },
      middlewares: {
        use(fn: (req: unknown, res: unknown, next: () => void) => void) {
          stack.push(fn);
        },
      },
    };
    const token = 'vite-remote-token-012345';
    attachViteHtmlSessionBootstrap(
      fakeServer as never,
      () => token,
      () => ({
        allowedHosts: ['.tailnet.ts.net'],
        remoteAccess: { allowedHosts: ['.tailnet.ts.net'], trustProxy: 'loopback' },
      }),
    );
    const mw = stack[0];
    expect(mw).toBeDefined();
    let seenPeer: boolean | undefined;
    const cookieHeaders: string[] = [];
    const makeRes = () => ({
      socket: { localPort: 5173, encrypted: false },
      getHeader: () => undefined,
      setHeader(name: string, val: string | string[]) {
        if (name.toLowerCase() === 'set-cookie') {
          cookieHeaders.push(Array.isArray(val) ? val.join(',') : val);
        }
      },
    });
    // Unauthenticated remote HTML stays localPeer=false and sets no cookie.
    mw?.(
      { method: 'GET', url: '/', headers: { host: 'box.tailnet.ts.net:8443', accept: 'text/html' }, socket: { remoteAddress: '127.0.0.1', localPort: 5173 } },
      makeRes(),
      () => { seenPeer = currentViteHtmlPeerContext()?.localPeer; },
    );
    expect(seenPeer).toBe(false);
    expect(cookieHeaders).toEqual([]);

    // Authenticated remote HTML sets localPeer=true and appends ; Secure behind HTTPS proxy.
    expect(
      isAuthenticatedRemoteHtmlRequest(
        {
          headers: { host: 'box.tailnet.ts.net:8443', 'x-pyric-session-token': token },
          socket: { remoteAddress: '127.0.0.1', localPort: 5173 },
        } as never,
        {
          boundHost: '127.0.0.1',
          allowedHosts: ['.tailnet.ts.net'],
          remoteAccess: { allowedHosts: ['.tailnet.ts.net'], trustProxy: 'loopback' },
          sessionToken: token,
        },
      ),
    ).toBe(true);
    mw?.(
      {
        method: 'GET',
        url: '/',
        headers: {
          host: 'box.tailnet.ts.net:8443',
          accept: 'text/html',
          'x-forwarded-proto': 'https',
          'x-pyric-session-token': token,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      makeRes(),
      () => { seenPeer = currentViteHtmlPeerContext()?.localPeer; },
    );
    expect(seenPeer).toBe(true);
    expect(cookieHeaders[0]).toContain('; Secure');

    // attachViteGenerationMiddleware keeps server.allowedHosts: true blocked for unknown hosts.
    let mountHandler: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    const dispose = attachViteGenerationMiddleware({
      server: {
        config: { server: { host: '127.0.0.1', allowedHosts: true } },
        middlewares: {
          use(_prefix: string, fn: (req: unknown, res: unknown, next: () => void) => void) {
            mountHandler = fn;
          },
        },
      } as never,
      bridge: null,
      session: { handle: () => true } as never,
      allowedHosts: ['.tailnet.ts.net'],
    });
    let blockedStatus = 0;
    mountHandler?.(
      { url: '/__pyric/init.json', headers: { host: 'evil.example' } },
      { set statusCode(code: number) { blockedStatus = code; }, end() {} },
      () => {},
    );
    expect(blockedStatus).toBe(403);
    dispose();
  });
});
