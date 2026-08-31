/**
 * Adversarial Empirical Stress Suite for Multi-Tenant Impersonation (Milestone 1).
 *
 * Tests:
 * 1. Edge-case tenant strings (dashes, numbers, unicode, emoji, CJK, RTL, special chars, high length).
 * 2. Strict rejection of invalid types (empty string, non-string, null, boolean, object, array, function, symbol, NaN, BigInt).
 * 3. Deep immutability and isolation (frozen inputs, post-call tampering resistance, chained context independence).
 * 4. Explicit nested token override precedence (token.firebase.tenant vs top-level tenant, sub-claim preservation).
 * 5. Clean non-tenant identity ({ uid: 'alice' } has no tenant/firebase properties).
 * 6. Object.create(null) edge cases.
 * 7. End-to-end Firestore security rules evaluation with multi-tenant edge cases.
 * 8. Host lensCacheKey collision characterization.
 */
import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  SandboxContextImpl,
  SandboxError,
  normalizeAuthState,
  validateAuthState,
  type AuthState,
} from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  actingAs,
  doc,
  setDoc,
  getDoc,
  type DocumentSnapshot,
} from '../../src/firestore/index.js';
import {
  lensForAuth,
  authStateForLens,
  lensCacheKey,
} from '../../src/sandbox/admin-firestore/get-firestore.js';

// Multi-tenant path-isolated rule
const TENANT_PATH_ISOLATED = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tenants/{tenantId}/records/{recordId} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId;
    }
  }
}`;

// Explicit equality rule without path-wildcard constraints
const TENANT_EQUALITY_RULE = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /system/status {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == 'tenant:engineering@corp.internal/v1#special';
    }
    match /unicode/doc {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == '租户-东京-42-🔥';
    }
    match /numbers/doc {
      allow read: if request.auth != null
        && request.auth.token.firebase.tenant == '9876543210';
    }
  }
}`;

