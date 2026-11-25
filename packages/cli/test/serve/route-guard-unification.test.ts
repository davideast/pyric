import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  IncomingMessage,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityIncident } from 'pyric/firestore/internal';
import {
  handleActivity,
  type ActivityGuardOptions,
} from '../../src/serve/activity-route.js';
import {
  createStudioRoutes,
  diskProjectStore,
  diskWorkspace,
} from '../../src/serve/studio/index.js';
import { createWriterLock } from '../../src/serve/writer-lock.js';

const SECRET_TOKEN = 'm4-hardening-session-token-0123456789';
const ACTIVITY_TOKEN = 'm4-hardening-activity-token-0123456789';
const PROXY_HOST = 'abc123.proxy.example.com';
const PROXY_ORIGIN = `https://${PROXY_HOST}`;

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server === undefined) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
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

async function listenLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { port: address.port };
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

function sampleIncident(): ActivityIncident {
  return {
    fingerprint: 'segment:0|read:get:users/alice',
    pattern: 'repeated-read',
    confidence: 'high',
    severity: 'warning',
    service: 'firestore',
    method: 'get',
    targetFingerprint: 'users/alice',
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    authUid: 'alice',
    count: 5,
    windowMs: 400,
    usage: {
      unit: 'document-reads',
      lowerBound: 5,
      limitations: [
        'Observed sandbox reads are a lower bound; production cache and billing behavior are not measured.',
      ],
    },
    evidenceEventIds: ['read-1', 'read-2'],
    sourceAttribution: 'app',
  };
}

describe('Studio routes unified evaluateGuard & two-hop proxy enforcement', () => {
  it('admits authenticated two-hop proxy requests and rejects spoofed host, downgraded scheme, cross-origin, and missing token', async () => {
    const dir = makeTempDir('pyric-m4-studio-twohop-');
    writeFileSync(join(dir, 'hello.txt'), 'world');
    const routes = createStudioRoutes({
      workspace: diskWorkspace(dir),
      projects: diskProjectStore(join(dir, '.pyric', 'projects')),
      sessionToken: SECRET_TOKEN,
      writerLock: createWriterLock(),
      boundHost: '::',
      remoteAccess: {
        allowedHosts: ['.proxy.example.com'],
        allowPeers: 'any',
        trustProxy: 'loopback',
      },
    });
    const { port } = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      void routes(req, res, url).then((handled) => {
        if (!handled) res.writeHead(404).end('not found');
      });
    });

    const cookie = `__pyric_session_${port}=${SECRET_TOKEN}`;

    const allowedDefaultPort = await rawHttp({
      port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: {
        Host: `localhost:${port}`,
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        Origin: PROXY_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
        Cookie: cookie,
      },
    });
    expect(allowedDefaultPort.status).toBe(200);
    expect(allowedDefaultPort.body).toBe('world');

    const allowedExplicitPort = await rawHttp({
      port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: {
        Host: `localhost:${port}`,
        'x-forwarded-host': `${PROXY_HOST}:8443`,
        'x-forwarded-proto': 'https',
        Origin: `${PROXY_ORIGIN}:8443`,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
        Cookie: cookie,
      },
    });
    expect(allowedExplicitPort.status).toBe(200);

    const evilForwardedHost = await rawHttp({
      port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: {
        Host: `localhost:${port}`,
        'x-forwarded-host': 'evil.example.net',
        'x-forwarded-proto': 'https',
        'x-pyric-remote-peer': '1',
        Cookie: cookie,
      },
    });
    expect(evilForwardedHost.status).toBe(403);
    expect(evilForwardedHost.body).toContain('Forbidden: host not allowed');

    const downgradedOrigin = await rawHttp({
      port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: {
        Host: `localhost:${port}`,
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        Origin: `http://${PROXY_HOST}`,
        'x-pyric-remote-peer': '1',
        Cookie: cookie,
      },
    });
    expect(downgradedOrigin.status).toBe(403);
    expect(downgradedOrigin.body).toContain('Forbidden: origin mismatch');

    const crossHostOrigin = await rawHttp({
      port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: {
        Host: `localhost:${port}`,
        Origin: `http://${PROXY_HOST}:${port}`,
        Cookie: cookie,
      },
    });
    expect(crossHostOrigin.status).toBe(403);

    const unauthenticated = await rawHttp({
      port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: {
        Host: `localhost:${port}`,
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        Origin: PROXY_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
      },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toContain('/__pyric/unlock');

    const crossSite = await rawHttp({
      port,
      path: '/__pyric/workspace?path=hello.txt',
      headers: {
        Host: `localhost:${port}`,
        'sec-fetch-site': 'cross-site',
        Cookie: cookie,
      },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toContain('Forbidden: cross-site request rejected');
  });

  it('fails closed when a real IncomingMessage has a destroyed socket (no remoteAddress)', async () => {
    const dir = makeTempDir('pyric-m4-studio-destroyed-');
    writeFileSync(join(dir, 'hello.txt'), 'world');
    const routes = createStudioRoutes({
      workspace: diskWorkspace(dir),
      sessionToken: SECRET_TOKEN,
      boundHost: '127.0.0.1',
    });

    const destroyedReq = Object.create(IncomingMessage.prototype) as IncomingMessage;
    Object.assign(destroyedReq, {
      method: 'GET',
      headers: { host: '127.0.0.1:3011', 'x-pyric-session-token': SECRET_TOKEN },
      socket: { remoteAddress: undefined, localPort: 3011, destroyed: true },
    });

    let status = 0;
    const mockRes = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return mockRes;
      },
      end() {
        return mockRes;
      },
    } as unknown as ServerResponse;

    await routes(
      destroyedReq,
      mockRes,
      new URL('http://127.0.0.1:3011/__pyric/workspace?path=hello.txt'),
    );
    expect(status).toBe(403);
  });
});

