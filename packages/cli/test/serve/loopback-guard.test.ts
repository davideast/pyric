import { afterEach, describe, expect, it } from 'bun:test';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import {
  isAllowedHost,
  isAllowedOrigin,
  silentServeLogger,
  startStaticServer,
  type ServeHandle,
} from '../../src/serve/server.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  it('rejects wildcard bind addresses (0.0.0.0, ::, [::]) in Host and Origin even when wildcard-bound', async () => {
    for (const boundHost of ['0.0.0.0', '::', '[::]', 'localhost', '127.0.0.1']) {
      expect(isAllowedHost('0.0.0.0', boundHost)).toBe(false);
      expect(isAllowedHost('0.0.0.0:3473', boundHost)).toBe(false);
      expect(isAllowedHost('0.0.0.0.:3473', boundHost)).toBe(false);
      expect(isAllowedHost('::', boundHost)).toBe(false);
      expect(isAllowedHost('[::]', boundHost)).toBe(false);
      expect(isAllowedHost('[::]:3473', boundHost)).toBe(false);
      expect(isAllowedHost('[0:0:0:0:0:0:0:0]:3473', boundHost)).toBe(false);
      expect(isAllowedHost('[::ffff:0.0.0.0]:3473', boundHost)).toBe(false);
      expect(isAllowedHost('[::ffff:0:0]:3473', boundHost)).toBe(false);
      expect(isAllowedOrigin('http://0.0.0.0:3473', boundHost, [], 3473, 'http:')).toBe(false);
      expect(isAllowedOrigin('http://[::]:3473', boundHost, [], 3473, 'http:')).toBe(false);
      expect(isAllowedOrigin('http://[::ffff:0.0.0.0]:3473', boundHost, [], 3473, 'http:')).toBe(false);
    }

    // Loopback hosts continue to pass when bound to 0.0.0.0 or ::.
    expect(isAllowedHost('127.0.0.1:3473', '0.0.0.0')).toBe(true);
    expect(isAllowedHost('localhost:3473', '0.0.0.0')).toBe(true);
    expect(isAllowedHost('[::1]:3473', '::')).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'pyric-wildcard-guard-'));
    tempDirs.push(root);
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>ok</body></html>\n');

    const token = 'wildcard-bound-test-token';
    const ns = createPyricNamespace({
      boundHost: '0.0.0.0',
      allowedHosts: ['tunnel.example'],
      sdkDir,
      sessionToken: token,
      requireSessionToken: true,
      initPayload: () => ({
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
        seed: null,
      }),
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

    const wildcardHostReq = await rawRequest({
      port: server.port,
      path: '/__pyric/diagnostics',
      headers: {
        Host: `0.0.0.0:${server.port}`,
        Origin: `http://0.0.0.0:${server.port}`,
        'x-pyric-session-token': token,
      },
    });
    expect(wildcardHostReq.status).toBe(403);

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

  it('enforces expectedScheme on allowedHosts Origins with explicit ports while preserving default-port TLS tunnels', async () => {
    // Default public port (originUrl.port === '') on TLS-terminating tunnel stays allowed on plain-HTTP listener.
    expect(
      isAllowedOrigin('https://tunnel.example', '127.0.0.1', ['tunnel.example'], 3473, 'http:'),
    ).toBe(true);
    expect(
      isAllowedOrigin('http://tunnel.example', '127.0.0.1', ['tunnel.example'], 3473, 'http:'),
    ).toBe(true);

    // Explicit port must match both boundPort AND expectedScheme.
    expect(
      isAllowedOrigin('http://tunnel.example:3473', '127.0.0.1', ['tunnel.example'], 3473, 'http:'),
    ).toBe(true);
    expect(
      isAllowedOrigin('https://tunnel.example:3473', '127.0.0.1', ['tunnel.example'], 3473, 'http:'),
    ).toBe(false);
    expect(
      isAllowedOrigin('https://tunnel.example:8443', '127.0.0.1', ['tunnel.example'], 8443, 'https:'),
    ).toBe(true);
    expect(
      isAllowedOrigin('http://tunnel.example:8443', '127.0.0.1', ['tunnel.example'], 8443, 'https:'),
    ).toBe(false);
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
      initPayload: () => ({
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
        seed: null,
      }),
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

    // Non-regression control: local same-origin loopback load succeeds without token and bootstraps session cookie.
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
      initPayload: () => ({
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
        seed: null,
      }),
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

    // Non-regression controls: local loopback <img> loads without token succeed;
    // same-origin allows source, while cross-site and same-site disable source callbacks.
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

  it('requires session token (401) for non-HTML / programmatic /__pyric/ui/* probes under requireSessionToken while preserving local browser HTML navigation bootstrap', async () => {
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
      sdkDir,
      siteUiDir,
      workerVersion: '0123456789abcdef',
      sessionToken: token,
      requireSessionToken: true,
      initPayload: () => ({
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
        seed: null,
      }),
    });
    const server = await startStaticServer({
      publicDir,
      host: '127.0.0.1',
      port: 0,
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    // Programmatic / non-HTML probes without session token receive 401 before 301/404.
    const bareProbe = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio',
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    expect(bareProbe.status).toBe(401);

    const fetchProbe = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Accept: '*/*',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
      },
    });
    expect(fetchProbe.status).toBe(401);

    const corsHtmlAcceptProbe = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Accept: 'text/html',
        'Sec-Fetch-Mode': 'cors',
      },
    });
    expect(corsHtmlAcceptProbe.status).toBe(401);

    const postProbe = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Accept: 'text/html',
      },
    });
    expect(postProbe.status).toBe(401);

    const unauthAssetProbe = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/_astro/chunk.js',
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    expect(unauthAssetProbe.status).toBe(401);

    // Non-regression control: real local browser HTML navigation redirects /__pyric/ui/studio -> /__pyric/ui/studio/,
    // serves 200 HTML, and bootstraps the port-scoped HttpOnly session cookie so subresources load cleanly.
    const browserDirNav = await rawRequest({
      port: server.port,
      path: '/__pyric/ui/studio?view=listeners',
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Accept: 'text/html,application/xhtml+xml',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      },
    });
    expect(browserDirNav.status).toBe(301);
    expect(browserDirNav.headers.location).toBe('/__pyric/ui/studio/?view=listeners');

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
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Cookie: cookieHeader,
      },
    });
    expect(authedAsset.status).toBe(200);
    expect(authedAsset.body).toContain('studioChunk');

    // Missing siteUiDir under requireSessionToken returns 401 when unauthenticated and 503 when authenticated.
    const missingUiNs = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      sessionToken: token,
      requireSessionToken: true,
      studio: {
        workspace: { root: root, read: async () => '', write: async () => {}, list: async () => [] },
        projects: { list: async () => [], get: async () => null, put: async () => {}, remove: async () => {} },
      } as unknown as NonNullable<Parameters<typeof createPyricNamespace>[0]['studio']>,
      initPayload: () => ({
        rules: null,
        rulesHash: null,
        storageRules: null,
        storageRulesHash: null,
        bridgeUrl: null,
        seed: null,
      }),
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

    const unauthMissingUi = await rawRequest({
      port: missingUiServer.port,
      path: '/__pyric/ui/studio',
      headers: { Host: `127.0.0.1:${missingUiServer.port}` },
    });
    expect(unauthMissingUi.status).toBe(401);

    const authedMissingUi = await rawRequest({
      port: missingUiServer.port,
      path: '/__pyric/ui/studio',
      headers: {
        Host: `127.0.0.1:${missingUiServer.port}`,
        'x-pyric-session-token': token,
      },
    });
    expect(authedMissingUi.status).toBe(503);
  });
});