describe('Adversarial Stress: 1. Tenant String Varieties & Unicode', () => {
  const edgeCases = [
    { name: 'dashes and hyphens', tenant: 'tenant-prod-us-east-1-alpha' },
    { name: 'pure numeric string', tenant: '9876543210' },
    { name: 'alphanumeric with underscores', tenant: 'tenant_enterprise_2026_v2' },
    { name: 'CJK characters (Chinese/Japanese)', tenant: '租户-东京-42' },
    { name: 'European diacritics and accents', tenant: 'ténant-élégant-über-straß' },
    { name: 'Unicode Emoji', tenant: 'tenant-🚀-corp-🔥' },
    { name: 'Right-to-Left (Arabic / Hebrew)', tenant: 'مستأجر-فرعي-10' },
    { name: 'Dots and subdomains', tenant: 'tenant.sub.dept.domain.io' },
    { name: 'Special punctuation symbols', tenant: 'tenant+team=omega~star!2' },
    { name: 'Colon and at-sign', tenant: 'tenant:ops@cloud.dev' },
    { name: 'High-length tenant string (1000 chars)', tenant: 'tenant-' + 'x'.repeat(1000) },
  ];

  for (const { name, tenant } of edgeCases) {
    it(`normalizes correctly for: ${name}`, () => {
      const sandbox = initializeSandbox();
      const ctx = sandbox.withAuth({ uid: 'test-user', tenant });
      expect(ctx.auth).toEqual({
        uid: 'test-user',
        tenant,
        token: {
          firebase: {
            tenant,
          },
        },
      });
      expect(ctx.operationContext.authLens).toEqual({
        mode: 'as',
        uid: 'test-user',
        tenant,
        token: {
          firebase: {
            tenant,
          },
        },
      });
    });
  }

  it('evaluates unicode and emoji tenant in security rules', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, TENANT_EQUALITY_RULE);

    const validUnicodeUser = actingAs(sandbox, {
      uid: 'user-cjk',
      tenant: '租户-东京-42-🔥',
    });
    const invalidUnicodeUser = actingAs(sandbox, {
      uid: 'user-cjk-wrong',
      tenant: '租户-东京-42-💧', // wrong emoji
    });

    // Allowed for exact match
    await expect(getDoc(doc(validUnicodeUser, 'unicode/doc'))).resolves.toBeDefined();
    // Denied for mismatch
    await expect(getDoc(doc(invalidUnicodeUser, 'unicode/doc'))).rejects.toThrow();
  });

  it('evaluates pure numeric string tenant in security rules', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, TENANT_EQUALITY_RULE);

    const numUser = actingAs(sandbox, {
      uid: 'user-num',
      tenant: '9876543210',
    });
    const wrongNumUser = actingAs(sandbox, {
      uid: 'user-num-wrong',
      tenant: '9876543211',
    });

    await expect(getDoc(doc(numUser, 'numbers/doc'))).resolves.toBeDefined();
    await expect(getDoc(doc(wrongNumUser, 'numbers/doc'))).rejects.toThrow();
  });

  it('evaluates complex special characters with colons, slashes, hashes in equality rules', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, TENANT_EQUALITY_RULE);

    const specialUser = actingAs(sandbox, {
      uid: 'user-special',
      tenant: 'tenant:engineering@corp.internal/v1#special',
    });
    const wrongSpecialUser = actingAs(sandbox, {
      uid: 'user-special-wrong',
      tenant: 'tenant:engineering@corp.internal/v1#other',
    });

    await expect(getDoc(doc(specialUser, 'system/status'))).resolves.toBeDefined();
    await expect(getDoc(doc(wrongSpecialUser, 'system/status'))).rejects.toThrow();
  });

  it('evaluates path-wildcard rules with dashed and unicode tenants', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, TENANT_PATH_ISOLATED);

    const dashedUser = actingAs(sandbox, {
      uid: 'alice',
      tenant: 'tenant-alpha-123',
    });
    await expect(
      setDoc(doc(dashedUser, 'tenants/tenant-alpha-123/records/r1'), { ok: true }),
    ).resolves.toBeUndefined();

    // Unicode in path
    const unicodeUser = actingAs(sandbox, {
      uid: 'tanaka',
      tenant: '租户-东京',
    });
    await expect(
      setDoc(doc(unicodeUser, 'tenants/租户-东京/records/r1'), { ok: true }),
    ).resolves.toBeUndefined();

    // Mismatched access denied
    await expect(
      setDoc(doc(dashedUser, 'tenants/租户-东京/records/r1'), { hack: true }),
    ).rejects.toThrow();
  });
});

describe('Adversarial Stress: 2. Rejection of Invalid Types', () => {
  const invalidTenants: Array<[string, unknown]> = [
    ['empty string', ''],
    ['number positive', 42],
    ['number zero', 0],
    ['number negative', -1],
    ['number float', 3.14159],
    ['number NaN', NaN],
    ['number Infinity', Infinity],
    ['boolean true', true],
    ['boolean false', false],
    ['null', null],
    ['empty object', {}],
    ['non-empty object', { tenantId: 't1' }],
    ['empty array', []],
    ['string array', ['tenant-1']],
    ['function', () => 'tenant-1'],
    ['symbol', Symbol('tenant-1')],
    ['bigint', 100n],
  ];

  for (const [desc, badTenant] of invalidTenants) {
    it(`rejects ${desc} tenant on initializeSandbox().withAuth`, () => {
      const sandbox = initializeSandbox();
      expect(() => {
        // @ts-expect-error — testing runtime invalid input
        sandbox.withAuth({ uid: 'alice', tenant: badTenant });
      }).toThrow(SandboxError);

      try {
        // @ts-expect-error — testing runtime invalid input
        sandbox.withAuth({ uid: 'alice', tenant: badTenant });
      } catch (err: any) {
        expect(err).toBeInstanceOf(SandboxError);
        expect(err.code).toBe('invalid-argument');
        expect(err.message).toContain('tenant');
      }
    });

    it(`rejects ${desc} tenant on ctx.withAuth chaining`, () => {
      const sandbox = initializeSandbox();
      const ctx = sandbox.withAuth({ uid: 'alice' });
      expect(() => {
        // @ts-expect-error — testing runtime invalid input
        ctx.withAuth({ uid: 'bob', tenant: badTenant });
      }).toThrow(SandboxError);
    });

    it(`rejects ${desc} tenant on validateAuthState directly`, () => {
      expect(() => {
        validateAuthState({ uid: 'alice', tenant: badTenant });
      }).toThrow(SandboxError);
    });
  }

  it('rejects invalid combinations: empty uid with valid tenant', () => {
    const sandbox = initializeSandbox();
    expect(() => {
      sandbox.withAuth({ uid: '', tenant: 'valid-tenant' });
    }).toThrow(SandboxError);
  });

  it('rejects invalid combinations: non-string uid with valid tenant', () => {
    const sandbox = initializeSandbox();
    expect(() => {
      // @ts-expect-error — testing runtime invalid input
      sandbox.withAuth({ uid: 12345, tenant: 'valid-tenant' });
    }).toThrow(SandboxError);
  });

  it('rejects invalid token: array token with valid tenant', () => {
    const sandbox = initializeSandbox();
    expect(() => {
      // @ts-expect-error — testing runtime invalid input
      sandbox.withAuth({ uid: 'alice', tenant: 'valid-tenant', token: ['bad'] });
    }).toThrow(SandboxError);
  });

  it('rejects invalid token: null token with valid tenant', () => {
    const sandbox = initializeSandbox();
    expect(() => {
      // @ts-expect-error — testing runtime invalid input
      sandbox.withAuth({ uid: 'alice', tenant: 'valid-tenant', token: null });
    }).toThrow(SandboxError);
  });

  it('rejects non-object auth argument', () => {
    const sandbox = initializeSandbox();
    expect(() => {
      // @ts-expect-error — testing runtime invalid input
      sandbox.withAuth('alice');
    }).toThrow(SandboxError);
    expect(() => {
      // @ts-expect-error — testing runtime invalid input
      sandbox.withAuth(12345);
    }).toThrow(SandboxError);
  });
});

