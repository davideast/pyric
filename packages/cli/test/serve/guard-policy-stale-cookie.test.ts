import { describe, expect, it } from 'bun:test';
import { createGuardPolicy, evaluateGuard } from '../../src/serve/guard-policy.js';
import { presentedSessionTokenKind } from '../../src/serve/loopback-guard.js';

const SECRET_TOKEN = 'current-boot-session-token-123456';

describe('stale session cookie recovery in evaluateGuard', () => {
  it('distinguishes header, cookie, and missing session token presentation', () => {
    expect(
      presentedSessionTokenKind({
        headers: { host: 'box.tailnet.ts.net:5173' },
        socket: { localPort: 5173 },
      }),
    ).toBe('none');

    expect(
      presentedSessionTokenKind({
        headers: {
          host: 'box.tailnet.ts.net:5173',
          cookie: '__pyric_session_5173=stale-boot-token',
        },
        socket: { localPort: 5173 },
      }),
    ).toBe('cookie');

    expect(
      presentedSessionTokenKind({
        headers: {
          host: 'box.tailnet.ts.net:5173',
          'x-pyric-session-token': 'wrong-token',
          cookie: '__pyric_session_5173=stale-boot-token',
        },
        socket: { localPort: 5173 },
      }),
    ).toBe('header');
  });

  it('signals unlockRequired for a stale browser cookie on a remote unlock-enabled host', () => {
    const policy = createGuardPolicy({
      boundHost: '127.0.0.1',
      boundPort: 5173,
      allowedHosts: ['.tailnet.ts.net'],
      remoteAccessEnabled: true,
      trustProxy: 'loopback',
      sessionToken: SECRET_TOKEN,
    });

    const staleCookie = evaluateGuard(
      {
        headers: {
          host: 'box.tailnet.ts.net:5173',
          cookie: '__pyric_session_5173=stale-previous-boot-token',
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'init',
    );
    expect(staleCookie.ok).toBe(false);
    if (!staleCookie.ok) {
      expect(staleCookie.status).toBe(401);
      expect(staleCookie.reason).toBe('invalid-session-token');
      expect(staleCookie.unlockRequired).toBe(true);
      expect(staleCookie.message).toContain('/__pyric/unlock');
      expect(staleCookie.message).not.toContain(SECRET_TOKEN);
    }
  });

  it('suppresses unlockRequired when an explicit wrong x-pyric-session-token header is present', () => {
    const policy = createGuardPolicy({
      boundHost: '127.0.0.1',
      boundPort: 5173,
      allowedHosts: ['.tailnet.ts.net'],
      remoteAccessEnabled: true,
      trustProxy: 'loopback',
      sessionToken: SECRET_TOKEN,
    });

    const wrongHeaderAndCookie = evaluateGuard(
      {
        headers: {
          host: 'box.tailnet.ts.net:5173',
          'x-pyric-session-token': 'wrong',
          cookie: '__pyric_session_5173=stale-previous-boot-token',
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      policy,
      'init',
    );
    expect(wrongHeaderAndCookie.ok).toBe(false);
    if (!wrongHeaderAndCookie.ok) {
      expect(wrongHeaderAndCookie.status).toBe(401);
      expect(wrongHeaderAndCookie.reason).toBe('invalid-session-token');
      expect(wrongHeaderAndCookie.unlockRequired).toBe(false);
    }
  });

  it('suppresses unlockRequired for stale cookies when browserUnlock is disabled or request is local', () => {
    const noUnlockPolicy = createGuardPolicy({
      boundHost: '127.0.0.1',
      boundPort: 5173,
      allowedHosts: ['.tailnet.ts.net'],
      remoteAccessEnabled: true,
      trustProxy: 'loopback',
      browserUnlock: false,
      sessionToken: SECRET_TOKEN,
    });
    const noUnlock = evaluateGuard(
      {
        headers: {
          host: 'box.tailnet.ts.net:5173',
          cookie: '__pyric_session_5173=stale-previous-boot-token',
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      noUnlockPolicy,
      'init',
    );
    expect(noUnlock.ok).toBe(false);
    if (!noUnlock.ok) {
      expect(noUnlock.status).toBe(401);
      expect(noUnlock.reason).toBe('invalid-session-token');
      expect(noUnlock.unlockRequired).toBe(false);
    }

    const localStrictPolicy = createGuardPolicy({
      boundHost: '127.0.0.1',
      boundPort: 5173,
      requireSessionToken: true,
      sessionToken: SECRET_TOKEN,
    });
    const localStale = evaluateGuard(
      {
        headers: {
          host: 'localhost:5173',
          cookie: '__pyric_session_5173=stale-previous-boot-token',
        },
        socket: { remoteAddress: '127.0.0.1', localPort: 5173, encrypted: false },
      },
      localStrictPolicy,
      'init',
    );
    expect(localStale.ok).toBe(false);
    if (!localStale.ok) {
      expect(localStale.status).toBe(401);
      expect(localStale.reason).toBe('invalid-session-token');
      expect(localStale.unlockRequired).toBe(false);
    }
  });
});
