/**
 * The `auth_users` tool end to end: the composed MCP surface validates each
 * op, and the browser dispatcher runs the same handlers against a sandbox
 * whose user store the client Auth API then signs in through.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, getIdTokenResult, signInWithCustomToken } from 'pyric/auth';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { composeMcpTools, resolveToolCall } from '../../src/bridge/server/tool-surface.js';

interface UserView {
  uid: string;
  email: string | null;
  claims: Record<string, unknown>;
  disabled: boolean;
  providers: string[];
}

function views(result: { data?: unknown }): UserView[] {
  return (result.data as { users: UserView[] }).users;
}

describe('auth_users tool', () => {
  const tool = composeMcpTools().find((candidate) => candidate.name === 'auth_users')!;

  it('advertises the ratified ops, all forwarded, with the record fields', () => {
    expect(tool.ops.map((op) => op.op)).toEqual([
      'create',
      'import',
      'get',
      'list',
      'update',
      'delete',
      'set_claims',
      'custom_token',
    ]);
    for (const op of tool.ops) expect(op.transport).toBe('forwarded');
    const fields = (op: string) => tool.ops.find((candidate) => candidate.op === op)!.fields;
    expect(fields('import').map((field) => field.name)).toEqual(['users']);
    expect(fields('set_claims').filter((field) => field.required).map((field) => field.name)).toEqual([
      'uid',
      'claims',
    ]);
    expect(fields('custom_token').map((field) => field.name)).toEqual(['uid', 'claims']);
    expect(tool.description).toContain('- import:');
  });

  it('validates fields per op through the composed surface', () => {
    const missing = resolveToolCall(tool, { op: 'set_claims', uid: 'alice' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.result.summary).toContain("'claims' is required");

    const stray = resolveToolCall(tool, { op: 'delete', uid: 'alice', email: 'a@example.com' });
    expect(stray.ok).toBe(false);
    if (!stray.ok) expect(stray.result.summary).toContain("'email' is not a field of op 'delete'");

    const valid = resolveToolCall(tool, {
      op: 'import',
      users: [{ email: 'a@example.com', claims: { role: 'admin' } }],
    });
    expect(valid.ok).toBe(true);
  });

  it('imports users with claims, lists them without passwords, sets claims, signs in with a custom token, and deletes', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);

    const imported = await dispatch('auth_users', 'import', {
      users: [
        { uid: 'alice', email: 'alice@example.com', password: 'secret-1', claims: { role: 'admin' } },
        { uid: 'bob', email: 'bob@example.com', password: 'secret-2', claims: { role: 'member' }, disabled: true },
      ],
    });
    expect(imported.ok).toBe(true);
    expect(imported.data).toEqual({ created: ['alice', 'bob'], errors: [] });

    const listed = await dispatch('auth_users', 'list', {});
    expect(listed.ok).toBe(true);
    const users = views(listed);
    expect(users.map((user) => user.uid)).toEqual(['alice', 'bob']);
    expect(users.map((user) => user.claims)).toEqual([{ role: 'admin' }, { role: 'member' }]);
    expect(users[1]!.disabled).toBe(true);
    expect(users[0]!.providers).toEqual(['password']);
    expect(JSON.stringify(listed.data)).not.toContain('secret-');
    expect(JSON.stringify(listed.data)).not.toContain('"password":');

    const byEmail = await dispatch('auth_users', 'get', { email: 'Bob@example.com' });
    expect(byEmail.ok).toBe(true);
    expect((byEmail.data as { user: UserView }).user.uid).toBe('bob');
    expect(JSON.stringify(byEmail.data)).not.toContain('secret-');

    const setClaims = await dispatch('auth_users', 'set_claims', {
      uid: 'alice',
      claims: { role: 'owner', tier: 'gold' },
    });
    expect(setClaims.ok).toBe(true);
    expect((setClaims.data as { user: UserView }).user.claims).toEqual({ role: 'owner', tier: 'gold' });

    const minted = await dispatch('auth_users', 'custom_token', {
      uid: 'alice',
      claims: { role: 'owner', tier: 'gold' },
    });
    expect(minted.ok).toBe(true);
    const { token } = minted.data as { token: string };
    const credential = await signInWithCustomToken(getAuth(sandbox), token);
    expect(credential.user.uid).toBe('alice');
    const idToken = await getIdTokenResult(credential.user);
    expect(idToken.claims).toMatchObject({ sub: 'alice', role: 'owner', tier: 'gold' });

    const deleted = await dispatch('auth_users', 'delete', { uid: 'bob' });
    expect(deleted.ok).toBe(true);
    const remaining = await dispatch('auth_users', 'list', {});
    expect(views(remaining).map((user) => user.uid)).toEqual(['alice']);
  });

  it('reports per-user import errors and continues, and returns auth codes on failures', async () => {
    const dispatch = buildSandboxDispatcher(initializeSandbox());

    const imported = await dispatch('auth_users', 'import', {
      users: [
        { uid: 'carol', email: 'carol@example.com' },
        { uid: 'carol', email: 'dup@example.com' },
        { email: 'weak@example.com', password: '123' },
        { uid: 'dave', email: 'dave@example.com', password: 'secret-4' },
      ],
    });
    expect(imported.ok).toBe(false);
    const { created, errors } = imported.data as { created: string[]; errors: { index: number; code: string }[] };
    expect(created).toEqual(['carol', 'dave']);
    expect(errors.map((error) => [error.index, error.code])).toEqual([
      [1, 'auth/uid-already-exists'],
      [2, 'auth/weak-password'],
    ]);

    const missing = await dispatch('auth_users', 'get', { uid: 'nobody' });
    expect(missing.ok).toBe(false);
    expect(missing.data).toEqual({ code: 'auth/user-not-found' });

    const updated = await dispatch('auth_users', 'update', { uid: 'carol', disabled: true, displayName: 'Carol' });
    expect(updated.ok).toBe(true);
    expect((updated.data as { user: UserView & { displayName: string } }).user).toMatchObject({
      disabled: true,
      displayName: 'Carol',
      claims: {},
    });
  });
});
