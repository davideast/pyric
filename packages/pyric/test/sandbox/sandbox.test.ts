/**
 * Verify the `Sandbox` host abstraction under the multi-context
 * identity model. Sandboxes are identity-agnostic: they hold the
 * data, listener registries, and lifecycle. Identity is exclusively
 * a property of `SandboxContext`, derived via `sandbox.withAuth(...)`.
 *
 * Service-handle tests for the new model live alongside `/firestore`.
 */
import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  SandboxContextImpl,
  SandboxError,
  normalizeAuthState,
  type Sandbox,
} from '../../src/sandbox/index.js';

describe('initializeSandbox', () => {
  it('creates a sandbox with no identity attached', () => {
    const sandbox = initializeSandbox();
    // The interface intentionally exposes no `auth` field — identity
    // belongs to contexts, not sandboxes. Verify the shape via lifecycle
    // methods that should always be present.
    expect(typeof sandbox.withAuth).toBe('function');
    expect(typeof sandbox.reset).toBe('function');
    expect(typeof sandbox.dispose).toBe('function');
  });

  it('takes no arguments today (config slot reserved for future service-agnostic options)', () => {
    expect(() => initializeSandbox()).not.toThrow();
    expect(() => initializeSandbox({})).not.toThrow();
  });
});

describe('Sandbox.withAuth', () => {
  it('produces a SandboxContext bound to this sandbox with the given auth', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'alice' });
    expect(ctx).toBeInstanceOf(SandboxContextImpl);
    expect(ctx.sandbox).toBe(sandbox);
    expect(ctx.auth).toEqual({ uid: 'alice' });
  });

  it('accepts null for explicit anonymous', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth(null);
    expect(ctx.auth).toBeNull();
  });

  it('accepts custom token claims alongside uid', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'admin', token: { admin: true } });
    expect(ctx.auth).toEqual({ uid: 'admin', token: { admin: true } });
  });

  it('throws invalid-argument when called with undefined', () => {
    const sandbox = initializeSandbox();
    let err: unknown;
    try {
      // @ts-expect-error — intentionally exercising the bad-argument path
      sandbox.withAuth(undefined);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('invalid-argument');
    expect((err as SandboxError).message).toMatch(/explicit/);
  });

  it('throws when uid is empty', () => {
    const sandbox = initializeSandbox();
    let err: unknown;
    try {
      sandbox.withAuth({ uid: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('invalid-argument');
  });

  it('throws when token is non-object', () => {
    const sandbox = initializeSandbox();
    let err: unknown;
    try {
      // @ts-expect-error — intentionally exercising the bad-argument path
      sandbox.withAuth({ uid: 'alice', token: 'oops' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('invalid-argument');
  });

  it('normalizes top-level tenant into token.firebase.tenant', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'alice', tenant: 'tenant-123' });
    expect(ctx.auth).toEqual({
      uid: 'alice',
      tenant: 'tenant-123',
      token: {
        firebase: { tenant: 'tenant-123' },
      },
    });
    expect(ctx.operationContext.authLens).toEqual({
      mode: 'as',
      uid: 'alice',
      tenant: 'tenant-123',
      token: {
        firebase: { tenant: 'tenant-123' },
      },
    });
  });

  it('preserves custom claims alongside tenant in token', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({
      uid: 'alice',
      tenant: 'tenant-123',
      token: { role: 'admin', tier: 'enterprise' },
    });
    expect(ctx.auth).toEqual({
      uid: 'alice',
      tenant: 'tenant-123',
      token: {
        role: 'admin',
        tier: 'enterprise',
        firebase: { tenant: 'tenant-123' },
      },
    });
  });

  it('preserves explicit nested token.firebase.tenant over top-level tenant', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({
      uid: 'alice',
      tenant: 'tenant-top',
      token: {
        firebase: { tenant: 'tenant-override', sign_in_provider: 'google.com' },
      },
    });
    expect(ctx.auth).toEqual({
      uid: 'alice',
      tenant: 'tenant-top',
      token: {
        firebase: { tenant: 'tenant-override', sign_in_provider: 'google.com' },
      },
    });
  });

  it('preserves explicit non-tenant firebase sub-claims while adding tenant', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({
      uid: 'alice',
      tenant: 'tenant-alpha',
      token: {
        firebase: { sign_in_provider: 'password' },
      },
    });
    expect(ctx.auth).toEqual({
      uid: 'alice',
      tenant: 'tenant-alpha',
      token: {
        firebase: { sign_in_provider: 'password', tenant: 'tenant-alpha' },
      },
    });
  });

  it('does not synthesize empty firebase or tenant when tenant is omitted', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'alice' });
    expect(ctx.auth).toEqual({ uid: 'alice' });
    expect('tenant' in (ctx.auth ?? {})).toBe(false);
    expect('token' in (ctx.auth ?? {})).toBe(false);
  });

  it('does not mutate caller input objects', () => {
    const sandbox = initializeSandbox();
    const inputToken = { role: 'editor' };
    const inputAuth = { uid: 'alice', tenant: 'tenant-xyz', token: inputToken };

    const ctx = sandbox.withAuth(inputAuth);

    // Input object and nested token remain unmodified
    expect(inputToken).toEqual({ role: 'editor' });
    expect('firebase' in inputToken).toBe(false);
    expect(inputAuth).toEqual({
      uid: 'alice',
      tenant: 'tenant-xyz',
      token: { role: 'editor' },
    });

    // Mutating inputToken afterwards does not affect context
    inputToken.role = 'tampered';
    expect((ctx.auth?.token as Record<string, unknown>).role).toBe('editor');
  });

  it('throws when tenant is empty string or non-string', () => {
    const sandbox = initializeSandbox();
    expect(() => {
      sandbox.withAuth({ uid: 'alice', tenant: '' });
    }).toThrow(SandboxError);

    expect(() => {
      // @ts-expect-error — exercising bad argument
      sandbox.withAuth({ uid: 'alice', tenant: 123 });
    }).toThrow(SandboxError);
  });
});

