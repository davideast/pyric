/**
 * Unit tests for empty-header fail-closed guards, cross-scheme loopback origin
 * enforcement, `isSameOrigin`, `isAllowedUpgrade` scheme propagation, and
 * namespace guard empty-Origin handling.
 */
import { describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isAllowedHost,
  isAllowedLoopbackRequest,
  isAllowedOrigin,
  isAllowedOriginOnPorts,
  isAllowedUpgrade,
  isForeignFetchSite,
  isSameOrigin,
} from '../../src/serve/loopback-guard.js';
import {
  canBootstrapSdkSession,
  guardAvatarLoopback,
  guardLoopback,
  guardSdkRequest,
} from '../../src/serve/namespace-guards.js';

function createMockResponse(): {
  res: ServerResponse;
  statusCode: () => number;
  body: () => string;
} {
  let code = 200;
  let output = '';
  const res = {
    writeHead(status: number) {
      code = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) output += chunk;
      return res;
    },
  } as unknown as ServerResponse;
  return {
    res,
    statusCode: () => code,
    body: () => output,
  };
}

function httpReq(
  headers: Record<string, string | undefined>,
  opts: { localPort?: number; encrypted?: boolean; remoteAddress?: string } = {},
): IncomingMessage {
  const cleanHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) cleanHeaders[key] = value;
  }
  return {
    headers: cleanHeaders,
    socket: {
      localPort: opts.localPort ?? 3473,
      encrypted: opts.encrypted ?? false,
      remoteAddress: opts.remoteAddress ?? '127.0.0.1',
    },
  } as unknown as IncomingMessage;
}

