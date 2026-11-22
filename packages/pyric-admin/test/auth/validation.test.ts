import { describe, expect, it } from 'bun:test';
import type { AuthUserRecord } from 'pyric/auth';
import {
  assertCustomTokenArguments,
  assertValidCustomUserClaims,
  fromAuthUserRecord,
  toSandboxCreateRequest,
  translateAdminBackendError,
  validateAdminEmail,
  validateAdminPassword,
} from '../../src/auth/validation.js';

describe('pyric-admin/auth validation and conversion', () => {
  it('validates custom token uid and developerClaims', () => {
    expect(() => assertCustomTokenArguments('')).toThrow(/non-empty string uid/);
    expect(() => assertCustomTokenArguments('x'.repeat(129))).toThrow(/128 characters/);
    expect(() => assertCustomTokenArguments('user-1', null)).toThrow(/valid, non-null object/);
    expect(() => assertCustomTokenArguments('user-1', [])).toThrow(/valid, non-null object/);
    expect(() => assertCustomTokenArguments('user-1', { aud: 'other' })).toThrow(/reserved/);
    expect(() => assertCustomTokenArguments('user-1', { firebase: {} })).not.toThrow();
  });

  it('validates custom user claims shape, reserved keys, and 1000-character limit', () => {
    expect(() => assertValidCustomUserClaims(null)).not.toThrow();
    expect(() => assertValidCustomUserClaims([] as never)).toThrow(/object or null/);
    expect(() => assertValidCustomUserClaims({ sub: 'x' })).toThrow(/reserved/);
    expect(() => assertValidCustomUserClaims({ data: 'x'.repeat(1001) })).toThrow(/1000 characters/);
  });

  it('validates admin email and password formats and translates backend error codes', () => {
    expect(validateAdminEmail('user@example.com')).toBeNull();
    expect(validateAdminEmail(' user@example.com ')?.code).toBe('auth/invalid-email');
    expect(validateAdminEmail('not-an-email')?.code).toBe('auth/invalid-email');

    expect(validateAdminPassword('secret')).toBeNull();
    expect(validateAdminPassword('12345')?.code).toBe('auth/invalid-password');

    const uidDup = translateAdminBackendError({ code: 'auth/uid-already-exists', message: 'uid dup' }) as {
      code?: string;
    };
    expect(uidDup.code).toBe('auth/uid-already-exists');

    const dup = translateAdminBackendError({ code: 'auth/email-already-in-use', message: 'dup' }) as {
      code?: string;
    };
    expect(dup.code).toBe('auth/email-already-exists');

    const weak = translateAdminBackendError({ code: 'auth/weak-password', message: 'weak' }) as {
      code?: string;
    };
    expect(weak.code).toBe('auth/invalid-password');
  });

  it('converts between admin and sandbox user record shapes', () => {
    const req = toSandboxCreateRequest({
      uid: 'user-1',
      email: 'user@example.com',
      displayName: null,
      photoURL: null,
      phoneNumber: null,
    });
    expect(req.displayName).toBeUndefined();
    expect(req.photoUrl).toBeUndefined();

    const raw: AuthUserRecord = {
      uid: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      displayName: 'User One',
      photoUrl: null,
      phoneNumber: null,
      disabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      customClaims: { tier: 'pro' },
      providerUserInfo: [
        {
          providerId: 'password',
          rawId: 'user@example.com',
          email: 'user@example.com',
          displayName: 'User One',
          photoUrl: null,
          phoneNumber: null,
        },
      ],
      tenantId: null,
      isAnonymous: false,
    };
    const converted = fromAuthUserRecord(raw);
    expect(converted.uid).toBe('user-1');
    expect(converted.customClaims).toEqual({ tier: 'pro' });
    expect(converted.providerData[0]?.providerId).toBe('password');
    expect(converted.tokensValidAfterTime).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(converted.toJSON().tokensValidAfterTime).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(converted.metadata.creationTime).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(converted.metadata.lastSignInTime).toBeNull();
    expect(converted.metadata.lastRefreshTime).toBeNull();
    expect(converted.metadata.toJSON()).toEqual({
      creationTime: 'Thu, 01 Jan 2026 00:00:00 GMT',
      lastSignInTime: null,
      lastRefreshTime: null,
    });

    const signedIn = fromAuthUserRecord({
      ...raw,
      lastLoginAt: '2026-01-02T03:04:05.000Z',
      lastRefreshAt: '2026-01-02T04:05:06.000Z',
      tenantId: 'tenant-alpha',
    });
    expect(signedIn.tenantId).toBe('tenant-alpha');
    expect(signedIn.metadata.creationTime).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(signedIn.metadata.lastSignInTime).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
    expect(signedIn.metadata.lastRefreshTime).toBe('Fri, 02 Jan 2026 04:05:06 GMT');
    expect(signedIn.metadata.toJSON()).toEqual({
      creationTime: 'Thu, 01 Jan 2026 00:00:00 GMT',
      lastSignInTime: 'Fri, 02 Jan 2026 03:04:05 GMT',
      lastRefreshTime: 'Fri, 02 Jan 2026 04:05:06 GMT',
    });

    const legacySignedIn = fromAuthUserRecord({
      ...raw,
      lastLoginAt: '2026-01-02T03:04:05.000Z',
    });
    expect(legacySignedIn.metadata.lastSignInTime).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
    expect(legacySignedIn.metadata.lastRefreshTime).toBe('Fri, 02 Jan 2026 03:04:05 GMT');

    const revoked = fromAuthUserRecord({
      ...raw,
      tokensValidAfterMs: Date.parse('2026-02-03T04:05:06.789Z'),
    });
    expect(revoked.tokensValidAfterTime).toBe('Tue, 03 Feb 2026 04:05:06 GMT');
    expect(revoked.toJSON().tokensValidAfterTime).toBe('Tue, 03 Feb 2026 04:05:06 GMT');
  });
});