describe('Adversarial Stress: 3. Immutability & Tamper-Resistance', () => {
  it('does not mutate deeply frozen input object', () => {
    const sandbox = initializeSandbox();
    const frozenInput = Object.freeze({
      uid: 'alice',
      tenant: 'tenant-secure',
      token: Object.freeze({
        role: 'admin',
        firebase: Object.freeze({
          sign_in_provider: 'password',
        }),
      }),
    });

    // Should not throw TypeError for trying to assign to frozen object
    let ctx!: SandboxContextImpl;
    expect(() => {
      ctx = sandbox.withAuth(frozenInput) as SandboxContextImpl;
    }).not.toThrow();

    expect(ctx.auth).toEqual({
      uid: 'alice',
      tenant: 'tenant-secure',
      token: {
        role: 'admin',
        firebase: {
          sign_in_provider: 'password',
          tenant: 'tenant-secure',
        },
      },
    });

    // Input remains frozen and unaltered
    expect(Object.isFrozen(frozenInput)).toBe(true);
    expect(Object.isFrozen(frozenInput.token)).toBe(true);
    expect(Object.isFrozen(frozenInput.token.firebase)).toBe(true);
    expect('tenant' in frozenInput.token.firebase).toBe(false);
  });

  it('resists tampering with input object after withAuth call', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, TENANT_PATH_ISOLATED);

    const mutableToken: Record<string, any> = {
      firebase: { sign_in_provider: 'google.com' },
      plan: 'free',
    };
    const mutableAuth: { uid: string; tenant: string; token: Record<string, any> } = {
      uid: 'alice',
      tenant: 'tenant-alpha',
      token: mutableToken,
    };

    const aliceHandle = actingAs(sandbox, mutableAuth);
    const ctx = sandbox.withAuth(mutableAuth);

    // Caller maliciously tampers with their original object afterwards
    mutableAuth.uid = 'hacked-uid';
    mutableAuth.tenant = 'tenant-hacked';
    mutableToken.plan = 'enterprise';
    mutableToken.firebase.tenant = 'tenant-hacked';
    mutableToken.firebase.sign_in_provider = 'anonymous';

    // Context auth must be completely untouched
    expect(ctx.auth).toEqual({
      uid: 'alice',
      tenant: 'tenant-alpha',
      token: {
        firebase: {
          sign_in_provider: 'google.com',
          tenant: 'tenant-alpha',
        },
        plan: 'free',
      },
    });

    // Firestore rule evaluation must use the original un-tampered identity
    await expect(
      setDoc(doc(aliceHandle, 'tenants/tenant-alpha/records/r1'), { data: 'safe' }),
    ).resolves.toBeUndefined();

    // Denied on the tampered tenant
    await expect(
      setDoc(doc(aliceHandle, 'tenants/tenant-hacked/records/r1'), { data: 'exploit' }),
    ).rejects.toThrow();
  });

  it('guarantees context chaining independence (no state bleed)', () => {
    const sandbox = initializeSandbox();

    const ctx1 = sandbox.withAuth({ uid: 'user1', tenant: 'tenant-1' });
    const ctx2 = ctx1.withAuth({ uid: 'user2', tenant: 'tenant-2' });
    const ctx3 = ctx2.withAuth({ uid: 'user3' }); // non-tenant
    const ctx4 = ctx3.withAuth(null); // anon

    expect(ctx1.auth).toEqual({
      uid: 'user1',
      tenant: 'tenant-1',
      token: { firebase: { tenant: 'tenant-1' } },
    });
    expect(ctx2.auth).toEqual({
      uid: 'user2',
      tenant: 'tenant-2',
      token: { firebase: { tenant: 'tenant-2' } },
    });
    expect(ctx3.auth).toEqual({ uid: 'user3' });
    expect('tenant' in (ctx3.auth ?? {})).toBe(false);
    expect('token' in (ctx3.auth ?? {})).toBe(false);
    expect(ctx4.auth).toBeNull();
  });
});

