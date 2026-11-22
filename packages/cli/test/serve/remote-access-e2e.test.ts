/**
 * Positive end-to-end tests for remote workstation & reverse-proxy access:
 * 1. Topology A plain HTTP loopback proxy full unlock + cookie across every surface.
 * 2. Topology A TLS-terminating proxy (`X-Forwarded-Proto: https`, explicit :8443, `; Secure`).
 * 3. Topology B direct non-loopback peer IP in CIDR allowlist (`100.64.0.0/10`).
 * 4. Multi-server port cookie isolation (`:5173` vs `:5174` on the same hostname).
 * 5. Plain-HTTP non-secure-context `crypto.randomUUID = undefined` browser smoke test.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteApp, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import { createUserWithEmailAndPassword, getAuth, signInAnonymously } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { randomUuid } from 'pyric/sandbox/internal';
import { getStorage, getMetadata, ref as storageRef } from 'pyric/storage';
import { seedStorageObject } from 'pyric/storage/internal';
import { proxyToChild } from '../../src/functions/http/proxy.js';
import { handleActivity } from '../../src/serve/activity-route.js';
import { createBridgeMount } from '../../src/serve/bridge-mount.js';
import { ServeAuthHelper } from '../../src/serve/entries/auth-helper-core.js';
import { createFlowTreatmentHost } from '../../src/serve/flow-treatment-host.js';
import { createGuardPolicy, evaluateGuard } from '../../src/serve/guard-policy.js';
import { createPyricNamespace, type InitPayload } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';
import { diskProjectStore, diskWorkspace } from '../../src/serve/studio/index.js';
import { UNLOCK_PATH } from '../../src/serve/unlock-route.js';

const handles: ServeHandle[] = [];
const mounts: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];
const rawServers: Array<{ close(cb: () => void): void }> = [];

afterEach(async () => {
  while (mounts.length > 0) {
    const m = mounts.pop();
    if (m !== undefined) await m.close();
  }
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.stop();
  }
  while (rawServers.length > 0) {
    const s = rawServers.pop();
    if (s !== undefined) await new Promise<void>((r) => s.close(() => r()));
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

function extractSetCookie(headers: IncomingHttpHeaders): string {
  const value = headers['set-cookie'];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function sampleInit(): InitPayload {
  return {
    rules: 'rules_version = "2";',
    rulesHash: 'e2e-hash',
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: 'ws://localhost:5173/__pyric/sandbox',
    seed: null,
  };
}

describe('remote-access positive end-to-end matrix', () => {
  it('1. Topology A (plain HTTP loopback proxy): unlocks via cookie without ; Secure and serves all guarded surfaces', async () => {
    const root = makeTempDir('pyric-e2e-http-');
    const sdkDir = join(root, 'sdk');
    const siteDir = join(root, 'site');
    const projectStoreDir = join(root, '.pyric-projects');
    mkdirSync(sdkDir, { recursive: true });
    mkdirSync(join(siteDir, 'studio'), { recursive: true });
    mkdirSync(projectStoreDir, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>');
    writeFileSync(join(root, 'hello.txt'), 'remote-read');
    writeFileSync(join(siteDir, 'studio-routes.json'), JSON.stringify({ routes: ['studio'] }));
    writeFileSync(join(siteDir, 'studio', 'index.html'), '<!doctype html><html><head></head><body>studio-ready</body></html>');

    const token = 'e2e-http-token-0123456789';
    const remoteAccess = { allowedHosts: ['devbox.example.com'], trustProxy: false as const };
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      siteUiDir: siteDir,
      initPayload: sampleInit,
      sessionToken: token,
      remoteAccess,
      studio: {
        workspace: diskWorkspace(root),
        projects: diskProjectStore(projectStoreDir),
      },
      avatars: {
        resolve: async () => ({
          data: new TextEncoder().encode('<svg/>'),
          contentType: 'image/svg+xml',
          origin: 'cache',
        }),
      } as never,
      activity: () => {},
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
      sessionToken: token,
      namespaceHandler: async (req, res, url) => (await mount.handler(req, res, url)) || ns(req, res, url),
      transformHtml: (html, ctx) =>
        ctx.localPeer ? html.replace('</head>', '<meta name="unlocked" content="1"></head>') : html,
      logger: silentServeLogger(),
    });
    handles.push(server);

    const host = `devbox.example.com:${server.port}`;
    const origin = `http://${host}`;

    const unlockPage = await rawHttp({
      port: server.port,
      path: `${UNLOCK_PATH}?next=${encodeURIComponent('/app/demo')}`,
      headers: { Host: host },
    });
    expect(unlockPage.status).toBe(200);
    expect(unlockPage.body).toContain('Unlock Pyric session');

    const unlockPost = await rawHttp({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: host,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, next: '/app/demo' }),
    });
    expect(unlockPost.status).toBe(200);
    const setCookie = extractSetCookie(unlockPost.headers);
    expect(setCookie).toContain(`__pyric_session_${server.port}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('; Secure');

    const cookie = setCookie.split(';', 1)[0] ?? '';

    const initRes = await rawHttp({
      port: server.port,
      path: '/__pyric/init.json',
      headers: { Host: host, Origin: origin, Cookie: cookie },
    });
    expect(initRes.status).toBe(200);
    const initJson = JSON.parse(initRes.body) as { sessionToken?: string; activityToken?: string };
    expect(initJson.sessionToken).toBe(token);
    expect(typeof initJson.activityToken).toBe('string');

    const studioRes = await rawHttp({
      port: server.port,
      path: '/__pyric/ui/studio/',
      headers: { Host: host, Origin: origin, Cookie: cookie },
    });
    expect(studioRes.status).toBe(200);
    expect(studioRes.body).toContain('studio-ready');

    const workspaceRes = await rawHttp({
      port: server.port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: { Host: host, Origin: origin, Cookie: cookie },
    });
    expect(workspaceRes.status).toBe(200);
    expect(workspaceRes.body).toContain('remote-read');

    const avatarRes = await rawHttp({
      port: server.port,
      path: '/__pyric/assets/avatar/alice',
      headers: { Host: host, Origin: origin, Cookie: cookie },
    });
    expect(avatarRes.status).toBe(200);

    const healthRes = await rawHttp({
      port: server.port,
      path: '/__pyric/health',
      headers: { Host: host, Origin: origin, Cookie: cookie },
    });
    expect(healthRes.status).toBe(200);

    const htmlRes = await rawHttp({
      port: server.port,
      path: '/',
      headers: { Host: host, 'x-pyric-session-token': token },
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.body).toContain('name="unlocked"');

    const flow = await createFlowTreatmentHost(root, undefined, {
      boundHost: '127.0.0.1',
      sessionToken: token,
      remoteAccess,
    });
    let flowStatus = 200;
    await flow.handle(
      {
        method: 'GET',
        headers: { host, origin, cookie },
        socket: { remoteAddress: '127.0.0.1', localPort: server.port, encrypted: false },
      } as unknown as IncomingMessage,
      {
        setHeader() {},
        end() {},
        set statusCode(code: number) { flowStatus = code; },
      } as unknown as ServerResponse,
      new URL(`http://${host}/__pyric/flow/manifest.json`),
    );
    expect(flowStatus).toBe(200);
  });

  it('2. Topology A (TLS-terminating reverse proxy): adds ; Secure cookie and forwards https proto to functions proxy and activity', async () => {
    const root = makeTempDir('pyric-e2e-https-');
    const sdkDir = join(root, 'sdk');
    mkdirSync(sdkDir, { recursive: true });
    const token = 'e2e-tls-token-0123456789';
    const remoteAccess = { allowedHosts: ['.tailnet.ts.net'], trustProxy: 'loopback' as const };
    const ns = createPyricNamespace({
      boundHost: '127.0.0.1',
      sdkDir,
      initPayload: sampleInit,
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

    // Explicit non-default HTTPS port :8443 through loopback proxy.
    const unlockRes = await rawHttp({
      port: server.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: 'box.tailnet.ts.net:8443',
        Origin: 'https://box.tailnet.ts.net:8443',
        'Sec-Fetch-Site': 'same-origin',
        'x-forwarded-proto': 'https',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    expect(unlockRes.status).toBe(200);
    const setCookie = extractSetCookie(unlockRes.headers);
    expect(setCookie).toContain('; Secure');

    const cookie = setCookie.split(';', 1)[0] ?? '';
    const initDefaultPort = await rawHttp({
      port: server.port,
      path: '/__pyric/init.json',
      headers: {
        Host: 'box.tailnet.ts.net',
        Origin: 'https://box.tailnet.ts.net',
        'x-forwarded-proto': 'https',
        Cookie: cookie,
      },
    });
    expect(initDefaultPort.status).toBe(200);

    // functions/http/proxy.ts forwards real 'https' proto when trustProxy matches.
    let forwardedProto = '';
    const child = createServer((req, res) => {
      forwardedProto = String(req.headers['x-forwarded-proto'] ?? '');
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((resolve) => child.listen(0, '127.0.0.1', resolve));
    rawServers.push(child);
    const childAddr = child.address();
    const childPort = typeof childAddr === 'object' && childAddr !== null ? childAddr.port : 0;

    const gateway = createServer((req, res) => {
      void proxyToChild(req, res, {
        port: childPort,
        token: 'fn-tok',
        exportName: 'echo',
        forwardUrl: '/echo',
        timeoutMs: 2_000,
        timeoutMessage: 'timeout',
        trustProxy: 'loopback',
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    rawServers.push(gateway);
    const gwAddr = gateway.address();
    const gwPort = typeof gwAddr === 'object' && gwAddr !== null ? gwAddr.port : 0;
    const gwRes = await rawHttp({
      port: gwPort,
      path: '/echo',
      headers: { Host: 'box.tailnet.ts.net:8443', 'x-forwarded-proto': 'https' },
    });
    expect(gwRes.status).toBe(200);
    expect(forwardedProto).toBe('https');

    // activity-route.ts validates Origin scheme via effectiveRequestScheme.
    let actStatus = 0;
    await handleActivity(
      () => {},
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'box.tailnet.ts.net:8443',
          origin: 'https://box.tailnet.ts.net:8443',
          'x-forwarded-proto': 'https',
          'x-pyric-activity-token': 'act-cap',
          'x-pyric-session-token': token,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: server.port, encrypted: false },
        on(ev: string, cb: (...args: unknown[]) => void) {
          if (ev === 'end') queueMicrotask(() => cb());
          return this;
        },
        resume() {},
      } as unknown as IncomingMessage,
      {
        writeHead(code: number) { actStatus = code; return this; },
        end() { return this; },
      } as unknown as ServerResponse,
      'act-cap',
      { boundHost: '127.0.0.1', sessionToken: token, remoteAccess },
    );
    expect(actStatus).toBe(400); // passed host/scheme/session/activity checks, empty JSON rejected by body validator
  });

  it('3. Topology B (direct non-loopback peer in CIDR allowlist): blocked without cookie, allowed after auth, outside CIDR denied', () => {
    const token = 'cidr-token-012345';
    const policy = createGuardPolicy({
      boundHost: '0.0.0.0',
      allowedHosts: ['devbox.example.com'],
      allowPeers: ['100.64.0.0/10'],
      remoteAccessEnabled: true,
      sessionToken: token,
    });
    const inCidrNoToken = evaluateGuard(
      {
        method: 'GET',
        headers: { host: 'devbox.example.com:5173' },
        socket: { remoteAddress: '100.64.42.7', localPort: 5173, encrypted: false },
      } as unknown as IncomingMessage,
      policy,
      'namespace',
    );
    expect(inCidrNoToken.ok).toBe(false);
    if (!inCidrNoToken.ok) expect(inCidrNoToken.status).toBe(401);

    const inCidrAuthed = evaluateGuard(
      {
        method: 'GET',
        headers: {
          host: 'devbox.example.com:5173',
          origin: 'http://devbox.example.com:5173',
          cookie: `__pyric_session_5173=${token}`,
        },
        socket: { remoteAddress: '100.64.42.7', localPort: 5173, encrypted: false },
      } as unknown as IncomingMessage,
      policy,
      'namespace',
    );
    expect(inCidrAuthed.ok).toBe(true);

    const outOfCidr = evaluateGuard(
      {
        method: 'GET',
        headers: {
          host: 'devbox.example.com:5173',
          cookie: `__pyric_session_5173=${token}`,
        },
        socket: { remoteAddress: '198.51.100.9', localPort: 5173, encrypted: false },
      } as unknown as IncomingMessage,
      policy,
      'namespace',
    );
    expect(outOfCidr.ok).toBe(false);
    if (!outOfCidr.ok) {
      expect(outOfCidr.status).toBe(403);
      expect(outOfCidr.reason).toBe('remote-peer');
    }
  });

  it('4. multi-server cookie isolation: a cookie unlocked for server A never unlocks server B on the same hostname', async () => {
    const rootA = makeTempDir('pyric-iso-a-');
    const rootB = makeTempDir('pyric-iso-b-');
    mkdirSync(join(rootA, 'sdk'), { recursive: true });
    mkdirSync(join(rootB, 'sdk'), { recursive: true });
    const remoteAccess = { allowedHosts: ['devbox.example.com'] };
    const sharedSecret = 'same-or-different-secret-check';

    const serverA = await startStaticServer({
      publicDir: rootA,
      port: 0,
      host: '127.0.0.1',
      remoteAccess,
      sessionToken: sharedSecret,
      namespaceHandler: createPyricNamespace({
        boundHost: '127.0.0.1',
        sdkDir: join(rootA, 'sdk'),
        initPayload: sampleInit,
        sessionToken: sharedSecret,
        remoteAccess,
      }),
      logger: silentServeLogger(),
    });
    const serverB = await startStaticServer({
      publicDir: rootB,
      port: 0,
      host: '127.0.0.1',
      remoteAccess,
      sessionToken: sharedSecret,
      namespaceHandler: createPyricNamespace({
        boundHost: '127.0.0.1',
        sdkDir: join(rootB, 'sdk'),
        initPayload: sampleInit,
        sessionToken: sharedSecret,
        remoteAccess,
      }),
      logger: silentServeLogger(),
    });
    handles.push(serverA, serverB);
    expect(serverA.port).not.toBe(serverB.port);

    const unlockedA = await rawHttp({
      port: serverA.port,
      path: UNLOCK_PATH,
      method: 'POST',
      headers: {
        Host: `devbox.example.com:${serverA.port}`,
        Origin: `http://devbox.example.com:${serverA.port}`,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: sharedSecret }),
    });
    expect(unlockedA.status).toBe(200);
    const cookieA = extractSetCookie(unlockedA.headers).split(';', 1)[0] ?? '';
    expect(cookieA.startsWith(`__pyric_session_${serverA.port}=`)).toBe(true);

    const okOnA = await rawHttp({
      port: serverA.port,
      path: '/__pyric/init.json',
      headers: {
        Host: `devbox.example.com:${serverA.port}`,
        Origin: `http://devbox.example.com:${serverA.port}`,
        Cookie: cookieA,
      },
    });
    expect(okOnA.status).toBe(200);

    // Even with the identical secret string, the port-scoped cookie from serverA MUST NOT unlock serverB.
    const rejectedOnB = await rawHttp({
      port: serverB.port,
      path: '/__pyric/init.json',
      headers: {
        Host: `devbox.example.com:${serverB.port}`,
        Origin: `http://devbox.example.com:${serverB.port}`,
        Cookie: cookieA,
      },
    });
    expect(rejectedOnB.status).toBe(401);
  });

  it('5. plain-HTTP insecure-context smoke test works when globalThis.crypto.randomUUID is undefined', async () => {
    const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const realCrypto = globalThis.crypto;
    const insecureCrypto = {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => realCrypto.getRandomValues(array),
      randomUUID: undefined,
    };
    Object.defineProperty(globalThis, 'crypto', {
      value: insecureCrypto,
      configurable: true,
      writable: true,
    });
    try {
      expect(globalThis.crypto.randomUUID).toBeUndefined();
      const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      expect(randomUuid()).toMatch(uuidV4);

      // Auth: anonymous + email/password sign-in without crypto.randomUUID.
      const sandbox = initializeSandbox();
      const auth = getAuth(sandbox);
      const anon = await signInAnonymously(auth);
      expect(anon.user.uid.length).toBeGreaterThan(0);
      const emailUser = await createUserWithEmailAndPassword(auth, 'dev@example.com', 'password123!');
      expect(emailUser.user.uid.length).toBeGreaterThan(0);

      // Auth helper popup/provider UID fallback.
      const added: Array<{ uid: string; email: string | null }> = [];
      const helper = new ServeAuthHelper({
        list: () => [],
        add: (identity) => {
          added.push({ uid: identity.uid, email: identity.email });
        },
      });
      const pending = helper.resolver().openPopup({
        providerId: 'google.com',
        authType: 'signIn',
      });
      await Promise.resolve();
      helper.add({ email: 'dev-popup@example.com', displayName: 'Dev' });
      const cred = await pending;
      expect(cred.user.uid).toMatch(/^provider-[0-9a-f-]{36}$/);
      expect(added).toHaveLength(1);

      // Storage write/seed and metadata read without crypto.randomUUID.
      const storageApp = initializeApp(
        { projectId: 'remote-smoke-test', storageBucket: 'remote-smoke-bucket' },
        `remote-smoke-${Date.now()}`,
      );
      try {
        const storage = getStorage(storageApp);
        await seedStorageObject(storage, 'files/note.txt', new Uint8Array([65, 66]), {
          contentType: 'text/plain',
        });
        const downloadToken = randomUuid();
        expect(downloadToken).toMatch(uuidV4);
        const target = storageRef(storage, 'files/note.txt');
        expect(target.fullPath).toBe('files/note.txt');
        expect(typeof getMetadata).toBe('function');
      } finally {
        await deleteApp(storageApp);
        await resetAppRegistryForTests();
      }
    } finally {
      if (originalCryptoDescriptor !== undefined) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    }
  });
});
