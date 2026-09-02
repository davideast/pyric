import { describe, expect, test } from 'bun:test';
import type { ToolHandler } from '@inbrowser/agent';
import {
  createDatabaseDataTools,
  getAdminDatabase,
  getDatabase,
  type DatabaseAs,
} from 'pyric/database';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules, snapshotState } from 'pyric/sandbox/database';

const RULES = {
  rules: {
    users: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
        '.write': 'auth != null && auth.uid === $uid',
        '.validate': "newData.hasChildren(['name'])",
      },
    },
    scores: { '.read': true, '.write': "auth != null && auth.token.role === 'editor'" },
    counters: { '.read': true, '.write': true },
  },
};

function harness(sandbox: LocalSandbox) {
  const tools = createDatabaseDataTools({
    resolveDatabase: (actor?: DatabaseAs) =>
      actor && actor !== 'admin'
        ? getDatabase(sandbox.withAuth({ uid: actor.uid, token: actor.claims }))
        : getAdminDatabase(sandbox),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const ctx = { signal: new AbortController().signal } as never;
  return {
    names: tools.map((tool) => tool.name),
    call: (name: string, args: Record<string, unknown>) => {
      const handler = byName.get(name) as ToolHandler;
      return handler.execute(args, ctx);
    },
  };
}

describe('createDatabaseDataTools', () => {
  test('yields the eight data-plane handlers', () => {
    const { names } = harness(initializeSandbox());
    expect(names).toEqual([
      'database_get',
      'database_set',
      'database_update',
      'database_remove',
      'database_push',
      'database_transaction',
      'database_query',
      'database_seed',
    ]);
  });

  test('seed replaces the tree as admin and get reads it back', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, RULES);
    const { call } = harness(sandbox);

    const seeded = await call('database_seed', {
      value: { users: { alice: { name: 'Alice' } }, counters: { hits: 1 } },
    });
    expect(seeded.ok).toBe(true);
    expect(snapshotState(sandbox)).toEqual({
      users: { alice: { name: 'Alice' } },
      counters: { hits: 1 },
    });

    const got = await call('database_get', { path: '/users/alice' });
    expect(got.data).toEqual({ exists: true, value: { name: 'Alice' } });

    const missing = await call('database_get', { path: '/users/nobody' });
    expect(missing.data).toEqual({ exists: false, value: null });

    await call('database_seed', { path: '/scores', value: { a: 1 } });
    expect(snapshotState(sandbox)).toEqual({ scores: { a: 1 } });
  });

  test('a user write is rules-enforced and an admin write bypasses rules', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, RULES);
    const { call } = harness(sandbox);

    const own = await call('database_set', {
      path: '/users/alice',
      value: { name: 'Alice' },
      as: { uid: 'alice' },
    });
    expect(own.ok).toBe(true);

    await expect(
      call('database_set', { path: '/users/alice', value: { name: 'Mallory' }, as: { uid: 'bob' } }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      call('database_get', { path: '/users/alice', as: { uid: 'bob' } }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(
      call('database_set', { path: '/users/alice', value: { nickname: 'Al' }, as: { uid: 'alice' } }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const claimed = await call('database_set', {
      path: '/scores/alice',
      value: 10,
      as: { uid: 'alice', claims: { role: 'editor' } },
    });
    expect(claimed.ok).toBe(true);

    await expect(
      call('database_set', { path: '/scores/bob', value: 5, as: { uid: 'bob' } }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const admin = await call('database_set', { path: '/users/bob', value: { name: 'Bob' }, as: 'admin' });
    expect(admin.ok).toBe(true);
    expect(snapshotState(sandbox)).toMatchObject({ users: { bob: { name: 'Bob' } } });
  });

  test('update writes a multi-path map atomically and remove deletes a subtree', async () => {
    const sandbox = initializeSandbox();
    const { call } = harness(sandbox);
    await call('database_seed', { value: { posts: { p1: { title: 'One' } }, feeds: { u1: {} } } });

    const updated = await call('database_update', {
      path: '/',
      values: { 'posts/p1/title': 'First', 'feeds/u1/p1': true, 'posts/p2': { title: 'Two' } },
    });
    expect(updated.summary).toBe('Updated 3 paths under /');
    expect(snapshotState(sandbox)).toEqual({
      posts: { p1: { title: 'First' }, p2: { title: 'Two' } },
      feeds: { u1: { p1: true } },
    });

    const removed = await call('database_remove', { path: '/posts/p2' });
    expect(removed.ok).toBe(true);
    expect(snapshotState(sandbox)).toEqual({
      posts: { p1: { title: 'First' } },
      feeds: { u1: { p1: true } },
    });
  });

  test('push mints a key and returns the child path', async () => {
    const sandbox = initializeSandbox();
    const { call } = harness(sandbox);

    const pushed = await call('database_push', { path: '/messages', value: { body: 'hi' } });
    const { key, path } = pushed.data as { key: string; path: string };
    expect(key).toMatch(/^-[A-Za-z0-9_-]{19}$/);
    expect(path).toBe(`/messages/${key}`);
    expect(snapshotState(sandbox)).toEqual({ messages: { [key]: { body: 'hi' } } });

    const minted = await call('database_push', { path: '/messages' });
    expect((minted.data as { key: string }).key).not.toBe(key);
    expect(snapshotState(sandbox)).toEqual({ messages: { [key]: { body: 'hi' } } });
  });

  test('set, update, and push resolve the timestamp and increment sentinels', async () => {
    const sandbox = initializeSandbox();
    const { call } = harness(sandbox);
    const before = Date.now();

    await call('database_set', { path: '/counters', value: { hits: { '.sv': { increment: 2 } }, at: { '.sv': 'timestamp' } } });
    await call('database_update', { path: '/counters', values: { hits: { '.sv': { increment: 3 } } } });
    const pushed = await call('database_push', { path: '/events', value: { at: { '.sv': 'timestamp' } } });
    const key = (pushed.data as { key: string }).key;

    const state = snapshotState(sandbox) as { counters: { hits: number; at: number }; events: Record<string, { at: number }> };
    expect(state.counters.hits).toBe(5);
    expect(state.counters.at).toBeGreaterThanOrEqual(before);
    expect(state.events[key]!.at).toBeGreaterThanOrEqual(before);
  });

  test('transaction is a compare-and-set that aborts and returns the current value on mismatch', async () => {
    const sandbox = initializeSandbox();
    const { call } = harness(sandbox);
    await call('database_seed', { value: { counters: { hits: 1 } } });

    const aborted = await call('database_transaction', { path: '/counters/hits', value: 2, expect: 7 });
    expect(aborted.ok).toBe(true);
    expect(aborted.data).toEqual({ committed: false, value: 1 });
    expect(snapshotState(sandbox)).toEqual({ counters: { hits: 1 } });

    const committed = await call('database_transaction', { path: '/counters/hits', value: 2, expect: 1 });
    expect(committed.data).toEqual({ committed: true, value: 2 });

    const absent = await call('database_transaction', { path: '/counters/misses', value: 1, expect: null });
    expect(absent.data).toEqual({ committed: true, value: 1 });

    const unconditional = await call('database_transaction', { path: '/counters/hits', value: 9 });
    expect(unconditional.data).toEqual({ committed: true, value: 9 });
  });

  test('query orders children and applies the window', async () => {
    const sandbox = initializeSandbox();
    const { call } = harness(sandbox);
    await call('database_seed', {
      value: {
        players: {
          a: { name: 'Ann', score: 30 },
          b: { name: 'Ben', score: 10 },
          c: { name: 'Cy', score: 20 },
        },
      },
    });

    const first = await call('database_query', {
      path: '/players',
      orderBy: 'child',
      childKey: 'score',
      limitToFirst: 2,
    });
    expect(first.data).toEqual({
      count: 2,
      rows: [
        { key: 'b', value: { name: 'Ben', score: 10 } },
        { key: 'c', value: { name: 'Cy', score: 20 } },
      ],
    });

    const last = await call('database_query', { path: '/players', orderBy: 'key', limitToLast: 1 });
    expect((last.data as { rows: Array<{ key: string }> }).rows.map((row) => row.key)).toEqual(['c']);

    const equal = await call('database_query', {
      path: '/players',
      orderBy: 'child',
      childKey: 'score',
      equalTo: 20,
    });
    expect((equal.data as { rows: Array<{ key: string }> }).rows.map((row) => row.key)).toEqual(['c']);

    const bounded = await call('database_query', {
      path: '/players',
      orderBy: 'child',
      childKey: 'score',
      startAfter: 10,
      endAt: 30,
    });
    expect((bounded.data as { rows: Array<{ key: string }> }).rows.map((row) => row.key)).toEqual(['c', 'a']);

    await expect(call('database_query', { path: '/players', orderBy: 'child' })).rejects.toThrow(
      "orderBy 'child' requires childKey",
    );
  });
});