describe('Adversarial Stress: 4. Explicit Nested Token Override Precedence', () => {
  it('token.firebase.tenant strictly wins over top-level tenant in context and rules', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, TENANT_PATH_ISOLATED);

    const conflictingIdentity = {
      uid: 'charlie',
      tenant: 'tenant-declared-bar',
      token: {
        firebase: {
          tenant: 'tenant-override-foo',
          identities: { 'google.com': ['12345'] },
        },
        tier: 'gold',
      },
    };

    const ctx = sandbox.withAuth(conflictingIdentity);

    // ctx.auth retains top-level tenant field but token.firebase.tenant is the override
    expect(ctx.auth?.tenant).toBe('tenant-declared-bar');
    expect((ctx.auth?.token?.firebase as any)?.tenant).toBe('tenant-override-foo');
    expect((ctx.auth?.token?.firebase as any)?.identities).toEqual({ 'google.com': ['12345'] });
    expect(ctx.auth?.token?.tier).toBe('gold');

    // Rule evaluation check:
    const handle = actingAs(sandbox, conflictingIdentity);

    // Must be ALLOWED on override tenant
    await expect(
      setDoc(doc(handle, 'tenants/tenant-override-foo/records/doc1'), { test: 1 }),
    ).resolves.toBeUndefined();

    // Must be DENIED on top-level tenant
    await expect(
      setDoc(doc(handle, 'tenants/tenant-declared-bar/records/doc1'), { test: 2 }),
    ).rejects.toThrow();
  });

  it('empty string in explicit token.firebase.tenant is preserved over top-level tenant', () => {
    const result = normalizeAuthState({
      uid: 'david',
      tenant: 'tenant-declared',
      token: {
        firebase: { tenant: '' },
      },
    });

    // Explicit empty string in token.firebase.tenant is preserved (not overwritten by top-level tenant)
    expect((result?.token?.firebase as any)?.tenant).toBe('');
  });

  it('explicit non-object firebase property in token is replaced with object containing tenant', () => {
    const result = normalizeAuthState({
      uid: 'david',
      tenant: 'tenant-declared',
      // @ts-expect-error — testing non-standard token shape
      token: {
        firebase: 'invalid-string-firebase',
      },
    });

    expect(result?.token?.firebase).toEqual({ tenant: 'tenant-declared' });
  });

  it('explicit array firebase property in token is replaced with object containing tenant', () => {
    const result = normalizeAuthState({
      uid: 'david',
      tenant: 'tenant-declared',
      // @ts-expect-error — testing non-standard token shape
      token: {
        firebase: ['not', 'an', 'object'],
      },
    });

    expect(result?.token?.firebase).toEqual({ tenant: 'tenant-declared' });
  });
});

