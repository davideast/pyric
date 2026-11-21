/**
 * Negative security regression matrix (cases 1-8): host, peer, wildcard,
 * DNS rebinding, leading-dot boundary, CSWSH, and cross-site CSRF invariants.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { createGuardPolicy, evaluateGuard } from '../../src/serve/guard-policy.js';
import { parseAllowedHostsStrict } from '../../src/serve/host-pattern.js';
import { isAllowedHost } from '../../src/serve/loopback-guard.js';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import { resolveRemoteAccessConfig } from '../../src/serve/remote-access-config.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { createStateStore } from '../../src/serve/state-store.js';
import { UNLOCK_PATH } from '../../src/serve/unlock-route.js';
import { attachViteGenerationMiddleware } from '../../src/serve/vite-generation-middleware.js';

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

describe('remote-access negative security matrix (15 fail-closed invariants)', () => {
  it('1. zero-config default refuses non-loopback Host, remote remoteAddress, and x-pyric-remote-peer', () => {
    const policy = createGuardPolicy({ boundHost: '127.0.0.1', sessionToken: 'tok-1' });
    const badHost = evaluateGuard(makeFakeReq({ host: 'devbox.example.com:5173' }), policy, 'namespace');
    expect(badHost.ok).toBe(false);
    if (!badHost.ok) {
      expect(badHost.status).toBe(403);
      expect(badHost.reason).toBe('disallowed-host');
    }

    const remoteAddr = evaluateGuard(
      makeFakeReq({ host: '127.0.0.1:5173' }, { remoteAddress: '203.0.113.10' }),
      policy,
      'namespace',
    );
    expect(remoteAddr.ok).toBe(false);
    if (!remoteAddr.ok) {
      expect(remoteAddr.status).toBe(403);
      expect(remoteAddr.reason).toBe('remote-peer');
    }

    const marked = evaluateGuard(
      makeFakeReq({ host: '127.0.0.1:5173', 'x-pyric-remote-peer': '1' }),
      policy,
      'bridge-ws',
    );
    expect(marked.ok).toBe(false);
    if (!marked.ok) expect(marked.reason).toBe('remote-peer');
  });

  it('2. legacy server.allowedHosts with sessionToken: false refuses unauthenticated tunnel Host with 403', async () => {
    const root = makeTempDir('pyric-neg-2-');
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      sdkDir,
      initPayload: emptyPayload,
      sessionToken: 'secret-2',
      requireSessionToken: false,
    });
    const server = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      allowedHosts: ['tunnel.example'],
      namespaceHandler: ns,
      sessionToken: 'secret-2',
      logger: silentServeLogger(),
    });
    handles.push(server);

    const res = await rawHttp({
      port: server.port,
      path: '/__pyric/init.json',
      headers: { Host: 'tunnel.example' },
    });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('secret-2');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('3. ignores Vite server.allowedHosts: true even when remoteAccess: true is enabled', () => {
    const resolved = resolveRemoteAccessConfig({
      option: true,
      viteAllowedHosts: true,
    });
    expect(resolved.allowedHosts).toEqual([]);
    let blockedStatus = 0;
    let middleware: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    const dispose = attachViteGenerationMiddleware({
      server: {
        config: { server: { host: '127.0.0.1', allowedHosts: true } },
        middlewares: {
          use(_prefix: string, fn: (req: unknown, res: unknown, next: () => void) => void) {
            middleware = fn;
          },
        },
      } as never,
      bridge: null,
      session: { handle: () => true } as never,
      allowedHosts: resolved.allowedHosts,
    });
    middleware?.(
      { url: '/__pyric/init.json', headers: { host: 'anything.example.com' } },
      { set statusCode(code: number) { blockedStatus = code; }, end() {} },
      () => {},
    );
    dispose();
    expect(blockedStatus).toBe(403);
  });

  it('4. rejects wildcards, true, single-label suffixes, wildcard IPs, and embedded wildcards', () => {
    const forbidden = ['*', 'true', '.', '.com', '.dev', '.local', '0.0.0.0', '[::]', '::ffff:0:0', '*.example.com'];
    for (const bad of forbidden) {
      expect(() => parseAllowedHostsStrict([bad]), `expected throw for ${bad}`).toThrow();
      expect(isAllowedHost('evil.com', '127.0.0.1', [bad])).toBe(false);
    }
    expect(isAllowedHost('0.0.0.0:5173', '0.0.0.0', [])).toBe(false);
    expect(isAllowedHost('[::]:5173', '::', [])).toBe(false);
  });

  it('5. blocks DNS rebinding for unconfigured Host when leading-dot allowlist is active', () => {
    const policy = createGuardPolicy({
      boundHost: '127.0.0.1',
      allowedHosts: ['.tailnet.ts.net'],
      remoteAccessEnabled: true,
      sessionToken: 'tok-5',
    });
    const decision = evaluateGuard(
      makeFakeReq({ host: 'evil.example:5173', 'x-pyric-session-token': 'tok-5' }),
      policy,
      'namespace',
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.status).toBe(403);
      expect(decision.reason).toBe('disallowed-host');
    }
  });

  it('6. enforces strict leading-dot boundary against bare suffix and concatenated prefix', () => {
    expect(isAllowedHost('box.tailnet.ts.net:5173', '127.0.0.1', ['.tailnet.ts.net'])).toBe(true);
    expect(isAllowedHost('a.b.tailnet.ts.net:5173', '127.0.0.1', ['.tailnet.ts.net'])).toBe(true);
    expect(isAllowedHost('tailnet.ts.net:5173', '127.0.0.1', ['.tailnet.ts.net'])).toBe(false);
    expect(isAllowedHost('eviltailnet.ts.net:5173', '127.0.0.1', ['.tailnet.ts.net'])).toBe(false);
  });

  it('7. destroys cross-origin WebSocket upgrades (CSWSH) even with a valid session cookie and allowed Host', async () => {
    const token = 'cswsh-token-secret';
    const mount = createBridgeMount({
      disableAuditLog: true,
      sessionToken: token,
      remoteAccess: { allowedHosts: ['.tailnet.ts.net'] },
      upgradeGuard: { boundHost: '127.0.0.1', allowedHosts: ['.tailnet.ts.net'] },
    });
    mounts.push(mount);
    const dir = makeTempDir('pyric-neg-7-');
    const server = await startStaticServer({
      publicDir: dir,
      port: 0,
      host: '127.0.0.1',
      logger: silentServeLogger(),
    });
    handles.push(server);
    mount.attachHost({
      servers: server.servers,
      projectDir: dir,
      origin: () => ({ host: '127.0.0.1', port: server.port }),
    });
    let destroyed = false;
    server.server.emit(
      'upgrade',
      {
        url: '/__pyric/sandbox',
        headers: {
          host: `box.tailnet.ts.net:${server.port}`,
          origin: 'https://evil.example',
          cookie: `__pyric_session_${server.port}=${token}`,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: server.port, encrypted: false },
      },
      { destroy() { destroyed = true; }, once() {} },
      Buffer.alloc(0),
    );
    expect(destroyed).toBe(true);
  });

  it('8. blocks cross-site CSRF on POST /__pyric/unlock, /hosted/method, /workspace, and /state', async () => {
    const token = 'csrf-secret-token';
    const root = makeTempDir('pyric-neg-8-');
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    const remoteAccess = { allowedHosts: ['devbox.example.com'] };
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      state: createStateStore(root),
      initPayload: emptyPayload,
      sessionToken: token,
      remoteAccess,
    });
    const mount = createBridgeMount({
      disableAuditLog: true,
      sessionToken: token,
      remoteAccess,
      upgradeGuard: { boundHost: '127.0.0.1', allowedHosts: ['devbox.example.com'] },
    });
    mounts.push(mount);
    const server = await startStaticServer({
      publicDir: root,
      port: 0,
      host: '127.0.0.1',
      remoteAccess,
      namespaceHandler: async (req, res, url) => (await mount.handler(req, res, url)) || ns(req, res, url),
      sessionToken: token,
      logger: silentServeLogger(),
    });
    handles.push(server);

    const cookie = `__pyric_session_${server.port}=${token}`;
    const csrfHeaders = {
      Host: `devbox.example.com:${server.port}`,
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site',
      'Content-Type': 'application/json',
      Cookie: cookie,
    };

    const unlockRes = await rawHttp({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: csrfHeaders,
      body: JSON.stringify({ token }),
    });
    expect(unlockRes.status).toBe(403);

    const methodRes = await rawHttp({
      port: server.port,
      path: '/__pyric/hosted/method',
      method: 'POST',
      headers: csrfHeaders,
      body: '{}',
    });
    expect(methodRes.status).toBe(403);

    const stateRes = await rawHttp({
      port: server.port,
      path: '/__pyric/state',
      method: 'POST',
      headers: csrfHeaders,
      body: '{}',
    });
    expect(stateRes.status).toBe(403);

    const policy = createGuardPolicy({
      boundHost: '127.0.0.1',
      allowedHosts: ['devbox.example.com'],
      remoteAccessEnabled: true,
      sessionToken: token,
    });
    const workspaceDecision = evaluateGuard(
      makeFakeReq(
        {
          host: 'devbox.example.com:5173',
          'sec-fetch-site': 'cross-site',
          cookie: `__pyric_session_5173=${token}`,
        },
        { localPort: 5173 },
        'POST',
      ),
      policy,
      'studio-api',
    );
    expect(workspaceDecision.ok).toBe(false);
    if (!workspaceDecision.ok) expect(workspaceDecision.status).toBe(403);
  });
});
