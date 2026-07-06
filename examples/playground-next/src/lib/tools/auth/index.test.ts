/** B3.2 — sandbox auth user-admin tools, headless against the real
 *  runner sandbox (same as the file/seed tool tests). */
import { describe, expect, test } from 'bun:test';
import { inspectAuthUsersHandler, seedAuthUsersHandler, AUTH_TOOLS } from './index';

interface SeedData {
  created: string[];
  failed: number;
  errors?: Array<{ index: number; error: string }>;
  code?: string;
}
interface InspectData {
  count: number;
  users: Array<{ uid: string; customClaims: Record<string, unknown>; disabled: boolean }>;
}

describe('seed_auth_users + inspect_auth_users', () => {
  test('seeded identities (incl. claims) round-trip through inspect', async () => {
    const seed = await seedAuthUsersHandler.execute(
      {
        users: [
          { uid: 'b3-admin', email: 'admin@example.com', customClaims: { admin: true } },
          { uid: 'b3-alice', email: 'alice@example.com' },
        ],
      },
      {} as never,
    );
    expect(seed.ok).toBe(true);
    expect((seed.data as SeedData).created).toEqual(['b3-admin', 'b3-alice']);

    const inspect = await inspectAuthUsersHandler.execute({} as never, {} as never);
    expect(inspect.ok).toBe(true);
    const data = inspect.data as InspectData;
    const admin = data.users.find((u) => u.uid === 'b3-admin');
    expect(admin?.customClaims).toEqual({ admin: true });
    expect(data.users.some((u) => u.uid === 'b3-alice')).toBe(true);
  });

  test('duplicate uid lands in errors[] without aborting the batch', async () => {
    const r = await seedAuthUsersHandler.execute(
      { users: [{ uid: 'b3-dup' }, { uid: 'b3-dup' }, { uid: 'b3-third' }] },
      {} as never,
    );
    expect(r.ok).toBe(true);
    const d = r.data as SeedData;
    expect(d.created).toContain('b3-third');
    expect(d.failed).toBe(1);
    expect(d.errors?.[0]?.index).toBe(1);
  });

  test('over-cap call is rejected whole, never truncated', async () => {
    const users = Array.from({ length: 101 }, (_, i) => ({ uid: `cap-${i}` }));
    const r = await seedAuthUsersHandler.execute({ users }, {} as never);
    expect(r.ok).toBe(false);
    expect((r.data as SeedData).code).toBe('TOO_MANY_USERS');
    const inspect = await inspectAuthUsersHandler.execute({} as never, {} as never);
    expect((inspect.data as InspectData).users.some((u) => u.uid.startsWith('cap-'))).toBe(false);
  });

  test('registry group exposes exactly the two tools, inspect parallel-safe', () => {
    expect(AUTH_TOOLS.map((t) => t.name)).toEqual(['inspect_auth_users', 'seed_auth_users']);
    expect(
      (inspectAuthUsersHandler as { parallelSafe?: boolean }).parallelSafe,
    ).toBe(true);
  });
});
