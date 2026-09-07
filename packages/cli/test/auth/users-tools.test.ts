/**
 * The eight `auth_*` user-administration tools against a real sandbox: one
 * happy path per tool, the argument validation each enforces, and the photo
 * policy #580 established (a federated provider id gets a generated photoUrl;
 * password and anonymous users stay null, and nothing on the way out strips
 * the field).
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as sandboxAuth } from 'pyric/auth';
import type { ToolHandler } from '@inbrowser/agent';
import { createAuthUsersTools, mintSandboxCustomToken } from '../../src/auth/users.js';

interface Result {
  ok: boolean;
  summary: string;
  data?: unknown;
}

const NAMES = [
  'auth_create_user',
  'auth_import_users',
  'auth_get_user',
  'auth_list_users',
  'auth_update_user',
  'auth_delete_user',
  'auth_set_claims',
  'auth_custom_token',
];

let sandbox: LocalSandbox;
let tools: Map<string, ToolHandler>;

const ctx = { signal: new AbortController().signal } as never;

function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return tools.get(name)!.execute(args, ctx) as Promise<Result>;
}

function user(result: Result): Record<string, unknown> {
  return (result.data as { user: Record<string, unknown> }).user;
}

beforeEach(() => {
  sandbox = initializeSandbox();
  const handlers = createAuthUsersTools({ resolveSandbox: () => sandbox });
  expect(handlers.map((handler) => handler.name)).toEqual(NAMES);
  tools = new Map(handlers.map((handler) => [handler.name, handler]));
});

describe('the user-administration tool surface', () => {
  it('is one tool per operation, with no op field and no lens word', () => {
    for (const name of NAMES) {
      const schema = tools.get(name)!.parameters as { properties: Record<string, unknown> };
      expect(schema.properties).not.toHaveProperty('op');
      expect(name).not.toContain('lens');
      expect(tools.get(name)!.description.toLowerCase()).not.toContain('lens');
    }
  });
});

describe('auth_create_user', () => {
  it('creates a user and returns the record without the password', async () => {
    const result = await call('auth_create_user', {
      
      uid: 'ada',
      email: 'ada@example.com',
      password: 'password123',
      displayName: 'Ada',
      claims: { role: 'admin' },
    });

    expect(result.ok).toBe(true);
    expect(user(result)).toMatchObject({
      uid: 'ada',
      email: 'ada@example.com',
      displayName: 'Ada',
      claims: { role: 'admin' },
      providers: ['password'],
      disabled: false,
    });
    expect(user(result)).not.toHaveProperty('password');
    expect(sandboxAuth.listUsers(getAuth(sandbox))).toHaveLength(1);
  });

  it('reports the sandbox auth code when the uid is taken', async () => {
    await call('auth_create_user', { uid: 'ada', email: 'ada@example.com' });
    const again = await call('auth_create_user', { uid: 'ada', email: 'other@example.com' });

    expect(again.ok).toBe(false);
    expect(again.data).toMatchObject({ code: 'auth/uid-already-exists' });
  });

  it('reports a password without an email as auth/invalid-email', async () => {
    const result = await call('auth_create_user', { uid: 'nomail', password: 'password123' });

    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ code: 'auth/invalid-email' });
  });

  it('keeps photoUrl null for a password user and mints one for a federated provider', async () => {
    const password = await call('auth_create_user', { uid: 'pw', email: 'pw@example.com', password: 'password123' });
    expect(user(password).photoUrl).toBeNull();

    const federated = await call('auth_create_user', {
      
      uid: 'goog',
      email: 'goog@example.com',
      providers: ['google.com'],
    });
    expect(user(federated).photoUrl).toBeTypeOf('string');
    expect(user(federated).photoUrl as string).toStartWith('data:image/svg+xml,');
    expect(user(federated).providers).toEqual(['google.com']);
  });
});

describe('auth_import_users', () => {
  it('creates each user in order and reports per-user failures', async () => {
    const result = await call('auth_import_users', {
      
      users: [
        { uid: 'a', email: 'a@example.com', password: 'password123' },
        { uid: 'a', email: 'b@example.com' },
        { email: 'c@example.com', providers: ['google.com'] },
      ],
    });

    expect(result.ok).toBe(false);
    const data = result.data as { created: string[]; errors: Array<Record<string, unknown>> };
    expect(data.created).toHaveLength(2);
    expect(data.created[0]).toBe('a');
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0]).toMatchObject({ index: 1, uid: 'a', code: 'auth/uid-already-exists' });
    expect(result.summary).toContain('1 failed');
  });

  it('rejects a non-array users argument and a user with no email', async () => {
    expect(await call('auth_import_users', { users: 'ada' })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });

    const noEmail = await call('auth_import_users', { users: [{ uid: 'x' }] });
    const errors = (noEmail.data as { errors: Array<{ code: string }> }).errors;
    expect(errors[0]!.code).toBe('auth/argument-error');
  });

  it('mints a photoUrl for each imported federated user', async () => {
    await call('auth_import_users', { users: [{ email: 'g@example.com', providers: ['google.com'] }] });
    const listed = await call('auth_list_users');
    const users = (listed.data as { users: Array<{ photoUrl: string | null }> }).users;

    expect(users[0]!.photoUrl).toStartWith('data:image/svg+xml,');
  });
});

describe('auth_get_user / auth_list_users', () => {
  beforeEach(async () => {
    await call('auth_create_user', { uid: 'ada', email: 'Ada@Example.com', password: 'password123' });
    await call('auth_create_user', { uid: 'bob', email: 'bob@example.com', password: 'password123' });
  });

  it('gets by uid and by email, case-insensitively', async () => {
    expect(user(await call('auth_get_user', { uid: 'ada' })).uid).toBe('ada');
    expect(user(await call('auth_get_user', { email: 'ada@example.com' })).uid).toBe('ada');
  });

  it('requires uid or email and reports a miss as auth/user-not-found', async () => {
    expect(await call('auth_get_user')).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call('auth_get_user', { uid: 'nobody' })).toMatchObject({
      ok: false,
      data: { code: 'auth/user-not-found' },
    });
  });

  it('lists every user and honours limit', async () => {
    const all = await call('auth_list_users');
    expect((all.data as { total: number }).total).toBe(2);
    expect((all.data as { users: unknown[] }).users).toHaveLength(2);

    const one = await call('auth_list_users', { limit: 1 });
    expect((one.data as { users: unknown[] }).users).toHaveLength(1);
    expect((one.data as { total: number }).total).toBe(2);
  });

  it('rejects a non-numeric or negative limit', async () => {
    expect(await call('auth_list_users', { limit: 'two' })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call('auth_list_users', { limit: -1 })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
  });
});

describe('auth_update_user / auth_delete_user', () => {
  beforeEach(async () => {
    await call('auth_create_user', { uid: 'ada', email: 'ada@example.com', password: 'password123' });
  });

  it('updates only the supplied fields', async () => {
    const result = await call('auth_update_user', { uid: 'ada', displayName: 'Ada L', disabled: true });

    expect(result.ok).toBe(true);
    expect(user(result)).toMatchObject({
      uid: 'ada',
      email: 'ada@example.com',
      displayName: 'Ada L',
      disabled: true,
    });
  });

  it('requires a uid and reports an unknown user', async () => {
    expect(await call('auth_update_user')).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call('auth_update_user', { uid: 'nobody', displayName: 'x' })).toMatchObject({
      ok: false,
      data: { code: 'auth/user-not-found' },
    });
  });

  it('deletes a user and reports a second delete as not found', async () => {
    expect(await call('auth_delete_user', { uid: 'ada' })).toMatchObject({ ok: true, data: { uid: 'ada' } });
    expect(sandboxAuth.listUsers(getAuth(sandbox))).toHaveLength(0);
    expect(await call('auth_delete_user', { uid: 'ada' })).toMatchObject({
      ok: false,
      data: { code: 'auth/user-not-found' },
    });
    expect(await call('auth_delete_user')).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
  });
});

describe('auth_set_claims', () => {
  beforeEach(async () => {
    await call('auth_create_user', { uid: 'ada', email: 'ada@example.com', password: 'password123' });
  });

  it('replaces the whole claims map and clears with an empty object', async () => {
    const set = await call('auth_set_claims', { uid: 'ada', claims: { role: 'editor', tier: 2 } });
    expect(user(set).claims).toEqual({ role: 'editor', tier: 2 });

    const replaced = await call('auth_set_claims', { uid: 'ada', claims: { role: 'viewer' } });
    expect(user(replaced).claims).toEqual({ role: 'viewer' });

    const cleared = await call('auth_set_claims', { uid: 'ada', claims: {} });
    expect(user(cleared).claims).toEqual({});
  });

  it('requires a uid and an object of claims', async () => {
    expect(await call('auth_set_claims', { claims: {} })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call('auth_set_claims', { uid: 'ada' })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call('auth_set_claims', { uid: 'ada', claims: ['role'] })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
  });
});

describe('auth_custom_token', () => {
  it('mints a token the sandbox decodes back to uid and claims', async () => {
    const result = await call('auth_custom_token', { uid: 'ada', claims: { role: 'admin' } });

    expect(result.ok).toBe(true);
    const data = result.data as { uid: string; claims: unknown; token: string };
    expect(data.uid).toBe('ada');
    expect(data.claims).toEqual({ role: 'admin' });
    expect(data.token).toBe(mintSandboxCustomToken('ada', { role: 'admin' }));
    expect(JSON.parse(atob(data.token.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
      uid: 'ada',
      claims: { role: 'admin' },
    });
  });

  it('mints without claims and rejects a missing uid or non-object claims', async () => {
    const bare = await call('auth_custom_token', { uid: 'ada' });
    expect((bare.data as { claims: unknown }).claims).toEqual({});

    expect(await call('auth_custom_token')).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
    expect(await call('auth_custom_token', { uid: 'ada', claims: 'role' })).toMatchObject({
      ok: false,
      data: { code: 'auth/argument-error' },
    });
  });
});
