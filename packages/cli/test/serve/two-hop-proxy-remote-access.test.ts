import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuardPolicy, evaluateGuard, type GuardRequest } from '../../src/serve/guard-policy.js';
import { createSiteTreeHandler } from '../../src/serve/site-tree.js';
import { createUnlockHandler } from '../../src/serve/unlock-route.js';
import { opaqueProjectKey } from '../../src/serve/project-key.js';

const SECRET_TOKEN = 'two-hop-proxy-session-token-0123456789';
const PROXY_HOST = 'abc123.proxy.example.com';
const PROXY_ORIGIN = `https://${PROXY_HOST}`;

function createMockPostRequest(options: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  remoteAddress?: string;
  localPort?: number;
}): IncomingMessage {
  const emitter = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string; localPort: number; encrypted: boolean };
    resume: () => void;
    [Symbol.asyncIterator]: () => AsyncGenerator<Buffer, void, unknown>;
  };
  emitter.method = options.method;
  emitter.url = options.url;
  emitter.headers = options.headers;
  emitter.socket = {
    remoteAddress: options.remoteAddress ?? '127.0.0.1',
    localPort: options.localPort ?? 3011,
    encrypted: false,
  };
  emitter.resume = () => {};
  const payload = options.body ?? '';
  emitter[Symbol.asyncIterator] = async function* () {
    if (payload.length > 0) {
      yield Buffer.from(payload, 'utf8');
    }
  };
  return emitter as unknown as IncomingMessage;
}

function createMockResponse(localPort = 3011): {
  res: ServerResponse;
  status: () => number;
  headers: Map<string, string | string[]>;
  body: () => string;
} {
  let statusCode = 200;
  let written = '';
  const headers = new Map<string, string | string[]>();
  const res = {
    socket: { localPort, encrypted: false },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(code: number, extra?: Record<string, string | string[]>) {
      statusCode = code;
      if (extra !== undefined) {
        for (const [k, v] of Object.entries(extra)) {
          headers.set(k.toLowerCase(), v);
        }
      }
      return res;
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk === 'string') written += chunk;
      else if (Buffer.isBuffer(chunk)) written += chunk.toString('utf8');
    },
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, headers, body: () => written };
}

