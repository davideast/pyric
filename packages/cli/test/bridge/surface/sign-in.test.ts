/**
 * What the five sign-in methods share: the tenant pinning that lets a tenant
 * identity sign in without losing its tenant, the report that names the app
 * session and the agent identity apart, and the refusal that carries the SDK
 * error code and the sentence that says how to have the account exist.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox, signInWithEmailAndPassword } from 'pyric/auth';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { switchHeldIdentity } from '../../../src/bridge/surface/held-identity.js';
import {
  customTokenSubject,
  DISABLED_ACCOUNT_FIX,
  MISSING_ACCOUNT_FIX,
  POOL_FIX,
  reportAppSession,
  scopeToStoredTenant,
  signInFailure,
  WRONG_PASSWORD_FIX,
} from '../../../src/bridge/surface/sign-in.js';
import { mintSandboxCustomToken } from '../../../src/auth/users.js';

function seeded(): LocalSandbox {
  const sandbox = initializeSandbox();
  authSandbox.seedUsers(getAuth(sandbox), [
    { uid: 'riley', email: 'riley@acme.test', password: 'hunter22', tenantId: 'tenant-acme' },
    { uid: 'sam', email: 'sam@example.test', password: 'hunter22' },
  ]);
  return sandbox;
}

describe('scopeToStoredTenant', () => {
  it('pins the handle to the tenant the record belongs to', () => {
    const sandbox = seeded();
    scopeToStoredTenant(sandbox, { email: 'RILEY@acme.test' });
    expect(getAuth(sandbox).tenantId).toBe('tenant-acme');
  });

  it('pins the handle to the project pool for an untenanted record', () => {
    const sandbox = seeded();
    scopeToStoredTenant(sandbox, { email: 'riley@acme.test' });
    scopeToStoredTenant(sandbox, { uid: 'sam' });
    expect(getAuth(sandbox).tenantId).toBe(null);
  });

  it('pins the handle to the project pool when the pool holds no such identity', () => {
    const sandbox = seeded();
    scopeToStoredTenant(sandbox, { email: 'riley@acme.test' });
    scopeToStoredTenant(sandbox, {});
    expect(getAuth(sandbox).tenantId).toBe(null);
  });

  it('leaves the record its tenant across a sign-in', async () => {
    const sandbox = seeded();
    scopeToStoredTenant(sandbox, { email: 'riley@acme.test' });
    await signInWithEmailAndPassword(getAuth(sandbox), 'riley@acme.test', 'hunter22');
    const stored = authSandbox.listUsers(getAuth(sandbox)).find((user) => user.uid === 'riley');
    expect(stored?.tenantId).toBe('tenant-acme');
  });
});

describe('reportAppSession', () => {
  it('names the app session and says the agent identity is unchanged', async () => {
    const sandbox = seeded();
    const ctx = createSurfaceContext(sandbox);
    switchHeldIdentity(ctx, { mode: 'admin' });
    scopeToStoredTenant(sandbox, { email: 'riley@acme.test' });
    await signInWithEmailAndPassword(getAuth(sandbox), 'riley@acme.test', 'hunter22');

    const result = reportAppSession(ctx);
    const data = result.data as { appSession: { uid: string } | null; agent: { mode: string } };
    expect(data.appSession?.uid).toBe('riley');
    expect(data.agent.mode).toBe('admin');
    expect(result.summary).toContain('still runs as admin');
    expect(result.summary).toContain('useAppSession');
  });

  it('names a signed-out app session', () => {
    const result = reportAppSession(createSurfaceContext(seeded()));
    expect((result.data as { appSession: unknown }).appSession).toBe(null);
    expect(result.summary).toContain('signed out');
  });
});

/** A refusal shaped the way the sandbox raises one, code and all. */
function raised(code: string, message: string): Error {
  return Object.assign(new Error(`Firebase: ${message} (${code}).`), { code });
}

describe('signInFailure', () => {
  it('advises creating or seeding the account when the pool holds no such user', () => {
    const result = signInFailure(
      'signInWithEmailAndPassword',
      raised('auth/user-not-found', 'No user found for nobody@example.test.'),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toBe(
      'auth.signInWithEmailAndPassword: no account in the pool matched the credential ' +
        `(auth/user-not-found). ${MISSING_ACCOUNT_FIX}`,
    );
    expect(result.data).toMatchObject({
      code: 'auth/user-not-found',
      tool: 'auth',
      fix: MISSING_ACCOUNT_FIX,
    });
  });

  it('advises a new or a seeded password when the password did not match', () => {
    const result = signInFailure(
      'signInWithEmailAndPassword',
      raised('auth/wrong-password', 'The password is invalid.'),
    );
    expect(result.summary).toBe(
      'auth.signInWithEmailAndPassword: the password did not match the account ' +
        `(auth/wrong-password). ${WRONG_PASSWORD_FIX}`,
    );
    expect(result.data).toMatchObject({ code: 'auth/wrong-password', fix: WRONG_PASSWORD_FIX });
  });

  it('says the account is disabled when it is', () => {
    const result = signInFailure(
      'signInWithEmailAndPassword',
      raised('auth/user-disabled', 'The user account has been disabled.'),
    );
    expect(result.summary).toBe(
      'auth.signInWithEmailAndPassword: the account is disabled ' +
        `(auth/user-disabled). ${DISABLED_ACCOUNT_FIX}`,
    );
    expect(result.data).toMatchObject({ code: 'auth/user-disabled', fix: DISABLED_ACCOUNT_FIX });
  });

  it("carries the sandbox's own message for any other code, and points at the pool", () => {
    const result = signInFailure(
      'signInWithCredential',
      raised('auth/operation-not-allowed', 'The provider google.com is disabled.'),
    );
    expect(result.summary).toBe(
      'auth.signInWithCredential: Firebase: The provider google.com is disabled. ' +
        `(auth/operation-not-allowed). ${POOL_FIX}`,
    );
    expect(result.data).toMatchObject({ code: 'auth/operation-not-allowed', fix: POOL_FIX });
  });

  it('reports an error with no code as an internal one', () => {
    const result = signInFailure('signOut', new Error('boom'));
    expect(result.summary).toContain('auth/internal-error');
  });

  it('names the code once in every summary it writes', () => {
    const codes = [
      'auth/user-not-found',
      'auth/wrong-password',
      'auth/user-disabled',
      'auth/operation-not-allowed',
    ];
    for (const code of codes) {
      const summary = signInFailure('signInWithEmailAndPassword', raised(code, 'boom')).summary;
      expect(summary.split(code)).toHaveLength(2);
    }
  });
});

describe('customTokenSubject', () => {
  it('reads the uid out of a minted token', () => {
    expect(customTokenSubject(mintSandboxCustomToken('riley', { role: 'viewer' }))).toBe('riley');
  });

  it('reads the subject out of the middle segment of a three-part token', () => {
    const payload = btoa(JSON.stringify({ sub: 'sam' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(customTokenSubject(`header.${payload}.signature`)).toBe('sam');
  });

  it('reads nothing out of a token that asserts no identity', () => {
    expect(customTokenSubject('not a token')).toBeUndefined();
    expect(customTokenSubject('')).toBeUndefined();
  });
});