describe('normalizeAuthState', () => {
  it('returns null when input is null', () => {
    expect(normalizeAuthState(null)).toBeNull();
  });

  it('leaves non-tenant auth intact without synthesizing firebase token', () => {
    const result = normalizeAuthState({ uid: 'bob' });
    expect(result).toEqual({ uid: 'bob' });
    expect('tenant' in (result ?? {})).toBe(false);
    expect('token' in (result ?? {})).toBe(false);
  });

  it('clones token on non-tenant auth to guarantee isolation', () => {
    const token = { admin: true };
    const result = normalizeAuthState({ uid: 'admin', token });
    expect(result).toEqual({ uid: 'admin', token: { admin: true } });
    expect(result?.token).not.toBe(token);
  });

  it('projects tenant to token.firebase.tenant when tenant is provided', () => {
    const result = normalizeAuthState({ uid: 'carol', tenant: 'tenant-acme' });
    expect(result).toEqual({
      uid: 'carol',
      tenant: 'tenant-acme',
      token: {
        firebase: { tenant: 'tenant-acme' },
      },
    });
  });

  it('explicit nested token.firebase.tenant overrides top-level tenant', () => {
    const result = normalizeAuthState({
      uid: 'carol',
      tenant: 'tenant-acme',
      token: {
        firebase: { tenant: 'explicit-override', provider: 'saml' },
      },
    });
    expect(result).toEqual({
      uid: 'carol',
      tenant: 'tenant-acme',
      token: {
        firebase: { tenant: 'explicit-override', provider: 'saml' },
      },
    });
  });
});

describe('SandboxContext.withAuth (chaining)', () => {
  it('produces a sibling context on the same sandbox with replaced auth', () => {
    const sandbox = initializeSandbox();
    const adminCtx = sandbox.withAuth({ uid: 'admin', token: { admin: true } });
    const userCtx = adminCtx.withAuth({ uid: 'alice' });
    // Same sandbox.
    expect(userCtx.sandbox).toBe(sandbox);
    // Auth replaced — no admin claim leaks through.
    expect(userCtx.auth).toEqual({ uid: 'alice' });
    // Original context untouched.
    expect(adminCtx.auth).toEqual({ uid: 'admin', token: { admin: true } });
  });

  it('chains arbitrarily; each step replaces auth', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox
      .withAuth({ uid: 'alice' })
      .withAuth({ uid: 'bob' })
      .withAuth(null);
    expect(ctx.auth).toBeNull();
    expect(ctx.sandbox).toBe(sandbox);
  });
});

describe('Sandbox.reset', () => {
  it('runs without error', () => {
    const sandbox = initializeSandbox();
    expect(() => sandbox.reset()).not.toThrow();
  });

  it('existing contexts continue to work after reset (sandbox reference is stable)', () => {
    const sandbox = initializeSandbox();
    const ctx = sandbox.withAuth({ uid: 'alice' });
    sandbox.reset();
    // The sandbox reference is unchanged; the context still points at it.
    expect(ctx.sandbox).toBe(sandbox);
    // And `withAuth` still works (sandbox now has a fresh env underneath).
    const sibling: Sandbox = sandbox;
    expect(() => sibling.withAuth({ uid: 'bob' })).not.toThrow();
  });
});

describe('SandboxError', () => {
  it('carries code and message and is recognizable via instanceof', () => {
    const err = new SandboxError('permission-denied', 'rule blocked the read');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe('permission-denied');
    expect(err.message).toBe('rule blocked the read');
    expect(err.name).toBe('SandboxError');
  });

  it('accepts and exposes denialContext when provided', () => {
    const err = new SandboxError('permission-denied', 'denied', {
      rule: { line: 7, expression: 'request.auth.uid == resource.data.ownerId' },
      auth: { uid: 'bob' },
      failedFields: ['ownerId'],
    });
    expect(err.denialContext?.rule?.line).toBe(7);
    expect(err.denialContext?.auth).toEqual({ uid: 'bob' });
    expect(err.denialContext?.failedFields).toEqual(['ownerId']);
  });
});
