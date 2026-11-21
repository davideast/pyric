/**
 * Negative security regression matrix (cases 9-15): proxy header spoofing,
 * query-string unlock tokens, open redirects, 429 throttling, REST 0.0.0.0,
 * pyric live second gate, and unauthenticated avatar/Studio/flow/storage routes.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { createFlowTreatmentHost } from '../../src/serve/flow-treatment-host.js';
import { createGuardPolicy, effectiveForwardedHost, effectiveRequestScheme, evaluateGuard } from '../../src/serve/guard-policy.js';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { createUnlockHandler, UNLOCK_PATH } from '../../src/serve/unlock-route.js';

const handles: ServeHandle[] = [];
const mounts: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (mounts.length > 0) {
    const mount = mounts.pop();
    if (mount !== undefined) await mount.close();
  }
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

function rawHttp(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function makeFakeReq(
  headers: Record<string, string>,
  socket: { remoteAddress?: string; localPort?: number; encrypted?: boolean } = {},
  method = 'GET',
): IncomingMessage {
  return {
    method,
    headers,
    socket: { remoteAddress: socket.remoteAddress ?? '127.0.0.1', localPort: socket.localPort ?? 5173, encrypted: socket.encrypted ?? false },
  } as unknown as IncomingMessage;
}

function emptyPayload(): InitPayload {
  return { rules: 'rules_version = "2";', rulesHash: 'neg-matrix-hash', storageRules: null, storageRulesHash: null, bridgeUrl: 'ws://localhost:5173/__pyric/sandbox', seed: null };
}

describe('remote-access negative security matrix (cases 9-15)', () => {
  it('9. ignores spoofed X-Forwarded-Proto and X-Forwarded-Host from untrusted peer IPs', () => {
    const req = makeFakeReq(
      {
        host: 'devbox.example.com:5173',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'localhost:5173',
      },
      { remoteAddress: '198.51.100.77', localPort: 5173, encrypted: false },
    );
    expect(effectiveRequestScheme(req, 'loopback')).toBe('http:');
    expect(effectiveForwardedHost(req, 'loopback')).toBeUndefined();

    const markedReq = makeFakeReq(
      {
        host: 'devbox.example.com:5173',
        'x-pyric-remote-peer': '1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'localhost:5173',
      },
      { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
    );
    expect(effectiveRequestScheme(markedReq, 'loopback')).toBe('http:');
    expect(effectiveForwardedHost(markedReq, 'loopback')).toBeUndefined();
  });

  it('10. rejects GET /__pyric/unlock?token=<secret> and ?code=<secret> without minting a cookie', async () => {
    const token = 'never-put-in-query';
    const root = makeTempDir('pyric-neg-10-');
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    const remoteAccess = { allowedHosts: ['devbox.example.com'] };
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      initPayload: emptyPayload,
      sessionToken: token,
      remoteAccess,
    });
    const server = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      remoteAccess,
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    for (const key of ['token', 'code', 'sessionToken', 'session_token']) {
      const res = await rawHttp({
        port: server.port,
        path: `${UNLOCK_PATH}?${key}=${token}`,
        headers: { Host: `devbox.example.com:${server.port}` },
      });
      expect(res.status).toBe(400);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('11. refuses open redirect targets on GET and POST /__pyric/unlock', async () => {
    const token = 'redirect-guard-token';
    const root = makeTempDir('pyric-neg-11-');
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    const remoteAccess = { allowedHosts: ['devbox.example.com'] };
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      initPayload: emptyPayload,
      sessionToken: token,
      remoteAccess,
    });
    const server = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      remoteAccess,
      namespaceHandler: ns,
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    for (const evil of ['//evil.example', 'https://evil.example/a', 'http://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const getRes = await rawHttp({
        port: server.port,
        path: `${UNLOCK_PATH}?next=${encodeURIComponent(evil)}`,
        headers: { Host: `devbox.example.com:${server.port}` },
      });
      expect(getRes.status).toBe(400);

      const postRes = await rawHttp({
        port: server.port,
        path: UNLOCK_PATH,
        method: 'POST',
        headers: {
          Host: `devbox.example.com:${server.port}`,
          Origin: `http://devbox.example.com:${server.port}`,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token, next: evil }),
      });
      expect(postRes.status).toBe(400);
      expect(postRes.headers['set-cookie']).toBeUndefined();
    }
  });

  it('12. throttles repeated failed unlock attempts with 429 and Retry-After', async () => {
    const nowMs = 50_000;
    const handler = createUnlockHandler({
      boundHost: '127.0.0.1',
      allowedHosts: ['devbox.example.com'],
      remoteAccess: { allowedHosts: ['devbox.example.com'], allowPeers: ['100.64.0.0/10'] },
      sessionToken: 'true-token',
      rateLimit: { maxFailures: 10, windowMs: 60_000, now: () => nowMs },
    });
    const callBad = async (): Promise<{ status: number; retryAfter?: string }> => {
      const buf = Buffer.from(JSON.stringify({ token: 'guess' }));
      let status = 0;
      let retryAfter: string | undefined;
      const headers: Record<string, string> = {};
      await handler(
        {
          method: 'POST',
          headers: {
            host: 'devbox.example.com:5173',
            origin: 'http://devbox.example.com:5173',
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            'content-length': String(buf.byteLength),
          },
          socket: { remoteAddress: '100.64.1.9', localPort: 5173, encrypted: false },
          async *[Symbol.asyncIterator]() { yield buf; },
          resume() {},
        } as never,
        {
          socket: { localPort: 5173, encrypted: false },
          getHeader: (k: string) => headers[k.toLowerCase()],
          setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = String(v); },
          writeHead(code: number, extra?: Record<string, string>) {
            status = code;
            retryAfter = extra?.['Retry-After'];
            return this;
          },
          end() { return this; },
        } as never,
        new URL('http://devbox.example.com:5173/__pyric/unlock'),
      );
      return { status, retryAfter };
    };
    for (let i = 0; i < 9; i += 1) {
      expect((await callBad()).status).toBe(401);
    }
    const tenth = await callBad();
    expect(tenth.status).toBe(429);
    expect(Number(tenth.retryAfter)).toBeGreaterThan(0);
  });

  it('13. gates Auth/RTDB REST against unauthenticated remote peers on --host 0.0.0.0', async () => {
    const publicDir = makeTempDir('pyric-neg-13-');
    let invoked = 0;
    const server = await startStaticServer({
      publicDir,
      host: '0.0.0.0',
      port: 0,
      sessionToken: 'rest-secret-13',
      allowedHosts: ['devbox.example.com'],
      restHandler: async (_req, res) => {
        invoked += 1;
        res.writeHead(200).end('{}');
        return true;
      },
      logger: silentServeLogger(),
    });
    handles.push(server);

    const peerRes = await rawHttp({
      port: server.port,
      path: '/items.json',
      headers: { Host: `127.0.0.1:${server.port}`, 'x-pyric-remote-peer': '1' },
    });
    expect(peerRes.status).toBe(403);

    const authRes = await rawHttp({
      port: server.port,
      path: '/v1/accounts:signInWithCustomToken',
      method: 'POST',
      headers: { Host: 'devbox.example.com' },
      body: '{}',
    });
    expect(authRes.status).toBe(403);
    expect(invoked).toBe(0);
  });

  it('14. keeps pyric live closed to remote peers unless allowLiveRemotePeers is explicitly true', () => {
    const gated = createGuardPolicy({
      boundHost: '0.0.0.0',
      allowedHosts: ['devbox.example.com'],
      allowPeers: 'any',
      remoteAccessEnabled: true,
      sessionToken: 'live-secret',
    });
    const blocked = evaluateGuard(
      makeFakeReq(
        { host: 'devbox.example.com:5173', 'x-pyric-session-token': 'live-secret' },
        { remoteAddress: '100.64.2.5', localPort: 5173 },
      ),
      gated,
      'bridge-live',
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.status).toBe(403);
      expect(blocked.reason).toBe('live-remote-peer-refused');
    }

    const explicitLive = createGuardPolicy({
      boundHost: '0.0.0.0',
      allowedHosts: ['devbox.example.com'],
      allowPeers: 'any',
      allowLiveRemotePeers: true,
      remoteAccessEnabled: true,
      sessionToken: 'live-secret',
    });
    const allowed = evaluateGuard(
      makeFakeReq(
        { host: 'devbox.example.com:5173', 'x-pyric-session-token': 'live-secret' },
        { remoteAddress: '100.64.2.5', localPort: 5173 },
      ),
      explicitLive,
      'bridge-live',
    );
    expect(allowed.ok).toBe(true);
  });

  it('15. refuses unauthenticated avatar, Studio UI, flow, and storage download token requests on remote host', async () => {
    const root = makeTempDir('pyric-neg-15-');
    const sdkDir = join(root, 'sdk');
    const siteDir = join(root, 'site');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(join(siteDir, 'studio'), { recursive: true });
    writeFileSync(join(siteDir, 'studio-routes.json'), JSON.stringify({ routes: ['studio'] }));
    writeFileSync(join(siteDir, 'studio', 'index.html'), '<html><body>studio-secret</body></html>');

    const token = 'gate-15-secret';
    const remoteAccess = { allowedHosts: ['.tailnet.ts.net'] };
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      siteUiDir: siteDir,
      initPayload: emptyPayload,
      sessionToken: token,
      remoteAccess,
      avatars: {
        resolve: async () => ({
          data: new Uint8Array([1, 2, 3]),
          contentType: 'image/png',
          origin: 'cache',
        }),
      } as never,
    });
    const mount = createBridgeMount({
      disableAuditLog: true,
      sessionToken: token,
      remoteAccess,
      upgradeGuard: { boundHost: '127.0.0.1', allowedHosts: ['.tailnet.ts.net'] },
    });
    mounts.push(mount);
    const server = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      remoteAccess,
      sessionToken: token,
      namespaceHandler: async (req, res, url) => (await mount.handler(req, res, url)) || ns(req, res, url),
      logger: silentServeLogger(),
    });
    handles.push(server);

    const avatar = await rawHttp({
      port: server.port,
      path: '/__pyric/assets/avatar/alice',
      headers: { Host: `box.tailnet.ts.net:${server.port}` },
    });
    expect(avatar.status).toBe(401);

    const studio = await rawHttp({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: { Host: `box.tailnet.ts.net:${server.port}` },
    });
    expect(studio.status).toBe(401);
    expect(studio.body).not.toContain('studio-secret');

    const storage = await rawHttp({
      port: server.port,
      path: '/__pyric/storage/v0/b/my-bucket/o/doc.txt?alt=media&token=dl',
      headers: { Host: `box.tailnet.ts.net:${server.port}` },
    });
    expect([401, 403]).toContain(storage.status);

    const flow = await createFlowTreatmentHost(root, undefined, {
      boundHost: '127.0.0.1',
      sessionToken: token,
      remoteAccess,
    });
    let flowStatus = 0;
    await flow.handle(
      makeFakeReq({ host: 'box.tailnet.ts.net:5173' }),
      {
        setHeader() {},
        end() {},
        set statusCode(code: number) { flowStatus = code; },
      } as unknown as ServerResponse,
      new URL('http://box.tailnet.ts.net:5173/__pyric/flow/manifest.json'),
    );
    expect(flowStatus).toBe(401);
  });
});