describe('Activity route unified evaluateGuard & two-hop proxy enforcement', () => {
  it('enforces two-hop proxy, Sec-Fetch-Site, default host guard, and fail-closed session token', async () => {
    const received: ActivityIncident[] = [];
    const remoteGuard: ActivityGuardOptions = {
      boundHost: '::',
      sessionToken: SECRET_TOKEN,
      remoteAccess: {
        allowedHosts: ['.proxy.example.com'],
        allowPeers: 'any',
        trustProxy: 'loopback',
      },
    };
    const { port } = await listenLoopback((req, res) => {
      if (req.url === '/no-guard') {
        void handleActivity((inc) => received.push(inc), req, res, ACTIVITY_TOKEN);
        return;
      }
      if (req.url === '/no-token-config') {
        void handleActivity((inc) => received.push(inc), req, res, ACTIVITY_TOKEN, {
          boundHost: '::',
          remoteAccess: {
            allowedHosts: ['.proxy.example.com'],
            allowPeers: 'any',
            trustProxy: 'loopback',
          },
        });
        return;
      }
      void handleActivity((inc) => received.push(inc), req, res, ACTIVITY_TOKEN, remoteGuard);
    });

    const cookie = `__pyric_session_${port}=${SECRET_TOKEN}`;
    const body = JSON.stringify(sampleIncident());

    const twoHopOk = await rawHttp({
      port,
      path: '/__pyric/activity',
      method: 'POST',
      headers: {
        Host: `localhost:${port}`,
        'content-type': 'application/json',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        Origin: PROXY_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
        Cookie: cookie,
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body,
    });
    expect(twoHopOk.status).toBe(204);
    expect(received).toHaveLength(1);

    const evilForwarded = await rawHttp({
      port,
      path: '/__pyric/activity',
      method: 'POST',
      headers: {
        Host: `localhost:${port}`,
        'content-type': 'application/json',
        'x-forwarded-host': 'evil.example.net',
        'x-forwarded-proto': 'https',
        Origin: 'https://evil.example.net',
        'x-pyric-remote-peer': '1',
        Cookie: cookie,
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body,
    });
    expect(evilForwarded.status).toBe(403);

    const downgraded = await rawHttp({
      port,
      path: '/__pyric/activity',
      method: 'POST',
      headers: {
        Host: `localhost:${port}`,
        'content-type': 'application/json',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        Origin: `http://${PROXY_HOST}`,
        'x-pyric-remote-peer': '1',
        Cookie: cookie,
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body,
    });
    expect(downgraded.status).toBe(403);

    const missingToken = await rawHttp({
      port,
      path: '/__pyric/activity',
      method: 'POST',
      headers: {
        Host: `localhost:${port}`,
        'content-type': 'application/json',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        Origin: PROXY_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body,
    });
    expect(missingToken.status).toBe(401);

    const crossSite = await rawHttp({
      port,
      path: '/no-guard',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'cross-site',
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body,
    });
    expect(crossSite.status).toBe(403);

    const badHostNoGuard = await rawHttp({
      port,
      path: '/no-guard',
      method: 'POST',
      headers: {
        Host: `evil.example:${port}`,
        'content-type': 'application/json',
        Origin: `http://evil.example:${port}`,
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body,
    });
    expect(badHostNoGuard.status).toBe(403);

    const noTokenConfig = await rawHttp({
      port,
      path: '/no-token-config',
      method: 'POST',
      headers: {
        Host: `localhost:${port}`,
        'content-type': 'application/json',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        Origin: PROXY_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body,
    });
    expect(noTokenConfig.status).toBe(401);
    expect(received).toHaveLength(1);
  });
});
