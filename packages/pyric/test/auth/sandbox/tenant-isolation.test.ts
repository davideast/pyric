import { describe, expect, it } from 'bun:test';
import {
  assertMatchingTenant,
  createTenantEmailPasswordAccount,
  linkTenantEmailIdentity,
  moveStoredUserEmail,
  normalizeTenantScope,
  tenantEmailKey,
  unindexStoredUserEmail,
  upsertTenantEmailLinkAccount,
  type TenantDirectoryAccount,
} from '../../../src/auth/sandbox/tenant-isolation.js';

interface TestAccount extends TenantDirectoryAccount {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  password: string | null;
  tenantId: string | null;
  isAnonymous: boolean;
  providerUserInfo: Array<{ providerId: string }>;
}

function makeAccount(init: {
  uid: string;
  email?: string | null;
  password?: string | null;
  tenantId?: string | null;
  isAnonymous?: boolean;
  providerUserInfo?: Array<{ providerId: string }>;
}): TestAccount {
  return {
    uid: init.uid,
    email: init.email ?? null,
    emailVerified: false,
    password: init.password ?? null,
    tenantId: init.tenantId ?? null,
    isAnonymous: init.isAnonymous ?? false,
    providerUserInfo: init.providerUserInfo ?? [],
  };
}

describe('tenant-isolation', () => {
  it('normalizes empty, null, and undefined tenant scopes to null', () => {
    expect(normalizeTenantScope(undefined)).toBeNull();
    expect(normalizeTenantScope(null)).toBeNull();
    expect(normalizeTenantScope('')).toBeNull();
    expect(normalizeTenantScope('org-alpha')).toBe('org-alpha');
  });

  it('produces collision-free email keys across tenants, root pool, and delimiter characters', () => {
    const rootKey = tenantEmailKey(null, 'User@Example.TEST');
    const emptyTenantKey = tenantEmailKey('', 'user@example.test');
    const alphaKey = tenantEmailKey('org-alpha', 'user@example.test');
    const betaKey = tenantEmailKey('org-beta', 'user@example.test');
    const trickyA = tenantEmailKey('org:a', 'b@example.test');
    const trickyB = tenantEmailKey('org', 'a:b@example.test');

    expect(rootKey).toBe(emptyTenantKey);
    expect(alphaKey).not.toBe(rootKey);
    expect(alphaKey).not.toBe(betaKey);
    expect(trickyA).not.toBe(trickyB);
  });

  it('accepts matching normalized tenants and throws auth/tenant-id-mismatch on cross-tenant access', () => {
    expect(() => assertMatchingTenant({ tenantId: null }, '')).not.toThrow();
    expect(() => assertMatchingTenant({ tenantId: 'org-alpha' }, 'org-alpha')).not.toThrow();

    expect(() => assertMatchingTenant({ tenantId: 'org-beta' }, 'org-alpha')).toThrow(
      "The provided tenant ID does not match the Auth instance's tenant ID",
    );
    try {
      assertMatchingTenant({ tenantId: 'org-beta' }, null);
    } catch (err) {
      expect((err as { code?: string }).code).toBe('auth/tenant-id-mismatch');
    }
  });

  it('creates, upserts, moves, links, and unindexes accounts strictly within their tenant email partition', () => {
    const usersByEmail = new Map<string, TestAccount>();
    const usersByUid = new Map<string, TestAccount>();

    const alphaCreated = createTenantEmailPasswordAccount({
      usersByEmail,
      usersByUid,
      email: 'member@example.test',
      password: 'AlphaPassword1!',
      tenantId: 'org-alpha',
      buildAccount: (fields) => makeAccount(fields),
    });
    const betaCreated = createTenantEmailPasswordAccount({
      usersByEmail,
      usersByUid,
      email: 'member@example.test',
      password: 'BetaPassword2!',
      tenantId: 'org-beta',
      buildAccount: (fields) => makeAccount(fields),
    });

    expect(alphaCreated.uid).not.toBe(betaCreated.uid);
    expect(usersByEmail.get(tenantEmailKey('org-alpha', 'member@example.test'))).toBe(alphaCreated);
    expect(usersByEmail.get(tenantEmailKey('org-beta', 'member@example.test'))).toBe(betaCreated);

    expect(() =>
      createTenantEmailPasswordAccount({
        usersByEmail,
        usersByUid,
        email: 'member@example.test',
        password: 'DuplicatePassword3!',
        tenantId: 'org-alpha',
        buildAccount: (fields) => makeAccount(fields),
      }),
    ).toThrow(/already exists/);

    moveStoredUserEmail(usersByEmail, alphaCreated, 'renamed@example.test');
    expect(alphaCreated.email).toBe('renamed@example.test');
    expect(alphaCreated.emailVerified).toBe(true);
    expect(usersByEmail.has(tenantEmailKey('org-alpha', 'member@example.test'))).toBe(false);
    expect(usersByEmail.get(tenantEmailKey('org-beta', 'member@example.test'))).toBe(betaCreated);

    const upsertedExisting = upsertTenantEmailLinkAccount({
      usersByEmail,
      usersByUid,
      email: 'renamed@example.test',
      tenantId: 'org-alpha',
      buildAccount: (fields) => makeAccount(fields),
    });
    expect(upsertedExisting.isNewUser).toBe(false);
    expect(upsertedExisting.stored).toBe(alphaCreated);

    const upsertedNew = upsertTenantEmailLinkAccount({
      usersByEmail,
      usersByUid,
      email: 'passwordless@example.test',
      tenantId: 'org-alpha',
      buildAccount: (fields) => makeAccount(fields),
    });
    expect(upsertedNew.isNewUser).toBe(true);
    expect(upsertedNew.stored.emailVerified).toBe(true);
    expect(upsertedNew.stored.tenantId).toBe('org-alpha');

    const anonAlpha = makeAccount({ uid: 'anon-1', tenantId: 'org-alpha', isAnonymous: true });
    usersByUid.set(anonAlpha.uid, anonAlpha);
    linkTenantEmailIdentity(usersByEmail, anonAlpha, {
      email: 'linked@example.test',
      password: 'LinkedPassword4!',
      emailVerified: true,
    });
    expect(anonAlpha.email).toBe('linked@example.test');
    expect(usersByEmail.get(tenantEmailKey('org-alpha', 'linked@example.test'))).toBe(anonAlpha);

    unindexStoredUserEmail(usersByEmail, anonAlpha);
    expect(usersByEmail.has(tenantEmailKey('org-alpha', 'linked@example.test'))).toBe(false);
  });
});