describe('empty Host/Origin fail-closed and cross-scheme loopback guards', () => {
  it('fails closed on empty or whitespace Host and Origin while keeping omitted headers allowed', () => {
    expect(isAllowedHost(undefined, 'localhost')).toBe(true);
    expect(isAllowedHost('', 'localhost')).toBe(false);
    expect(isAllowedHost('   ', 'localhost')).toBe(false);

    expect(isAllowedOrigin(undefined, 'localhost', [], 3473, 'http:')).toBe(true);
    expect(isAllowedOrigin('', 'localhost', [], 3473, 'http:')).toBe(false);
    expect(isAllowedOrigin('   ', 'localhost', [], 3473, 'http:')).toBe(false);

    expect(isAllowedOriginOnPorts(undefined, 'localhost', [], [3473], 'http:')).toBe(true);
    expect(isAllowedOriginOnPorts('', 'localhost', [], [3473], 'http:')).toBe(false);
    expect(isAllowedOriginOnPorts('   ', 'localhost', [], [3473], 'http:')).toBe(false);
  });

  it('rejects cross-scheme loopback origins on HTTP and HTTPS listeners', () => {
    expect(isAllowedOrigin('http://127.0.0.1:3473', '127.0.0.1', [], 3473, 'http:')).toBe(true);
    expect(isAllowedOrigin('https://127.0.0.1:3473', '127.0.0.1', [], 3473, 'http:')).toBe(false);
    expect(isAllowedOrigin('https://localhost:3473', 'localhost', [], 3473, 'http:')).toBe(false);
    expect(isAllowedOrigin('https://[::1]:3473', 'localhost', [], 3473, 'http:')).toBe(false);

    expect(isAllowedOrigin('https://127.0.0.1:8443', '127.0.0.1', [], 8443, 'https:')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8443', '127.0.0.1', [], 8443, 'https:')).toBe(false);

    expect(
      isAllowedLoopbackRequest(
        httpReq({ host: '127.0.0.1:3473', origin: '' }),
        '127.0.0.1',
        [],
        [3473],
      ),
    ).toBe(false);
    expect(
      isAllowedLoopbackRequest(
        httpReq({ host: '127.0.0.1:3473', origin: 'https://127.0.0.1:3473' }),
        '127.0.0.1',
        [],
        [3473],
      ),
    ).toBe(false);
  });

  it('enforces strict serialization and listener scheme in isSameOrigin while preserving default-port TLS tunnels', () => {
    expect(isSameOrigin(undefined, 'dev.tunnel.example', 'localhost', 'http:')).toBe(true);
    expect(isSameOrigin('https://dev.tunnel.example', 'dev.tunnel.example', 'localhost', 'http:')).toBe(true);
    expect(isSameOrigin('http://localhost:5173', 'localhost:5173', 'localhost', 'http:')).toBe(true);
    expect(isSameOrigin('http://127.0.0.1:5173', '127.0.0.1:5173', 'localhost', 'http:')).toBe(true);
    expect(isSameOrigin('http://[::1]:5173', '[::1]:5173', 'localhost', 'http:')).toBe(true);
    expect(isSameOrigin('https://127.0.0.1:8443', '127.0.0.1:8443', 'localhost', 'https:')).toBe(true);

    // Fail closed on empty, malformed, userinfo, path, wildcard, mismatched host/port, and cross-scheme.
    expect(isSameOrigin('', 'localhost:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('   ', 'localhost:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('http://localhost:5173', undefined, 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('https://127.0.0.1:5173', '127.0.0.1:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('https://localhost:5173', 'localhost:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('https://[::1]:5173', '[::1]:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('https://dev.tunnel.example:5173', 'dev.tunnel.example:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('http://dev.tunnel.example', 'dev.tunnel.example', 'localhost', 'https:')).toBe(false);
    expect(isSameOrigin('http://attacker.example@localhost:5173', 'localhost:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('http://localhost:5173/path', 'localhost:5173', 'localhost', 'http:')).toBe(false);
    expect(isSameOrigin('http://0.0.0.0:5173', '0.0.0.0:5173', '0.0.0.0', 'http:')).toBe(false);
    expect(isSameOrigin('https://attacker.example', 'dev.tunnel.example', 'localhost', 'http:')).toBe(false);
  });

  it('propagates expectedScheme through isAllowedUpgrade and isForeignFetchSite', () => {
    expect(
      isAllowedUpgrade(
        { host: '127.0.0.1:3473', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-site' },
        '127.0.0.1',
        [],
        [3473, 3000],
        'http:',
      ),
    ).toBe(true);

    expect(
      isAllowedUpgrade(
        { host: '127.0.0.1:3473', origin: 'https://127.0.0.1:3000', 'sec-fetch-site': 'same-site' },
        '127.0.0.1',
        [],
        [3473, 3000],
        'http:',
      ),
    ).toBe(false);

    expect(
      isAllowedUpgrade(
        { host: '127.0.0.1:3473', origin: '' },
        '127.0.0.1',
        [],
        [3473],
        'http:',
      ),
    ).toBe(false);

    expect(
      isForeignFetchSite(
        { headers: { origin: 'https://127.0.0.1:3000', 'sec-fetch-site': 'same-site' } },
        '127.0.0.1',
        [3473, 3000],
        'http:',
      ),
    ).toBe(true);
  });

  it('rejects empty Origin and cross-scheme loopback Origin across all namespace guards', () => {
    const opts = { boundHost: '127.0.0.1', allowedHosts: ['dev.tunnel.example'] };
    const vectors = [
      { host: '127.0.0.1:3473', origin: '' },
      { host: '127.0.0.1:3473', origin: '   ' },
      { host: '127.0.0.1:3473', origin: 'https://127.0.0.1:3473' },
    ];

    for (const headers of vectors) {
      const avatarRes = createMockResponse();
      expect(guardAvatarLoopback(httpReq(headers), avatarRes.res, opts)).toBe(false);
      expect(avatarRes.statusCode()).toBe(403);

      const sdkRes = createMockResponse();
      expect(guardSdkRequest(httpReq(headers), sdkRes.res, opts)).toBe(false);
      expect(sdkRes.statusCode()).toBe(403);

      expect(
        canBootstrapSdkSession(
          httpReq({ ...headers, 'sec-fetch-site': 'same-origin' }),
          opts,
        ),
      ).toBe(false);

      const loopbackRes = createMockResponse();
      expect(guardLoopback(httpReq(headers), loopbackRes.res, opts, true)).toBe(false);
      expect(loopbackRes.statusCode()).toBe(403);
    }
  });
});
