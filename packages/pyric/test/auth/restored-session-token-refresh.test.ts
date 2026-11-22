/**
 * Regression coverage for #1515: a session restored onto a sandbox without its
 * stored account record mints fresh `iat`, `auth_time`, and `exp` claims on
 * forced and expiry-driven token refreshes instead of keeping stale registered
 * claims from `state.token`.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getClock } from '../../src/sandbox/internal/index.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
} from '../../src/auth/index.js';

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const middle = parts[1] ?? '';
  return JSON.parse(Buffer.from(middle, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('restored session without account record token refresh (#1515)', () => {
  it('mints fresh iat, auth_time, and exp on forced refresh while preserving custom claims', async () => {
    const t0Ms = Date.parse('2026-11-01T00:00:00.000Z');
    const oneHourMs = 60 * 60 * 1000;

    const originSandbox = initializeSandbox();
    getClock(originSandbox).set(t0Ms);
    const originAuth = getAuth(originSandbox);
    const created = await createUserWithEmailAndPassword(
      originAuth,
      'restored@example.com',
      'pw-123456',
    );
    authSandbox.updateUser(originAuth, created.user.uid, {
      customClaims: { tier: 'pro' },
    });
    const initial = await created.user.getIdTokenResult(true);
    const t0Sec = Math.floor(t0Ms / 1000);
    expect(initial.claims.iat).toBe(t0Sec);
    expect(initial.claims.auth_time).toBe(t0Sec);

    const freshSandbox = initializeSandbox();
    getClock(freshSandbox).set(t0Ms);
    const freshAuth = getAuth(freshSandbox);
    freshSandbox.currentUser = originSandbox.currentUser;

    const restoredUser = freshAuth.currentUser;
    if (restoredUser === null) {
      throw new Error('expected restored currentUser');
    }

    getClock(freshSandbox).advance(oneHourMs);
    const refreshed = await restoredUser.getIdTokenResult(true);

    const t1Sec = Math.floor((t0Ms + oneHourMs) / 1000);
    expect(Math.floor(Date.parse(refreshed.issuedAtTime) / 1000)).toBe(t1Sec);
    expect(Math.floor(Date.parse(refreshed.authTime) / 1000)).toBe(t1Sec);
    expect(Math.floor(Date.parse(refreshed.expirationTime) / 1000)).toBe(t1Sec + 3600);

    expect(refreshed.claims.iat).toBe(t1Sec);
    expect(refreshed.claims.auth_time).toBe(t1Sec);
    expect(refreshed.claims.exp).toBe(t1Sec + 3600);
    expect(refreshed.claims.sub).toBe(created.user.uid);
    expect(refreshed.claims.tier).toBe('pro');

    const decoded = decodeJwtPayload(refreshed.token);
    expect(decoded.iat).toBe(t1Sec);
    expect(decoded.auth_time).toBe(t1Sec);
    expect(decoded.exp).toBe(t1Sec + 3600);

    // Rules context on the sandbox session also receives the refreshed timestamps.
    expect(freshSandbox.currentUser?.token?.iat).toBe(t1Sec);
    expect(freshSandbox.currentUser?.token?.auth_time).toBe(t1Sec);
    expect(freshSandbox.currentUser?.token?.exp).toBe(t1Sec + 3600);
  });

  it('auto-refreshes past the expiry point with updated iat and exp', async () => {
    const t0Ms = Date.parse('2026-11-01T12:00:00.000Z');
    const originSandbox = initializeSandbox();
    getClock(originSandbox).set(t0Ms);
    const originAuth = getAuth(originSandbox);
    await createUserWithEmailAndPassword(originAuth, 'expiry@example.com', 'pw-123456');

    const freshSandbox = initializeSandbox();
    getClock(freshSandbox).set(t0Ms);
    const freshAuth = getAuth(freshSandbox);
    freshSandbox.currentUser = originSandbox.currentUser;

    const restoredUser = freshAuth.currentUser;
    if (restoredUser === null) {
      throw new Error('expected restored currentUser');
    }
    const firstRead = await restoredUser.getIdTokenResult(false);
    expect(firstRead.claims.iat).toBe(Math.floor(t0Ms / 1000));

    // Advance 61 minutes so the cached token is past its refresh point.
    const advanceMs = 61 * 60 * 1000;
    getClock(freshSandbox).advance(advanceMs);
    const autoRefreshed = await restoredUser.getIdTokenResult(false);
    const expectedSec = Math.floor((t0Ms + advanceMs) / 1000);
    expect(autoRefreshed.claims.iat).toBe(expectedSec);
    expect(autoRefreshed.claims.exp).toBe(expectedSec + 3600);
  });
});