describe('two-hop reverse proxy remote access guard', () => {
  const remotePolicy = createGuardPolicy({
    boundHost: '::',
    boundPort: 3011,
    allowedHosts: ['.proxy.example.com'],
    allowPeers: 'any',
    trustProxy: 'loopback',
    remoteAccessEnabled: true,
    sessionToken: SECRET_TOKEN,
  });

  it('requires unlock then admits init and WebSocket over Next.js rewritten loopback hop', () => {
    const baseHeaders = {
      host: 'localhost:3011',
      'x-forwarded-host': PROXY_HOST,
      'x-forwarded-proto': 'https',
      origin: PROXY_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'x-pyric-remote-peer': '1',
    };
    const socket = { remoteAddress: '127.0.0.1', localPort: 3011, encrypted: false };

    const beforeUnlock = evaluateGuard({ headers: baseHeaders, socket }, remotePolicy, 'init');
    expect(beforeUnlock.ok).toBe(false);
    if (!beforeUnlock.ok) {
      expect(beforeUnlock.status).toBe(401);
      expect(beforeUnlock.reason).toBe('missing-session-token');
      expect(beforeUnlock.unlockRequired).toBe(true);
    }

    const withCookieHeaders = {
      ...baseHeaders,
      cookie: `__pyric_session_3011=${SECRET_TOKEN}`,
    };
    const initAllowed = evaluateGuard({ headers: withCookieHeaders, socket }, remotePolicy, 'init');
    expect(initAllowed).toEqual({
      ok: true,
      effectiveScheme: 'https:',
      isRemoteHost: true,
      isRemotePeer: true,
      isRemoteRequest: true,
      authenticated: true,
    });

    const wsAllowed = evaluateGuard({ headers: withCookieHeaders, socket }, remotePolicy, 'bridge-ws');
    expect(wsAllowed).toEqual({
      ok: true,
      effectiveScheme: 'https:',
      isRemoteHost: true,
      isRemotePeer: true,
      isRemoteRequest: true,
      authenticated: true,
    });
  });

  it('fails closed on unconfigured X-Forwarded-Host, wrong Origin, disabled trustProxy, or direct remote spoofing', () => {
    const socket = { remoteAddress: '127.0.0.1', localPort: 3011, encrypted: false };

    const badForwardedHost = evaluateGuard(
      {
        headers: {
          host: 'localhost:3011',
          'x-forwarded-host': 'evil.example.net',
          'x-forwarded-proto': 'https',
          origin: 'https://evil.example.net',
          'x-pyric-remote-peer': '1',
          cookie: `__pyric_session_3011=${SECRET_TOKEN}`,
        },
        socket,
      },
      remotePolicy,
      'init',
    );
    expect(badForwardedHost.ok).toBe(false);
    if (!badForwardedHost.ok) {
      expect(badForwardedHost.status).toBe(403);
      expect(badForwardedHost.reason).toBe('disallowed-host');
    }

    const downgradedOrigin = evaluateGuard(
      {
        headers: {
          host: 'localhost:3011',
          'x-forwarded-host': PROXY_HOST,
          'x-forwarded-proto': 'https',
          origin: `http://${PROXY_HOST}`,
          'x-pyric-remote-peer': '1',
          cookie: `__pyric_session_3011=${SECRET_TOKEN}`,
        },
        socket,
      },
      remotePolicy,
      'init',
    );
    expect(downgradedOrigin.ok).toBe(false);
    if (!downgradedOrigin.ok) {
      expect(downgradedOrigin.status).toBe(403);
      expect(downgradedOrigin.reason).toBe('scheme-mismatch');
    }

    const noTrustPolicy = createGuardPolicy({
      boundHost: '::',
      boundPort: 3011,
      allowedHosts: ['.proxy.example.com'],
      allowPeers: 'any',
      trustProxy: false,
      remoteAccessEnabled: true,
      sessionToken: SECRET_TOKEN,
    });
    const noTrustDecision = evaluateGuard(
      {
        headers: {
          host: 'localhost:3011',
          'x-forwarded-host': PROXY_HOST,
          'x-forwarded-proto': 'https',
          origin: PROXY_ORIGIN,
          'x-pyric-remote-peer': '1',
          cookie: `__pyric_session_3011=${SECRET_TOKEN}`,
        },
        socket,
      },
      noTrustPolicy,
      'init',
    );
    expect(noTrustDecision.ok).toBe(false);
    if (!noTrustDecision.ok) {
      expect(noTrustDecision.status).toBe(403);
      expect(noTrustDecision.reason).toBe('origin-mismatch');
    }

    const directSpoofReq: GuardRequest = {
      headers: {
        host: 'localhost:3011',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        origin: PROXY_ORIGIN,
        cookie: `__pyric_session_3011=${SECRET_TOKEN}`,
      },
      socket: { remoteAddress: '203.0.113.9', localPort: 3011, encrypted: false },
    };
    const directSpoof = evaluateGuard(directSpoofReq, remotePolicy, 'init');
    expect(directSpoof.ok).toBe(false);
    if (!directSpoof.ok) {
      expect(directSpoof.status).toBe(403);
      expect(directSpoof.reason).toBe('origin-mismatch');
    }
  });
});

