/**
 * The `auth` tool's argument vocabulary: the Admin SDK renames and the two
 * checks a schema cannot state, the email shape and the minimum password
 * length.
 */
import { describe, expect, it } from 'bun:test';

import {
  RENAMES,
  checkCredentials,
  customClaims,
  tenantId,
  uid,
} from '../../../../src/bridge/surface/arguments/auth.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const fail = failFor('auth', 'createUser');

describe('the Admin SDK renames', () => {
  it('maps client and neighbouring spellings onto the Admin SDK names', () => {
    expect(RENAMES.claims).toBe('customClaims');
    expect(RENAMES.customUserClaims).toBe('customClaims');
    expect(RENAMES.tenant).toBe('tenantId');
    expect(RENAMES.tenantID).toBe('tenantId');
    expect(RENAMES.userId).toBe('uid');
    expect(RENAMES.user).toBe('uid');
    expect(RENAMES.id).toBe('uid');
    expect(RENAMES.name).toBe('displayName');
    expect(RENAMES.limit).toBe('maxResults');
    expect(RENAMES.pageSize).toBe('maxResults');
  });
});

describe('checkCredentials', () => {
  it('rejects an email with no local part, @, or domain', () => {
    const rejection = checkCredentials({ email: 'not-an-email' }, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('email');
    expect(rejection?.summary).toContain('is not an email address');
  });

  it('rejects a password shorter than the minimum', () => {
    const rejection = checkCredentials({ password: 'abc12' }, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('password');
    expect(rejection?.summary).toContain('at least 6');
  });

  it('passes a valid email and a password at the minimum length', () => {
    expect(checkCredentials({ email: 'alice@example.com', password: 'abc123' }, fail)).toBeNull();
  });

  it('does not check an absent email or password', () => {
    expect(checkCredentials({}, fail)).toBeNull();
    expect(checkCredentials({ uid: 'alice' }, fail)).toBeNull();
  });
});

describe('the schema fragments', () => {
  it('requires uid as a string', () => {
    expect(uid.safeParse('alice').success).toBe(true);
    expect(uid.safeParse(1).success).toBe(false);
  });

  it('makes customClaims and tenantId both optional', () => {
    expect(customClaims.safeParse(undefined).success).toBe(true);
    expect(customClaims.safeParse({ role: 'owner' }).success).toBe(true);
    expect(tenantId.safeParse(undefined).success).toBe(true);
    expect(tenantId.safeParse('tenant-a').success).toBe(true);
  });
});
