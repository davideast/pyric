import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import {
  parseAllowedHostsInput,
  parseAllowRemotePeersInput,
  parseTrustProxyInput,
} from '../../src/serve/remote-access-parse.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

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

function emptyInitPayload(): InitPayload {
  return {
    rules: 'rules_version = "2";',
    rulesHash: 'abc123',
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: 'ws://localhost:5173/__pyric/sandbox',
    seed: null,
  };
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('remote-access-parse flag parsers', () => {
  it('parses valid allowedHosts, allowPeers, and trustProxy inputs and rejects wildcards', () => {
    expect(parseAllowedHostsInput(['devbox.example.com, .tailnet.ts.net'])).toEqual([
      'devbox.example.com',
      '.tailnet.ts.net',
    ]);
    expect(() => parseAllowedHostsInput('*')).toThrow();
    expect(() => parseAllowedHostsInput('true')).toThrow();
    expect(() => parseAllowedHostsInput('.com')).toThrow();
    expect(() => parseAllowedHostsInput('0.0.0.0')).toThrow();
    expect(() => parseAllowedHostsInput('*.example.com')).toThrow();

    expect(parseAllowRemotePeersInput(false)).toBe('loopback');
    expect(parseAllowRemotePeersInput('loopback')).toBe('loopback');
    expect(parseAllowRemotePeersInput(true)).toBe('any');
    expect(parseAllowRemotePeersInput('any')).toBe('any');
    expect(parseAllowRemotePeersInput('100.64.0.0/10, fd7a::/16')).toEqual([
      '100.64.0.0/10',
      'fd7a::/16',
    ]);
    expect(() => parseAllowRemotePeersInput('0.0.0.0/0')).toThrow();

    expect(parseTrustProxyInput(false)).toBe(false);
    expect(parseTrustProxyInput('false')).toBe(false);
    expect(parseTrustProxyInput(true)).toBe('loopback');
    expect(parseTrustProxyInput('loopback')).toBe('loopback');
    expect(parseTrustProxyInput('10.0.0.0/24')).toEqual(['10.0.0.0/24']);
    expect(() => parseTrustProxyInput('::/0')).toThrow();
  });
});

describe('unified remote-access guards across server routes', () => {
  it('closes the rest-auth-rtdb --host 0.0.0.0 gap for remote peers and remote hosts', async () => {
    const publicDir = makeTempDir('pyric-rest-gap-');
    const restCalls: string[] = [];
    const token = 'rest-guard-secret-token-0123456789';

    // Without remoteAccess on wildcard 0.0.0.0, remote peers and unauthenticated tunnel Hosts are refused.
    const defaultServer = await startStaticServer({
      publicDir,
      host: '0.0.0.0',
      port: 0,
      allowedHosts: ['devbox.example.com'],
      sessionToken: token,
      restHandler: async (_req, res, url) => {
        restCalls.push(url.pathname);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
      logger: silentServeLogger(),
    });
    handles.push(defaultServer);

    const localRest = await rawRequest({
      port: defaultServer.port,
      path: '/items.json',
      headers: { Host: `127.0.0.1:${defaultServer.port}` },
    });
    expect(localRest.status).toBe(200);

    const remoteMarkedRest = await rawRequest({
      port: defaultServer.port,
      path: '/v1/accounts:signInWithCustomToken',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${defaultServer.port}`,
        'x-pyric-remote-peer': '1',
      },
      body: '{}',
    });
    expect(remoteMarkedRest.status).toBe(403);

    const unauthTunnelRest = await rawRequest({
      port: defaultServer.port,
      path: '/items.json',
      headers: { Host: 'devbox.example.com' },
    });
    expect(unauthTunnelRest.status).toBe(403);
    expect(restCalls).toEqual(['/items.json']);

    // With remoteAccess enabled, missing token gets 401 unlock_required; valid token passes.
    const remoteServer = await startStaticServer({
      publicDir,
      host: '0.0.0.0',
      port: 0,
      sessionToken: token,
      remoteAccess: {
        allowedHosts: ['.tailnet.ts.net'],
        allowPeers: 'any',
        trustProxy: 'loopback',
      },
      restHandler: async (_req, res, url) => {
        restCalls.push(`remote:${url.pathname}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
      logger: silentServeLogger(),
    });
    handles.push(remoteServer);

    const lockedRemote = await rawRequest({
      port: remoteServer.port,
      path: '/v1/accounts:signInWithCustomToken',
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
      },
      body: '{}',
    });
    expect(lockedRemote.status).toBe(401);
    expect(JSON.parse(lockedRemote.body)).toMatchObject({
      error: 'unlock_required',
      unlockPath: '/__pyric/unlock',
    });

    const authedRemote = await rawRequest({
      port: remoteServer.port,
      path: '/v1/accounts:signInWithCustomToken',
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-session-token': token,
      },
      body: '{}',
    });
    expect(authedRemote.status).toBe(200);
    expect(restCalls).toEqual(['/items.json', 'remote:/v1/accounts:signInWithCustomToken']);
  });

  it('serves authenticated remote avatars, Studio UI, init.json, and TLS proxy Secure cookies while denying unauthenticated remote requests', async () => {
    const root = makeTempDir('pyric-ns-remote-');
    const sdkDir = join(root, 'sdk');
    const siteUiDir = join(root, 'site');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(join(siteUiDir, 'studio'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>');
    writeFileSync(join(sdkDir, 'worker.js'), 'export const ok = true;');
    writeFileSync(join(siteUiDir, 'studio-routes.json'), JSON.stringify({ routes: ['studio'] }));
    writeFileSync(
      join(siteUiDir, 'studio', 'index.html'),
      '<!doctype html><html><head></head><body>studio-ok</body></html>',
    );

    const token = 'ns-remote-secret-0123456789abcdef';
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      siteUiDir,
      workerVersion: '0123456789abcdef',
      sessionToken: token,
      remoteAccess: {
        allowedHosts: ['.tailnet.ts.net'],
        trustProxy: 'loopback',
      },
      avatars: {
        async resolve() {
          return {
            data: new TextEncoder().encode('<svg/>'),
            contentType: 'image/svg+xml',
            origin: 'cache',
          };
        },
      },
      initPayload: emptyInitPayload,
    });
    const server = await startStaticServer({
      publicDir: root,
      host: '127.0.0.1',
      port: 0,
      remoteAccess: {
        allowedHosts: ['.tailnet.ts.net'],
        trustProxy: 'loopback',
      },
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    // Unauthenticated init.json returns 401 unlock_required JSON with unlockPath.
    const lockedInit = await rawRequest({
      port: server.port,
      path: '/__pyric/init.json',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
      },
    });
    expect(lockedInit.status).toBe(401);
    expect(JSON.parse(lockedInit.body)).toMatchObject({
      error: 'unlock_required',
      unlockPath: '/__pyric/unlock',
    });

    // A stale browser session cookie from an earlier boot also returns 401 unlock_required.
    const staleCookieInit = await rawRequest({
      port: server.port,
      path: '/__pyric/init.json',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        Cookie: `__pyric_session_${server.port}=stale-boot-token`,
      },
    });
    expect(staleCookieInit.status).toBe(401);
    expect(JSON.parse(staleCookieInit.body)).toMatchObject({
      error: 'unlock_required',
      reason: 'invalid-session-token',
      unlockPath: '/__pyric/unlock',
    });

    // An explicit wrong session header still returns 401 without unlock_required.
    const wrongHeaderInit = await rawRequest({
      port: server.port,
      path: '/__pyric/init.json',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-session-token': 'wrong-header-token',
      },
    });
    expect(wrongHeaderInit.status).toBe(401);
    const wrongHeaderBody = JSON.parse(wrongHeaderInit.body) as Record<string, unknown>;
    expect(wrongHeaderBody.error).not.toBe('unlock_required');
    expect(wrongHeaderBody.reason).toBe('invalid-session-token');

    // Authenticated init.json behind TLS proxy emits cookie with ; Secure.
    const authedInit = await rawRequest({
      port: server.port,
      path: '/__pyric/init.json',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        'x-pyric-session-token': token,
      },
    });
    expect(authedInit.status).toBe(200);
    const setCookie = String(authedInit.headers['set-cookie'] ?? '');
    expect(setCookie).toContain(`__pyric_session_${server.port}=`);
    expect(setCookie).toContain('; Secure');

    // Bare suffix tailnet.ts.net is rejected (403) even with a valid token.
    const bareSuffix = await rawRequest({
      port: server.port,
      path: '/__pyric/init.json',
      headers: {
        Host: 'tailnet.ts.net',
        'x-pyric-session-token': token,
      },
    });
    expect(bareSuffix.status).toBe(403);

    // Unauthenticated avatar on remote host gets 401; authenticated via cookie gets 200; cross-site gets 403.
    const unauthAvatar = await rawRequest({
      port: server.port,
      path: '/__pyric/assets/avatar/alice',
      headers: { Host: 'box.tailnet.ts.net:8443', 'x-forwarded-proto': 'https' },
    });
    expect(unauthAvatar.status).toBe(401);

    const cookieHeader = setCookie.split(';')[0] ?? '';
    const authedAvatar = await rawRequest({
      port: server.port,
      path: '/__pyric/assets/avatar/alice',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        Cookie: cookieHeader,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(authedAvatar.status).toBe(200);

    const crossSiteRemoteAvatar = await rawRequest({
      port: server.port,
      path: '/__pyric/assets/avatar/alice',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        Cookie: cookieHeader,
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(crossSiteRemoteAvatar.status).toBe(403);

    // Unauthenticated Studio UI returns 401 unlock guidance; authenticated succeeds.
    const lockedStudio = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: { Host: 'box.tailnet.ts.net:8443', 'x-forwarded-proto': 'https' },
    });
    expect(lockedStudio.status).toBe(401);
    expect(lockedStudio.body).toContain('/__pyric/unlock');

    const authedStudio = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'x-forwarded-proto': 'https',
        Cookie: cookieHeader,
      },
    });
    expect(authedStudio.status).toBe(200);
    expect(authedStudio.body).toContain('studio-ok');
  });
});
