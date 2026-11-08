import { describe, expect, it } from 'bun:test';
import { idTokenAudience, mintIdToken, SANDBOX_PROJECT_ID } from 'pyric/sandbox/internal';
import {
  assertIdTokenArgument,
  assertNotRevokedOrDisabled,
  FirebaseAuthError,
  invalidUid,
  userNotFound,
  verifySandboxIdToken,
} from '../../src/auth/verify-token.js';

describe('pyric-admin/auth token verification helpers', () => {
  it('validates token argument type synchronously and verifies minted sandbox ID tokens', async () => {
    expect(() => assertIdTokenArgument(123)).toThrow(/must be a Firebase ID token string/);
    const nowSec = Math.floor(Date.now() / 1000);
    const token = mintIdToken({
      ...idTokenAudience(SANDBOX_PROJECT_ID),
      sub: 'user-1',
      user_id: 'user-1',
      iat: nowSec,
      auth_time: nowSec,
      exp: nowSec + 3600,
      firebase: { identities: {}, sign_in_provider: 'password' },
    });
    const decoded = await verifySandboxIdToken(token, {
      projectId: SANDBOX_PROJECT_ID,
      nowMs: nowSec * 1000,
    });
    expect(decoded.uid).toBe('user-1');
  });

  it('checks uid bounds and account revocation or disabled standing', () => {
    expect(invalidUid('user-1')).toBeNull();
    expect(invalidUid('')?.code).toBe('auth/invalid-uid');
    expect(invalidUid('x'.repeat(129))?.code).toBe('auth/invalid-uid');
    expect(userNotFound()).toBeInstanceOf(FirebaseAuthError);

    const sampleDecoded = {
      aud: SANDBOX_PROJECT_ID,
      auth_time: 100,
      exp: 200,
      firebase: { identities: {}, sign_in_provider: 'password' },
      iat: 100,
      iss: `https://securetoken.google.com/${SANDBOX_PROJECT_ID}`,
      sub: 'user-1',
      uid: 'user-1',
    };
    expect(() => assertNotRevokedOrDisabled(sampleDecoded, { kind: 'deleted' })).toThrow(
      /no user record/,
    );
    expect(() => assertNotRevokedOrDisabled(sampleDecoded, { kind: 'disabled' })).toThrow(
      /user record is disabled/,
    );
    expect(() =>
      assertNotRevokedOrDisabled(sampleDecoded, { kind: 'active', tokensValidAfterMs: 101_000 }),
    ).toThrow(/revoked/);
    expect(
      assertNotRevokedOrDisabled(sampleDecoded, { kind: 'active', tokensValidAfterMs: 100_000 }),
    ).toBe(sampleDecoded);
  });
});