describe('Adversarial Stress: 5. Clean Non-Tenant Identity', () => {
  it('strictly contains only uid when only uid is provided', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'plain-alice' });

    expect(ctx.auth).toEqual({ uid: 'plain-alice' });
    expect(Object.keys(ctx.auth ?? {})).toEqual(['uid']);
    expect('tenant' in (ctx.auth ?? {})).toBe(false);
    expect('token' in (ctx.auth ?? {})).toBe(false);

    expect(ctx.operationContext.authLens).toEqual({
      mode: 'as',
      uid: 'plain-alice',
    });
    expect('tenant' in ctx.operationContext.authLens).toBe(false);
    expect('token' in ctx.operationContext.authLens).toBe(false);
  });

  it('does not synthesize firebase or tenant in token when custom claims exist without tenant', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({
      uid: 'plain-bob',
      token: { role: 'editor', dept: 'eng' },
    });

    expect(ctx.auth).toEqual({
      uid: 'plain-bob',
      token: { role: 'editor', dept: 'eng' },
    });
    expect('tenant' in (ctx.auth ?? {})).toBe(false);
    expect('firebase' in (ctx.auth?.token ?? {})).toBe(false);
  });

  it('denies access to tenant-isolated rules when identity is non-tenant', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, TENANT_PATH_ISOLATED);

    const nonTenantUser = actingAs(sandbox, { uid: 'plain-charlie' });
    await expect(
      setDoc(doc(nonTenantUser, 'tenants/any-tenant/records/doc1'), { test: 1 }),
    ).rejects.toThrow();
  });

  it('anonymous identity (null) has null auth and anon lens', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth(null);

    expect(ctx.auth).toBeNull();
    expect(ctx.operationContext.authLens).toEqual({ mode: 'anon' });
  });
});

describe('Adversarial Stress: 6. Object.create(null) & Prototype Pollution', () => {
  it('handles auth created via Object.create(null)', () => {
    const sandbox = initializeSandbox();
    const bareAuth: any = Object.create(null);
    bareAuth.uid = 'bare-uid';
    bareAuth.tenant = 'bare-tenant';

    const ctx = sandbox.withAuth(bareAuth);
    expect(ctx.auth?.uid).toBe('bare-uid');
    expect(ctx.auth?.tenant).toBe('bare-tenant');
    expect((ctx.auth?.token?.firebase as any)?.tenant).toBe('bare-tenant');
  });

  it('does not pollute Object prototype', () => {
    const sandbox = initializeSandbox();
    sandbox.withAuth({
      uid: 'attacker',
      tenant: 'tenant-evil',
      token: {
        // @ts-expect-error — testing prototype pollution
        __proto__: { polluted: true },
      },
    });

    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe('Adversarial Stress: 7. Host Lens and Cache Key Edge Cases', () => {
  it('lensForAuth and authStateForLens round-trip identity with tenant', () => {
    const authWithTenant: AuthState = {
      uid: 'alice',
      tenant: 'tenant-t1',
      token: { role: 'admin' },
    };
    const lens = lensForAuth(authWithTenant);
    expect(lens).toEqual({
      mode: 'as',
      uid: 'alice',
      tenant: 'tenant-t1',
      token: { role: 'admin' },
    });

    const recoveredAuth = authStateForLens(lens as Extract<typeof lens, { mode: 'as' }>);
    expect(recoveredAuth).toEqual(authWithTenant);
  });

  it('characterizes lensCacheKey collision boundary (Finding)', () => {
    // Lens 1: User with uid containing colon and 'tenant:' prefix
    const lens1 = {
      mode: 'as' as const,
      uid: 'user:tenant:alpha',
    };

    // Lens 2: User with uid 'user' and tenant 'alpha'
    const lens2 = {
      mode: 'as' as const,
      uid: 'user',
      tenant: 'alpha',
    };

    const key1 = lensCacheKey(lens1);
    const key2 = lensCacheKey(lens2);

    // Both join with ':' resulting in 'user:tenant:alpha'
    expect(key1).toBe('user:tenant:alpha');
    expect(key2).toBe('user:tenant:alpha');
    expect(key1).toBe(key2); // Collision characterized
  });
});
