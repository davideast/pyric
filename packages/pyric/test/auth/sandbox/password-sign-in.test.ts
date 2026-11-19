import { describe, expect, it } from 'bun:test';
import type { StoredUser } from '../../../src/auth/sandbox-backend-types.js';
import { verifyPasswordSignIn } from '../../../src/auth/sandbox/password-sign-in.js';

function makeStoredUser(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    uid: 'user-1',
    email: 'owner@example.com',
    password: 'correct-password',
    displayName: 'Owner',
    photoURL: null,
    phoneNumber: null,
    emailVerified: false,
    isAnonymous: false,
    disabled: false,
    tenantId: null,
    customClaims: {},
    providerUserInfo: [{ providerId: 'password' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

function captureError(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    const typed = error as { code: string; message: string };
    return { code: typed.code, message: typed.message };
  }
  throw new Error('Expected verifyPasswordSignIn to throw');
}

describe('verifyPasswordSignIn', () => {
  it('returns the stored user when email and password match', () => {
    const record = makeStoredUser();
    const matched = verifyPasswordSignIn('owner@example.com', 'correct-password', () => record);
    expect(matched).toBe(record);
  });

  it('rejects malformed email with auth/invalid-email before calling lookup', () => {
    let lookedUp = false;
    const err = captureError(() =>
      verifyPasswordSignIn('not-an-email', 'correct-password', () => {
        lookedUp = true;
        return undefined;
      }),
    );
    expect(err.code).toBe('auth/invalid-email');
    expect(lookedUp).toBe(false);
  });

  it('rejects empty password with auth/missing-password before calling lookup', () => {
    let lookedUp = false;
    const err = captureError(() =>
      verifyPasswordSignIn('missing@example.com', '', () => {
        lookedUp = true;
        return undefined;
      }),
    );
    expect(err.code).toBe('auth/missing-password');
    expect(err.message).toBe('Firebase: Error (auth/missing-password).');
    expect(lookedUp).toBe(false);
  });

  it('rejects an unknown email with auth/invalid-credential without leaking user-not-found', () => {
    const err = captureError(() =>
      verifyPasswordSignIn('unknown@example.com', 'any-password', () => undefined),
    );
    expect(err.code).toBe('auth/invalid-credential');
    expect(err.message).toBe('Firebase: Error (auth/invalid-credential).');
    expect(err.message.includes('user-not-found')).toBe(false);
    expect(err.message.includes('INVALID_LOGIN_CREDENTIALS')).toBe(false);
  });

  it('rejects a disabled account with auth/user-disabled before comparing passwords', () => {
    const disabledRecord = makeStoredUser({ disabled: true });
    const err = captureError(() =>
      verifyPasswordSignIn('owner@example.com', 'wrong-password', () => disabledRecord),
    );
    expect(err.code).toBe('auth/user-disabled');
  });

  it('rejects a wrong password with auth/invalid-credential without leaking wrong-password', () => {
    const record = makeStoredUser();
    const err = captureError(() =>
      verifyPasswordSignIn('owner@example.com', 'wrong-password', () => record),
    );
    expect(err.code).toBe('auth/invalid-credential');
    expect(err.message).toBe('Firebase: Error (auth/invalid-credential).');
    expect(err.message.includes('wrong-password')).toBe(false);
  });
});
