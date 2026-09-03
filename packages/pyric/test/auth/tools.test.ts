/**
 * `createAuthUserTools` at the surface: the handlers administer the same
 * user store the client Auth API signs in through, never return a password,
 * and mint the custom token `signInWithCustomToken` accepts.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  createAuthUserTools,
  getAuth,
  getIdTokenResult,
  mintSandboxCustomToken,
  sandbox as sandboxAuth,
  signInWithCustomToken,
  signInWithEmailAndPassword,
} from 'pyric/auth';

const ctx = { signal: new AbortController().signal } as never;

function handlers(sandbox = initializeSandbox()) {
  const tools = createAuthUserTools({ resolveSandbox: () => sandbox });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    sandbox,
    names: tools.map((tool) => tool.name),
    run: (name: string, args: Record<string, unknown>) => byName.get(name)!.execute(args, ctx),
  };
}

describe('createAuthUserTools', () => {
  it('yields the eight user-administration handlers', () => {
    expect(handlers().names).toEqual([
      'auth_create_user',
      'auth_import_users',
      'auth_get_user',
      'auth_list_users',
      'auth_update_user',
      'auth_delete_user',
      'auth_set_claims',
      'auth_custom_token',
    ]);
  });

  it('creates users the client Auth API can sign in, and never returns the password', async () => {
    const { sandbox, run } = handlers();
    const created = await run('auth_create_user', {
      email: 'alice@example.com',
      password: 'secret-1',
      displayName: 'Alice',
      claims: { role: 'admin' },
    });
    expect(created.ok).toBe(true);
    const { user } = created.data as { user: { uid: string; claims: Record<string, unknown> } };
    expect(user.uid).toMatch(/^user-\d+$/);
    expect(user.claims).toEqual({ role: 'admin' });
    expect(JSON.stringify(created.data)).not.toContain('secret-1');

    const credential = await signInWithEmailAndPassword(getAuth(sandbox), 'alice@example.com', 'secret-1');
    expect(credential.user.uid).toBe(user.uid);
    expect((await getIdTokenResult(credential.user)).claims).toMatchObject({ role: 'admin' });

    const got = await run('auth_get_user', { email: 'alice@example.com' });
    expect(got.ok).toBe(true);
    expect(JSON.stringify(got.data)).not.toContain('secret-1');
    expect(JSON.stringify(got.data)).not.toContain('"password":');
  });

  it('reads the store the sandbox driver seeded', async () => {
    const { sandbox, run } = handlers();
    sandboxAuth.seedUsers(getAuth(sandbox), [
      { uid: 'seeded', email: 'seeded@example.com', password: 'secret-9', customClaims: { plan: 'pro' } },
    ]);
    const listed = await run('auth_list_users', {});
    expect(listed.data).toMatchObject({ total: 1, users: [{ uid: 'seeded', claims: { plan: 'pro' } }] });
    const limited = await run('auth_list_users', { limit: 0 });
    expect(limited.data).toEqual({ users: [], total: 1 });
  });

  it('mints the custom token shape the sandbox accepts, carrying the claims', async () => {
    const { sandbox, run } = handlers();
    const minted = await run('auth_custom_token', { uid: 'minted', claims: { role: 'editor' } });
    expect(minted.ok).toBe(true);
    const { token } = minted.data as { token: string };
    expect(token).toBe(mintSandboxCustomToken('minted', { role: 'editor' }));
    expect(token).not.toContain('.');
    const credential = await signInWithCustomToken(getAuth(sandbox), token);
    expect(credential.user.uid).toBe('minted');
    expect((await getIdTokenResult(credential.user)).claims).toMatchObject({ role: 'editor' });
    const stored = await run('auth_get_user', { uid: 'minted' });
    expect((stored.data as { user: { claims: unknown } }).user.claims).toEqual({ role: 'editor' });

    const empty = await run('auth_custom_token', { uid: '' });
    expect(empty.ok).toBe(false);
    expect(empty.data).toEqual({ code: 'auth/argument-error' });
  });

  it('returns the sandbox auth code when an operation fails', async () => {
    const { run } = handlers();
    expect((await run('auth_delete_user', { uid: 'missing' })).data).toEqual({ code: 'auth/user-not-found' });
    expect((await run('auth_set_claims', { uid: 'missing', claims: {} })).data).toEqual({
      code: 'auth/user-not-found',
    });
    expect((await run('auth_create_user', { password: 'secret-1' })).data).toEqual({ code: 'auth/invalid-email' });
    expect((await run('auth_get_user', {})).data).toEqual({ code: 'auth/argument-error' });
  });
});