describe('two-hop reverse proxy unlock and Studio site tree', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pairs and logs out cleanly over rewritten loopback Host with Secure session cookie', async () => {
    const handler = createUnlockHandler({
      boundHost: '::',
      allowedHosts: ['.proxy.example.com'],
      remoteAccess: {
        allowedHosts: ['.proxy.example.com'],
        allowPeers: 'any',
        trustProxy: 'loopback',
      },
      sessionToken: SECRET_TOKEN,
    });

    const unlockReq = createMockPostRequest({
      method: 'POST',
      url: '/__pyric/unlock',
      headers: {
        host: 'localhost:3011',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        origin: PROXY_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: SECRET_TOKEN, next: '/studio' }),
    });
    const unlockRes = createMockResponse(3011);
    await handler(unlockReq, unlockRes.res, new URL('http://localhost:3011/__pyric/unlock'));
    expect(unlockRes.status()).toBe(200);
    expect(JSON.parse(unlockRes.body())).toEqual({ ok: true, next: '/studio' });
    const setCookie = String(unlockRes.headers.get('set-cookie') ?? '');
    expect(setCookie).toContain(`__pyric_session_3011=${SECRET_TOKEN}`);
    expect(setCookie).toContain('; Secure');

    const evilHostReq = createMockPostRequest({
      method: 'POST',
      url: '/__pyric/unlock',
      headers: {
        host: 'localhost:3011',
        'x-forwarded-host': 'unconfigured.example.net',
        'x-forwarded-proto': 'https',
        origin: 'https://unconfigured.example.net',
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: SECRET_TOKEN }),
    });
    const evilRes = createMockResponse(3011);
    await handler(evilHostReq, evilRes.res, new URL('http://localhost:3011/__pyric/unlock'));
    expect(evilRes.status()).toBe(403);

    const logoutReq = createMockPostRequest({
      method: 'POST',
      url: '/__pyric/logout',
      headers: {
        host: 'localhost:3011',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        origin: PROXY_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-pyric-remote-peer': '1',
      },
    });
    const logoutRes = createMockResponse(3011);
    await handler(logoutReq, logoutRes.res, new URL('http://localhost:3011/__pyric/logout'));
    expect(logoutRes.status()).toBe(200);
    expect(String(logoutRes.headers.get('set-cookie') ?? '')).toContain('; Secure');
  });

  it('serves Studio HTML directly without a 301 loop when proxied through a rewriting forwarder', () => {
    const siteRoot = mkdtempSync(join(tmpdir(), 'pyric-two-hop-site-'));
    dirs.push(siteRoot);
    mkdirSync(join(siteRoot, 'studio'), { recursive: true });
    writeFileSync(join(siteRoot, 'studio-routes.json'), JSON.stringify({ routes: ['studio'] }));
    writeFileSync(join(siteRoot, 'index.html'), '<!doctype html><html><head></head><body>root</body></html>');
    writeFileSync(join(siteRoot, 'studio', 'index.html'), '<!doctype html><html><head></head><body>studio</body></html>');

    const rawProject = '/workspace/my-next-app';
    const handler = createSiteTreeHandler(
      siteRoot,
      undefined,
      rawProject,
      SECRET_TOKEN,
      '::',
      undefined,
      ['.proxy.example.com'],
      false,
      {
        allowedHosts: ['.proxy.example.com'],
        allowPeers: 'any',
        trustProxy: 'loopback',
      },
    );

    // Unauthenticated proxied remote Studio load requires unlock (401).
    const unauthReq = createMockPostRequest({
      method: 'GET',
      url: '/__pyric/ui/studio',
      headers: {
        host: 'localhost:3011',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        'x-pyric-remote-peer': '1',
      },
    });
    const unauthRes = createMockResponse(3011);
    handler(unauthReq, unauthRes.res, new URL('http://localhost:3011/__pyric/ui/studio'));
    expect(unauthRes.status()).toBe(401);

    // Authenticated proxied remote Studio load returns 200 HTML directly (no 301 loop) with opaque projectKey.
    const authReq = createMockPostRequest({
      method: 'GET',
      url: '/__pyric/ui/studio',
      headers: {
        host: 'localhost:3011',
        'x-forwarded-host': PROXY_HOST,
        'x-forwarded-proto': 'https',
        'x-pyric-remote-peer': '1',
        cookie: `__pyric_session_3011=${SECRET_TOKEN}`,
      },
    });
    const authRes = createMockResponse(3011);
    handler(authReq, authRes.res, new URL('http://localhost:3011/__pyric/ui/studio'));
    expect(authRes.status()).toBe(200);
    expect(authRes.body()).toContain('studio');
    expect(authRes.body()).toContain(opaqueProjectKey(rawProject));
    expect(authRes.body()).not.toContain(rawProject);
    expect(authRes.body()).not.toContain(SECRET_TOKEN);

    // Local rewriting forwarder (e.g. Next.js on :5181 -> Pyric on :3011) also avoids the 301 loop.
    const localProxiedReq = createMockPostRequest({
      method: 'GET',
      url: '/__pyric/ui/studio',
      headers: {
        host: 'localhost:3011',
        'x-forwarded-host': 'localhost:5181',
      },
    });
    const localProxiedRes = createMockResponse(3011);
    handler(localProxiedReq, localProxiedRes.res, new URL('http://localhost:3011/__pyric/ui/studio'));
    expect(localProxiedRes.status()).toBe(200);
    expect(localProxiedRes.body()).toContain('studio');
  });
});
