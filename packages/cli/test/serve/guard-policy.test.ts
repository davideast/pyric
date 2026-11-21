import { describe, expect, it } from 'bun:test';
import type { ServerResponse } from 'node:http';
import { ServeAuthHelper } from '../../src/serve/entries/auth-helper-core.js';
import {
  createGuardPolicy,
  effectiveForwardedHost,
  effectiveRequestScheme,
  evaluateGuard,
  isAdmittedPeer,
  isLoopbackHostHeader,
  isTrustedProxyPeer,
  parseAllowedHostEntry,
  parseAllowedHostsStrict,
  type GuardRejectionReason,
  type GuardRequest,
  type RemoteAccessOptions,
} from '../../src/serve/guard-policy.js';
import {
  appendSetCookieHeader,
  formatSessionCookie,
  isAllowedHost,
  isAllowedOrigin,
} from '../../src/serve/loopback-guard.js';
import {
  isLoopbackAddress,
  isWildcardIpAddress,
  matchesAnyCidr,
  matchesCidr,
  parseCidr,
} from '../../src/serve/peer.js';

function fakeRes(encrypted = false, localPort = 5173): {
  res: ServerResponse;
  headers: Map<string, string | string[]>;
} {
  const headers = new Map<string, string | string[]>();
  const res = {
    socket: { encrypted, localPort },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    setHeader: (name: string, value: string | string[]) => {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as ServerResponse;
  return { res, headers };
}

describe('peer.ts IP/CIDR normalization and matching', () => {
  it('handles loopback IPv4, IPv6, and dual-stack ::ffff: variants', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.255.255.254')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:7f00:1')).toBe(true);
    expect(isLoopbackAddress('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);

    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
    expect(isLoopbackAddress('::ffff:0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('::ffff:0:0')).toBe(false);
    expect(isLoopbackAddress('127.256.999.999')).toBe(false);
    expect(isLoopbackAddress('100.64.0.1')).toBe(false);
    expect(isLoopbackAddress('[::1]')).toBe(false);

    expect(isWildcardIpAddress('0.0.0.0')).toBe(true);
    expect(isWildcardIpAddress('::')).toBe(true);
    expect(isWildcardIpAddress('::ffff:0.0.0.0')).toBe(true);
    expect(isWildcardIpAddress('::ffff:0:0')).toBe(true);
    expect(isWildcardIpAddress('127.0.0.1')).toBe(false);
  });

  it('parses IPv4, IPv6, and IPv4-mapped IPv6 CIDRs and rejects wildcards', () => {
    const cgnat = parseCidr('100.64.0.0/10');
    expect(cgnat).not.toBeNull();
    if (cgnat === null) throw new Error('expected valid CIDR');
    expect(matchesCidr('100.64.0.1', cgnat)).toBe(true);
    expect(matchesCidr('100.127.255.254', cgnat)).toBe(true);
    expect(matchesCidr('::ffff:100.80.1.5', cgnat)).toBe(true);
    expect(matchesCidr('::ffff:6450:0105', cgnat)).toBe(true);
    expect(matchesCidr('100.128.0.1', cgnat)).toBe(false);
    expect(matchesCidr('100.63.255.255', cgnat)).toBe(false);
    expect(matchesCidr('127.0.0.1', cgnat)).toBe(false);

    const mapped = parseCidr('::ffff:100.64.0.0/106');
    expect(mapped).not.toBeNull();
    if (mapped === null) throw new Error('expected valid mapped CIDR');
    expect(mapped.family).toBe(4);
    expect(mapped.prefixLength).toBe(10);
    expect(matchesCidr('100.80.1.5', mapped)).toBe(true);

    const v6 = parseCidr('fd7a::/16');
    expect(v6).not.toBeNull();
    if (v6 === null) throw new Error('expected valid v6 CIDR');
    expect(matchesCidr('fd7a:115c:a1e0::1', v6)).toBe(true);
    expect(matchesCidr('fd7a::1%eth0', v6)).toBe(true);
    expect(matchesCidr('fd7b::1', v6)).toBe(false);
    expect(matchesAnyCidr('::ffff:100.80.1.5', [cgnat, v6])).toBe(true);

    for (const invalid of [
      '',
      '*',
      '0.0.0.0',
      '::',
      '::ffff:0.0.0.0',
      '::ffff:0:0',
      '0.0.0.0/0',
      '::/0',
      '::ffff:0:0/96',
      '10.0.0.1/33',
      '10.0.0.1/-1',
      '010.0.0.1',
      '10.0.0.256',
      'fd7a::/129',
      'fe80::1%eth0',
      'not-an-ip',
      '10.0.0.1/8/8',
    ]) {
      expect(parseCidr(invalid), invalid).toBeNull();
    }
  });
});

describe('host-pattern strict Vite-aligned leading-dot suffix rules', () => {
  it('accepts valid exact hosts and leading-dot suffixes with >= 2 labels', () => {
    expect(parseAllowedHostEntry('devbox.example.com')).toEqual({
      kind: 'exact',
      hostname: 'devbox.example.com',
      port: undefined,
      raw: 'devbox.example.com',
    });
    expect(parseAllowedHostEntry('devbox.example.com:8443')).toEqual({
      kind: 'exact',
      hostname: 'devbox.example.com',
      port: 8443,
      raw: 'devbox.example.com:8443',
    });
    expect(parseAllowedHostEntry('[fd7a::1]:5173')).toEqual({
      kind: 'exact',
      hostname: 'fd7a::1',
      port: 5173,
      raw: '[fd7a::1]:5173',
    });
    expect(parseAllowedHostEntry('.tailnet.ts.net')).toEqual({
      kind: 'suffix',
      suffix: 'tailnet.ts.net',
      port: undefined,
      raw: '.tailnet.ts.net',
    });
    expect(parseAllowedHostEntry('.devbox.internal:8443')).toEqual({
      kind: 'suffix',
      suffix: 'devbox.internal',
      port: 8443,
      raw: '.devbox.internal:8443',
    });
  });

  it('rejects wildcards, true, single-label suffixes, wildcard IPs, and invalid inputs', () => {
    for (const invalid of [
      '',
      ' ',
      '*',
      'true',
      'TRUE',
      '*.example.com',
      'box.*.example.com',
      '.',
      '..',
      '.com',
      '.dev',
      '.local',
      '.internal',
      '.localhost',
      '..tailnet.ts.net',
      '.tailnet..ts.net',
      '.0.0.1',
      '.127.0.0.1',
      '0',
      '0.0.0.0',
      '0.0.0.0:5173',
      '::',
      '[::]',
      '[::]:5173',
      '::ffff:0:0',
      '::ffff:0.0.0.0',
      'user@example.com',
      'example.com/path',
      'devbox.example.com:0',
      'devbox.example.com:99999',
      '.tailnet.ts.net:0',
    ]) {
      expect(parseAllowedHostEntry(invalid), invalid).toBeNull();
    }
    expect(() => parseAllowedHostsStrict([true])).toThrow();
    expect(() => parseAllowedHostsStrict(['.com'])).toThrow('at least two valid DNS labels');
    expect(() => parseAllowedHostsStrict(['*.example.com'])).toThrow("cannot use '*' wildcards");
  });

  it('enforces leading-dot boundary and port matching inside isAllowedHost and isAllowedOrigin', () => {
    expect(isAllowedHost('box.tailnet.ts.net', '127.0.0.1', ['.tailnet.ts.net'])).toBe(true);
    expect(isAllowedHost('sub.box.tailnet.ts.net:5173', '127.0.0.1', ['.tailnet.ts.net'])).toBe(true);
    expect(isAllowedHost('tailnet.ts.net', '127.0.0.1', ['.tailnet.ts.net'])).toBe(false);
    expect(isAllowedHost('eviltailnet.ts.net', '127.0.0.1', ['.tailnet.ts.net'])).toBe(false);
    expect(isAllowedHost('evil.example', '127.0.0.1', ['.tailnet.ts.net'])).toBe(false);
    expect(isAllowedHost('-bad.tailnet.ts.net', '127.0.0.1', ['.tailnet.ts.net'])).toBe(false);

    expect(isAllowedHost('box.tailnet.ts.net:8443', '127.0.0.1', ['.tailnet.ts.net:8443'])).toBe(true);
    expect(isAllowedHost('box.tailnet.ts.net:5173', '127.0.0.1', ['.tailnet.ts.net:8443'])).toBe(false);
    expect(isAllowedHost('box.tailnet.ts.net', '127.0.0.1', ['.tailnet.ts.net:8443'])).toBe(false);

    expect(
      isAllowedOrigin('https://box.tailnet.ts.net:8443', '127.0.0.1', ['.tailnet.ts.net:8443'], 5173, 'http:'),
    ).toBe(true);
    expect(
      isAllowedOrigin('https://box.tailnet.ts.net:9999', '127.0.0.1', ['.tailnet.ts.net:8443'], 5173, 'http:'),
    ).toBe(false);
    expect(
      isAllowedOrigin('https://tailnet.ts.net', '127.0.0.1', ['.tailnet.ts.net'], 5173, 'http:'),
    ).toBe(false);
  });
});

describe('effectiveRequestScheme and trustProxy spoofing defense', () => {
  it('ignores X-Forwarded-Proto and X-Forwarded-Host from untrusted or remote-marked peers', () => {
    const loopbackReq: GuardRequest = {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'devbox.example.com:8443' },
      socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
    };
    expect(isTrustedProxyPeer(loopbackReq, false)).toBe(false);
    expect(effectiveRequestScheme(loopbackReq, false)).toBe('http:');
    expect(effectiveForwardedHost(loopbackReq, false)).toBeUndefined();

    expect(isTrustedProxyPeer(loopbackReq, 'loopback')).toBe(true);
    expect(effectiveRequestScheme(loopbackReq, 'loopback')).toBe('https:');
    expect(effectiveForwardedHost(loopbackReq, 'loopback')).toBe('devbox.example.com:8443');

    const remotePeerReq: GuardRequest = {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost:5173' },
      socket: { remoteAddress: '203.0.113.5', localPort: 5173, encrypted: false },
    };
    expect(isTrustedProxyPeer(remotePeerReq, 'loopback')).toBe(false);
    expect(effectiveRequestScheme(remotePeerReq, 'loopback')).toBe('http:');
    expect(effectiveForwardedHost(remotePeerReq, 'loopback')).toBeUndefined();

    const markedRemoteReq: GuardRequest = {
      headers: {
        'x-pyric-remote-peer': '1',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'localhost:5173',
      },
      socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
    };
    expect(isTrustedProxyPeer(markedRemoteReq, 'loopback')).toBe(false);
    expect(effectiveRequestScheme(markedRemoteReq, 'loopback')).toBe('http:');

    // Trailing hop wins so a client cannot prepend 'https' ahead of a local HTTP hop.
    const chainedReq: GuardRequest = {
      headers: { 'x-forwarded-proto': 'https, http' },
      socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
    };
    expect(effectiveRequestScheme(chainedReq, 'loopback')).toBe('http:');

    // Native TLS listener cannot be downgraded by X-Forwarded-Proto: http.
    const tlsReq: GuardRequest = {
      headers: { 'x-forwarded-proto': 'http' },
      socket: { remoteAddress: '127.0.0.1', localPort: 8443, encrypted: true },
    };
    expect(effectiveRequestScheme(tlsReq, 'loopback')).toBe('https:');

    // CIDR-based proxy trust handles IPv4-mapped IPv6 dual-stack sockets.
    const proxyCidr = parseCidr('10.0.0.0/24');
    if (proxyCidr === null) throw new Error('expected valid proxy CIDR');
    const inCidrReq: GuardRequest = {
      headers: { 'x-forwarded-proto': 'https' },
      socket: { remoteAddress: '::ffff:10.0.0.7', localPort: 5173, encrypted: false },
    };
    expect(effectiveRequestScheme(inCidrReq, [proxyCidr])).toBe('https:');
    const outCidrReq: GuardRequest = {
      headers: { 'x-forwarded-proto': 'https' },
      socket: { remoteAddress: '10.0.1.7', localPort: 5173, encrypted: false },
    };
    expect(effectiveRequestScheme(outCidrReq, [proxyCidr])).toBe('http:');
  });

  it('adds ; Secure to session cookies behind trusted proxied HTTPS and omits it on plain HTTP', () => {
    const cookie = formatSessionCookie('secret-token', { port: 5173 });
    const httpFake = fakeRes(false, 5173);
    appendSetCookieHeader(httpFake.res, cookie, { effectiveScheme: 'http:' });
    expect(String(httpFake.headers.get('set-cookie'))).not.toContain('Secure');

    const proxiedHttpsFake = fakeRes(false, 5173);
    appendSetCookieHeader(proxiedHttpsFake.res, cookie, { effectiveScheme: 'https:' });
    expect(String(proxiedHttpsFake.headers.get('set-cookie'))).toContain('; Secure');
  });
});

describe('evaluateGuard unified contract', () => {
  const secretToken = 'guard-test-secret-0123456789abcdef';

  it('keeps default localhost zero-config requests completely unchanged', () => {
    const policy = createGuardPolicy({
      boundHost: '127.0.0.1',
      boundPort: 5173,
      allowedHosts: ['devbox.example.com'],
    });
    expect(isLoopbackHostHeader('localhost:5173')).toBe(true);
    expect(isLoopbackHostHeader('devbox.example.com:5173')).toBe(false);

    const localReq: GuardRequest = {
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
      socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
    };
    expect(evaluateGuard(localReq, policy, 'namespace')).toEqual({
      ok: true,
      effectiveScheme: 'http:',
      isRemoteHost: false,
      isRemotePeer: false,
      isRemoteRequest: false,
      authenticated: false,
    });

    // Without remoteAccess or sessionToken, extra allowedHosts STILL fail with 403.
    const extraHostUnauth: GuardRequest = {
      headers: { host: 'devbox.example.com:5173' },
      socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
    };
    const denied = evaluateGuard(extraHostUnauth, policy, 'namespace');
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(403);
      expect(denied.reason).toBe('disallowed-host');
    }
  });

  it('requires session token on remote hostnames and returns structured unlock / invalid errors', () => {
    const options: RemoteAccessOptions = {
      allowedHosts: ['.tailnet.ts.net'],
      trustProxy: 'loopback',
    };
    const policy = createGuardPolicy({
      boundHost: '127.0.0.1',
      boundPort: 5173,
      allowedHosts: options.allowedHosts,
      remoteAccessEnabled: true,
      trustProxy: options.trustProxy,
      sessionToken: secretToken,
    });

    const missingToken = evaluateGuard(
      {
        headers: { host: 'box.tailnet.ts.net:5173' },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'init',
    );
    expect(missingToken.ok).toBe(false);
    if (!missingToken.ok) {
      expect(missingToken.status).toBe(401);
      const reason: GuardRejectionReason = missingToken.reason;
      expect(reason).toBe('missing-session-token');
      expect(missingToken.unlockRequired).toBe(true);
      expect(missingToken.message).not.toContain(secretToken);
    }

    const wrongToken = evaluateGuard(
      {
        headers: { host: 'box.tailnet.ts.net:5173', 'x-pyric-session-token': 'wrong' },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'init',
    );
    expect(wrongToken.ok).toBe(false);
    if (!wrongToken.ok) {
      expect(wrongToken.status).toBe(401);
      expect(wrongToken.reason).toBe('invalid-session-token');
      expect(wrongToken.unlockRequired).toBe(false);
    }

    // Authenticated TLS proxy request on non-default external port passes.
    const tlsProxyOk = evaluateGuard(
      {
        headers: {
          host: 'box.tailnet.ts.net:8443',
          origin: 'https://box.tailnet.ts.net:8443',
          'x-forwarded-proto': 'https',
          cookie: `__pyric_session_5173=${secretToken}`,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'bridge-ws',
    );
    expect(tlsProxyOk).toEqual({
      ok: true,
      effectiveScheme: 'https:',
      isRemoteHost: true,
      isRemotePeer: false,
      isRemoteRequest: true,
      authenticated: true,
    });

    // Cross-port origin through same proxy is rejected.
    const wrongPort = evaluateGuard(
      {
        headers: {
          host: 'box.tailnet.ts.net:8443',
          origin: 'https://box.tailnet.ts.net:9999',
          'x-forwarded-proto': 'https',
          cookie: `__pyric_session_5173=${secretToken}`,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'bridge-ws',
    );
    expect(wrongPort.ok).toBe(false);
    if (!wrongPort.ok) {
      expect(wrongPort.status).toBe(403);
      expect(wrongPort.reason).toBe('origin-mismatch');
    }

    // Downgraded http:// Origin when proxy reports https is rejected as scheme-mismatch.
    const downgraded = evaluateGuard(
      {
        headers: {
          host: 'box.tailnet.ts.net:8443',
          origin: 'http://box.tailnet.ts.net:8443',
          'x-forwarded-proto': 'https',
          cookie: `__pyric_session_5173=${secretToken}`,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'bridge-ws',
    );
    expect(downgraded.ok).toBe(false);
    if (!downgraded.ok) {
      expect(downgraded.status).toBe(403);
      expect(downgraded.reason).toBe('scheme-mismatch');
    }
  });

  it('enforces CIDR allowPeers and separates pyric live behind allowLiveRemotePeers', () => {
    const cidrPolicy = createGuardPolicy({
      boundHost: '0.0.0.0',
      boundPort: 5173,
      allowedHosts: ['devbox.example.com'],
      allowPeers: ['100.64.0.0/10'],
      remoteAccessEnabled: true,
      sessionToken: secretToken,
    });
    expect(isAdmittedPeer({ socket: { remoteAddress: '::ffff:100.80.1.5' } }, cidrPolicy)).toBe(true);
    expect(isAdmittedPeer({ socket: { remoteAddress: '203.0.113.5' } }, cidrPolicy)).toBe(false);
    expect(
      isAdmittedPeer(
        {
          headers: { 'x-pyric-remote-peer': '1' },
          socket: { remoteAddress: '127.0.0.1' },
        },
        cidrPolicy,
      ),
    ).toBe(false);

    const liveRefused = evaluateGuard(
      {
        headers: { host: 'devbox.example.com:5173', 'x-pyric-session-token': secretToken },
        socket: { remoteAddress: '100.80.1.5', localPort: 5173, encrypted: false },
      },
      cidrPolicy,
      'bridge-live',
    );
    expect(liveRefused.ok).toBe(false);
    if (!liveRefused.ok) {
      expect(liveRefused.status).toBe(403);
      expect(liveRefused.reason).toBe('live-remote-peer-refused');
    }

    const liveAllowedPolicy = createGuardPolicy({
      boundHost: '0.0.0.0',
      boundPort: 5173,
      allowedHosts: ['devbox.example.com'],
      allowPeers: ['100.64.0.0/10'],
      remoteAccessEnabled: true,
      allowLiveRemotePeers: true,
      sessionToken: secretToken,
    });
    expect(
      evaluateGuard(
        {
          headers: { host: 'devbox.example.com:5173', 'x-pyric-session-token': secretToken },
          socket: { remoteAddress: '::ffff:100.80.1.5', localPort: 5173, encrypted: false },
        },
        liveAllowedPolicy,
        'bridge-live',
      ).ok,
    ).toBe(true);
  });

  it('reports scheme-mismatch guidance without trustProxy and sanitizes header values in errors', () => {
    const policy = createGuardPolicy({
      boundHost: '127.0.0.1',
      boundPort: 5173,
      allowedHosts: ['devbox.example.com'],
      remoteAccessEnabled: true,
      sessionToken: secretToken,
    });

    const mismatch = evaluateGuard(
      {
        headers: {
          host: 'devbox.example.com:5173',
          origin: 'https://devbox.example.com:5173',
          'x-pyric-session-token': secretToken,
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'namespace',
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.reason).toBe('scheme-mismatch');
      expect(mismatch.message).toContain('--trust-proxy=loopback');
    }

    const injectedHost = evaluateGuard(
      {
        headers: { host: 'evil.example\r\nX-Injected: yes' },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'namespace',
    );
    expect(injectedHost.ok).toBe(false);
    if (!injectedHost.ok) {
      expect(injectedHost.message).not.toContain('\r');
      expect(injectedHost.message).not.toContain('\n');
    }
  });
});

describe('entries/auth-helper-core non-secure context fallback', () => {
  it('mints provider UIDs without crypto.randomUUID', async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => realCrypto.getRandomValues(arr),
        randomUUID: undefined,
      },
      configurable: true,
      writable: true,
    });
    try {
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
      helper.add({ email: 'dev@example.com', displayName: 'Dev' });
      const cred = await pending;
      expect(cred.user.uid).toMatch(/^provider-[0-9a-f-]{36}$/);
      expect(added).toHaveLength(1);
    } finally {
      if (desc !== undefined) {
        Object.defineProperty(globalThis, 'crypto', desc);
      }
    }
  });
});
