import { afterEach, describe, expect, it } from 'bun:test';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackAddress,
  silentServeLogger,
  startStaticServer,
  type ServeHandle,
} from '../../src/serve/server.js';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';

function emptyInitPayload(): InitPayload {
  return {
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
  };
}

function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
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
    req.end();
  });
}

const handles: ServeHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('loopback Host and Origin guard (ADR 0024 Decision 5)', () => {
  it('rejects wildcard bind addresses, malformed Host suffixes/userinfo, and out-of-range IPv4 octets across unit and HTTP boundaries', async () => {
    const boundVariants = [
      '0.0.0.0',
      '0.0.0.0.',
      '::',
      '[::]',
      '0:0:0:0:0:0:0:0',
      '::ffff:0.0.0.0',
      '::ffff:0:0',
      '::ffff:0000:0000',
      'localhost',
      '127.0.0.1',
    ];
    for (const boundHost of boundVariants) {
      expect(isAllowedHost('0', boundHost)).toBe(false);
      expect(isAllowedHost('0.0.0.0', boundHost)).toBe(false);
      expect(isAllowedHost('0.0.0.0:3473', boundHost)).toBe(false);
      expect(isAllowedHost('0.0.0.0.:3473', boundHost)).toBe(false);
      expect(isAllowedHost('::', boundHost)).toBe(false);
      expect(isAllowedHost('[::]', boundHost)).toBe(false);
      expect(isAllowedHost('[::]:3473', boundHost)).toBe(false);
      expect(isAllowedHost('[0:0:0:0:0:0:0:0]:3473', boundHost)).toBe(false);
      expect(isAllowedHost('[::ffff:0.0.0.0]:3473', boundHost)).toBe(false);
      expect(isAllowedHost('[::ffff:0:0]:3473', boundHost)).toBe(false);
      expect(isAllowedHost('[::ffff:0000:0000]:3473', boundHost)).toBe(false);
      expect(isAllowedOrigin('http://0.0.0.0:3473', boundHost, [], 3473, 'http:')).toBe(false);
      expect(isAllowedOrigin('http://[::]:3473', boundHost, [], 3473, 'http:')).toBe(false);
      expect(isAllowedOrigin('http://[::ffff:0.0.0.0]:3473', boundHost, [], 3473, 'http:')).toBe(false);
      expect(isAllowedOrigin('http://[::ffff:0000:0000]:3473', boundHost, [], 3473, 'http:')).toBe(false);
    }

    // Strict Host & IPv4 loopback parsing: reject bracketed userinfo/suffixes/bad ports and octets > 255.
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.255.255.254')).toBe(true);
    expect(isLoopbackAddress('127.256.999.999')).toBe(false);
    expect(isAllowedHost('127.256.999.999:3473', '127.0.0.1')).toBe(false);
    expect(isAllowedHost('[::1]@attacker.example', 'localhost')).toBe(false);
    expect(isAllowedHost('[::1].attacker.example', 'localhost')).toBe(false);
    expect(isAllowedHost('[::1]:notaport', 'localhost')).toBe(false);
    expect(isAllowedHost('[::1]:999999', 'localhost')).toBe(false);
    expect(isAllowedHost('[::1]:0', 'localhost')).toBe(false);
    expect(isAllowedHost('[::1]:3473/evil', 'localhost')).toBe(false);
    expect(isAllowedHost('attacker.example@127.0.0.1:3473', '127.0.0.1')).toBe(false);
    expect(isAllowedHost('127.0.0.1:3473/evil', '127.0.0.1')).toBe(false);

    // Valid loopback hosts continue to pass when bound to 0.0.0.0 or ::.
    expect(isAllowedHost('127.0.0.1:3473', '0.0.0.0')).toBe(true);
    expect(isAllowedHost('localhost:3473', '0.0.0.0')).toBe(true);
    expect(isAllowedHost('[::1]:3473', '::')).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'pyric-wildcard-guard-'));
    tempDirs.push(root);
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');
    writeFileSync(join(sdkDir, 'worker.js'), 'export const ok = 1;\n');

    const token = 'wildcard-bound-test-token';
    const ns = createPyricNamespace({
      boundHost: '0.0.0.0',
      allowedHosts: ['tunnel.example'],
      sdkDir,
      sessionToken: token,
      requireSessionToken: true,
      initPayload: emptyInitPayload,
    });
    const server = await startStaticServer({
      publicDir: root,
      host: '0.0.0.0',
      port: 0,
      allowedHosts: ['tunnel.example'],
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    for (const badHost of [
      `0.0.0.0:${server.port}`,
      '[::1]@attacker.example',
      `[::1]:${server.port}/evil`,
      '127.256.999.999:3473',
    ]) {
      const rejected = await rawRequest({
        port: server.port,
        path: '/__pyric/diagnostics',
        headers: { Host: badHost, 'x-pyric-session-token': token },
      });
      expect(rejected.status, badHost).toBe(403);
    }

    const loopbackReq = await rawRequest({
      port: server.port,
      path: '/__pyric/diagnostics',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Origin: `http://127.0.0.1:${server.port}`,
        'x-pyric-session-token': token,
      },
    });
    expect(loopbackReq.status).toBe(200);
  });

  it('rejects Origin userinfo/path/query, enforces scheme on explicit ports and https downgrades, honors host:port allowedHosts, and serves default-port TLS tunnels over HTTP', async () => {
    for (const invalidOrigin of [
      'http://attacker.example@127.0.0.1:3473',
      'http://user:pass@127.0.0.1:3473',
      'http://127.0.0.1:3473/some/path?query=1',
      'http://127.0.0.1:3473#frag',
    ]) {
      expect(isAllowedOrigin(invalidOrigin, '127.0.0.1', [], 3473, 'http:')).toBe(false);
    }
    expect(isAllowedOrigin('https://attacker.example@tunnel.example', '127.0.0.1', ['tunnel.example'], 3473, 'http:')).toBe(false);

    // Default public port on TLS-terminating tunnel stays allowed on plain-HTTP listener,
    // while cleartext http:// downgrade is rejected on an https: listener.
    expect(isAllowedOrigin('https://tunnel.example', '127.0.0.1', ['tunnel.example'], 3473, 'http:')).toBe(true);
    expect(isAllowedOrigin('http://tunnel.example', '127.0.0.1', ['tunnel.example'], 3473, 'http:')).toBe(true);
    expect(isAllowedOrigin('https://tunnel.example', '127.0.0.1', ['tunnel.example'], 8443, 'https:')).toBe(true);
    expect(isAllowedOrigin('http://tunnel.example', '127.0.0.1', ['tunnel.example'], 8443, 'https:')).toBe(false);
    expect(isAllowedOrigin('http://tunnel.example:80', '127.0.0.1', ['tunnel.example'], 8443, 'https:')).toBe(false);

    // Bare hostname in allowedHosts with an explicit Origin port must match both boundPort AND expectedScheme.
    expect(isAllowedOrigin('http://tunnel.example:3473', '127.0.0.1', ['tunnel.example'], 3473, 'http:')).toBe(true);
    expect(isAllowedOrigin('https://tunnel.example:3473', '127.0.0.1', ['tunnel.example'], 3473, 'http:')).toBe(false);
    expect(isAllowedOrigin('https://tunnel.example:8443', '127.0.0.1', ['tunnel.example'], 8443, 'https:')).toBe(true);
    expect(isAllowedOrigin('http://tunnel.example:8443', '127.0.0.1', ['tunnel.example'], 8443, 'https:')).toBe(false);

    // Explicit host:port in allowedHosts permits TLS tunnel on that port while rejecting other ports and https->http downgrades.
    expect(isAllowedHost('tunnel.example:8443', '127.0.0.1', ['tunnel.example:8443'])).toBe(true);
    expect(isAllowedHost('tunnel.example:9999', '127.0.0.1', ['tunnel.example:8443'])).toBe(false);
    expect(isAllowedOrigin('https://tunnel.example:8443', '127.0.0.1', ['tunnel.example:8443'], 3473, 'http:')).toBe(true);
    expect(isAllowedOrigin('https://tunnel.example:9999', '127.0.0.1', ['tunnel.example:8443'], 3473, 'http:')).toBe(false);
    expect(isAllowedOrigin('http://tunnel.example:8443', '127.0.0.1', ['tunnel.example:8443'], 3473, 'https:')).toBe(false);

    // HTTP-level positive control: authenticated default-port TLS tunnel request answers 200; userinfo Origin answers 403.
    const root = mkdtempSync(join(tmpdir(), 'pyric-tunnel-origin-'));
    tempDirs.push(root);
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');
    const token = 'tunnel-origin-session-token';
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      sdkDir,
      sessionToken: token,
      requireSessionToken: true,
      initPayload: emptyInitPayload,
    });
    const server = await startStaticServer({
      publicDir: root,
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['tunnel.example'],
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    const validTunnel = await rawRequest({
      port: server.port,
      path: '/__pyric/diagnostics',
      headers: {
        Host: 'tunnel.example',
        Origin: 'https://tunnel.example',
        'x-pyric-session-token': token,
      },
    });
    expect(validTunnel.status).toBe(200);

    const userinfoOrigin = await rawRequest({
      port: server.port,
      path: '/__pyric/diagnostics',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Origin: `http://attacker.example@127.0.0.1:${server.port}`,
        'x-pyric-session-token': token,
      },
    });
    expect(userinfoOrigin.status).toBe(403);
  });

  it('rejects remote peers, tunnel Hosts, foreign Origins, and foreign Fetch Metadata on /__pyric/sdk/* while preserving local loopback cookie bootstrap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-sdk-guard-'));
    tempDirs.push(root);
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');
    writeFileSync(join(sdkDir, 'worker.js'), 'export const workerReady = true;\n');

    const token = 'sdk-route-session-token';
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      sdkDir,
      sessionToken: token,
      requireSessionToken: true,
      initPayload: emptyInitPayload,
    });
    const server = await startStaticServer({
      publicDir: root,
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['tunnel.example'],
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    const rejectedVectors: Array<{ label: string; headers: Record<string, string> }> = [
      {
        label: 'remote peer via marker',
        headers: { Host: `127.0.0.1:${server.port}`, 'x-pyric-remote-peer': '1' },
      },
      {
        label: 'allowedHosts tunnel Host on unauthenticated SDK route',
        headers: { Host: 'tunnel.example' },
      },
      {
        label: 'foreign Origin',
        headers: { Host: `127.0.0.1:${server.port}`, Origin: 'https://other.example' },
      },
      {
        label: 'userinfo Origin',
        headers: { Host: `127.0.0.1:${server.port}`, Origin: `http://attacker.example@127.0.0.1:${server.port}` },
      },
      {
        label: 'sibling localhost port Origin',
        headers: { Host: `127.0.0.1:${server.port}`, Origin: `http://127.0.0.1:${server.port + 1}` },
      },
      {
        label: 'Sec-Fetch-Site: cross-site',
        headers: { Host: `127.0.0.1:${server.port}`, 'Sec-Fetch-Site': 'cross-site' },
      },
      {
        label: 'Sec-Fetch-Site: same-site (cross-port)',
        headers: { Host: `127.0.0.1:${server.port}`, 'Sec-Fetch-Site': 'same-site' },
      },
    ];

    for (const vector of rejectedVectors) {
      const res = await rawRequest({
        port: server.port,
        path: '/__pyric/sdk/worker.js',
        headers: vector.headers,
      });
      expect(res.status, vector.label).toBe(403);
    }

    const localSdk = await rawRequest({
      port: server.port,
      path: '/__pyric/sdk/worker.js',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(localSdk.status).toBe(200);
    expect(localSdk.body).toContain('workerReady');
    expect(String(localSdk.headers['set-cookie'] ?? '')).toContain(`__pyric_session_${server.port}=`);
  });

  it('rejects remote peers, tunnel Hosts, and foreign Origins on /__pyric/assets/avatar/* while preserving local tokenless <img> loads and disabling source callbacks on cross-site and same-site', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-avatar-guard-'));
    tempDirs.push(root);
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');

    const observedSourceAllowed: Array<boolean | undefined> = [];
    const token = 'avatar-route-session-token';
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      sdkDir,
      sessionToken: token,
      requireSessionToken: true,
      avatars: {
        async resolve(req) {
          observedSourceAllowed.push(req.sourceAllowed);
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
      allowedHosts: ['tunnel.example'],
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    const rejectedVectors: Array<{ label: string; headers: Record<string, string> }> = [
      {
        label: 'remote peer via marker',
        headers: { Host: `127.0.0.1:${server.port}`, 'x-pyric-remote-peer': '1' },
      },
      {
        label: 'allowedHosts tunnel Host',
        headers: { Host: 'tunnel.example' },
      },
      {
        label: 'foreign Origin',
        headers: { Host: `127.0.0.1:${server.port}`, Origin: 'https://other.example' },
      },
      {
        label: 'sibling localhost port Origin',
        headers: { Host: `127.0.0.1:${server.port}`, Origin: `http://127.0.0.1:${server.port + 1}` },
      },
    ];

    for (const vector of rejectedVectors) {
      const res = await rawRequest({
        port: server.port,
        path: '/__pyric/assets/avatar/user-alpha',
        headers: vector.headers,
      });
      expect(res.status, vector.label).toBe(403);
    }
    expect(observedSourceAllowed).toEqual([]);

    const sameOriginAvatar = await rawRequest({
      port: server.port,
      path: '/__pyric/assets/avatar/user-alpha',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Dest': 'image',
      },
    });
    expect(sameOriginAvatar.status).toBe(200);

    const crossSiteAvatar = await rawRequest({
      port: server.port,
      path: '/__pyric/assets/avatar/user-beta',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Dest': 'image',
      },
    });
    expect(crossSiteAvatar.status).toBe(200);

    const sameSiteAvatar = await rawRequest({
      port: server.port,
      path: '/__pyric/assets/avatar/user-gamma',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Dest': 'image',
      },
    });
    expect(sameSiteAvatar.status).toBe(200);

    expect(observedSourceAllowed).toEqual([undefined, false, false]);
  });

  it('preserves local loopback Studio redirects, HTML session bootstrap, and 503 missing-assets help while rejecting remote peers, foreign hosts/origins, and unauthenticated static assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-studio-gate-'));
    tempDirs.push(root);
    const publicDir = join(root, 'public');
    const sdkDir = join(root, 'sdk');
    const siteUiDir = join(root, 'site');
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(join(siteUiDir, 'studio'), { recursive: true });
    mkdirSync(join(siteUiDir, '_astro'), { recursive: true });
    writeFileSync(join(siteUiDir, 'studio-routes.json'), JSON.stringify({ routes: ['studio'] }));
    writeFileSync(join(siteUiDir, 'studio', 'index.html'), '<!doctype html><html><head></head><body>studio-hub</body></html>');
    writeFileSync(join(siteUiDir, '_astro', 'chunk.js'), 'export const studioChunk = 1;\n');

    const token = 'studio-gate-session-token';
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      sdkDir,
      siteUiDir,
      workerVersion: '0123456789abcdef',
      sessionToken: token,
      requireSessionToken: true,
      initPayload: emptyInitPayload,
    });
    const server = await startStaticServer({
      publicDir,
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['tunnel.example'],
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    // Remote peer and unauthenticated tunnel/foreign Host or Origin are rejected with 403.
    const remoteStudio = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: { Host: `127.0.0.1:${server.port}`, 'x-pyric-remote-peer': '1' },
    });
    expect(remoteStudio.status).toBe(403);

    const unauthTunnelStudio = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: { Host: 'tunnel.example' },
    });
    expect(unauthTunnelStudio.status).toBe(403);

    // Non-HTML Studio subresources still require session token (401) before bootstrap cookie is set.
    const unauthAssetProbe = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/_astro/chunk.js',
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    expect(unauthAssetProbe.status).toBe(401);

    // Local loopback requests (including bare readiness probes and browser navigations) redirect 301 -> 200 and bootstrap cookie.
    const localRedirect = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio?view=listeners',
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    expect(localRedirect.status).toBe(301);
    expect(localRedirect.headers.location).toBe('/__pyric/ui/studio/?view=listeners');

    const browserHtmlNav = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio/?view=listeners',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Accept: 'text/html,application/xhtml+xml',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      },
    });
    expect(browserHtmlNav.status).toBe(200);
    expect(browserHtmlNav.body).toContain('studio-hub');
    const setCookie = String(browserHtmlNav.headers['set-cookie'] ?? '');
    expect(setCookie).toContain(`__pyric_session_${server.port}=`);

    const cookieHeader = setCookie.split(';')[0]!;
    const authedAsset = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/_astro/chunk.js',
      headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookieHeader },
    });
    expect(authedAsset.status).toBe(200);
    expect(authedAsset.body).toContain('studioChunk');

    // Missing siteUiDir on local loopback preserves 503 Studio help page while rejecting remote peers with 403.
    const missingUiNs = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      sessionToken: token,
      requireSessionToken: true,
      studio: {
        workspace: { root, read: async () => '', write: async () => {}, list: async () => [] },
        projects: { list: async () => [], get: async () => null, put: async () => {}, remove: async () => {} },
      } as unknown as NonNullable<Parameters<typeof createPyricNamespace>[0]['studio']>,
      initPayload: emptyInitPayload,
    });
    const missingUiServer = await startStaticServer({
      publicDir,
      host: '127.0.0.1',
      port: 0,
      namespaceHandler: missingUiNs,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(missingUiServer);

    const localMissingUi = await rawRequest({
      port: missingUiServer.port,
      path: '/__pyric/ui/studio',
      headers: { Host: `127.0.0.1:${missingUiServer.port}` },
    });
    expect(localMissingUi.status).toBe(503);
    expect(localMissingUi.body).toContain('Studio is unavailable');

    const remoteMissingUi = await rawRequest({
      port: missingUiServer.port,
      path: '/__pyric/ui/studio',
      headers: { Host: `127.0.0.1:${missingUiServer.port}`, 'x-pyric-remote-peer': '1' },
    });
    expect(remoteMissingUi.status).toBe(403);
  });
});
