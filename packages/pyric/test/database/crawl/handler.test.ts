import { describe, test, expect, afterEach } from 'bun:test';
import { CrawlStructureHandler } from '../../../src/database/crawl/handler.js';
import type { RtdbHost } from '../../../src/database/host.js';

const DATABASE_URL = 'https://test-db.firebaseio.com';

const HOST: RtdbHost = {
  projectId: 'test-project',
  databaseUrl: DATABASE_URL,
  resolveAdminToken: async () => 'mock-token',
  resolveUserToken: async () => 'mock-user-token',
  getClientForUser: async () => { throw new Error('not implemented'); },
};

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

/** Stub fetch with per-path responses. Maps URL → JSON path (strip
 *  databaseUrl prefix and the `?…` querystring + the trailing `.json`)
 *  and looks up the configured response. 'FORBIDDEN' → 403;
 *  undefined → 200 null. */
function stubRoutes(pathResponses: Record<string, unknown>): void {
  (global as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
    const urlStr = input.toString();
    const cleanPath = urlStr.split('?')[0].replace(DATABASE_URL, '').replace(/\.json$/, '');
    const data = pathResponses[cleanPath];
    if (data === 'FORBIDDEN') {
      return new Response('Permission denied', { status: 403 });
    }
    if (data === undefined) {
      return new Response('null', { status: 200 });
    }
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch;
}

describe('CrawlStructureHandler', () => {
  const handler = new CrawlStructureHandler();

  test('empty database returns success with leaf node', async () => {
    stubRoutes({ '/': null });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/');
      expect(result.data.childCount).toBe(0);
      expect(result.data.truncated).toBe(false);
      expect(result.data.children).toHaveLength(0);
    }
  });

  test('single-level object returns children', async () => {
    stubRoutes({
      '/': { users: true, posts: true },
      '/users': null,
      '/posts': null,
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.childCount).toBe(2);
      expect(result.data.children).toHaveLength(2);
      expect(result.data.children.map((c) => c.path).sort()).toEqual(['/posts', '/users']);
    }
  });

  test('leaf values are not recursed', async () => {
    stubRoutes({
      '/': { users: true, version: 'v1', count: 42 },
      '/users': null,
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.childCount).toBe(3);
      expect(result.data.children).toHaveLength(1);
      expect(result.data.children[0].path).toBe('/users');
    }
  });

  test('maxDepth stops recursion', async () => {
    stubRoutes({
      '/': { a: true },
      '/a': { b: true },
      '/a/b': { c: true },
    });
    const result = await handler.execute(HOST, { maxDepth: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.children).toHaveLength(1);
      expect(result.data.children[0].childCount).toBe(1);
      expect(result.data.children[0].children).toHaveLength(0);
    }
  });

  test('maxChildren truncation', async () => {
    stubRoutes({
      '/': { a: true, b: true, c: true },
      '/a': null,
      '/b': null,
    });
    const result = await handler.execute(HOST, { maxChildren: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.childCount).toBe(3);
      expect(result.data.truncated).toBe(true);
      expect(result.data.children.length).toBeLessThanOrEqual(2);
    }
  });

  test('403 at root returns PERMISSION_DENIED', async () => {
    stubRoutes({ '/': 'FORBIDDEN' });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.recoverable).toBe(false);
    }
  });

  test('403 at child returns empty node gracefully', async () => {
    stubRoutes({
      '/': { secret: true, public: true },
      '/secret': 'FORBIDDEN',
      '/public': null,
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.children).toHaveLength(2);
      const secret = result.data.children.find((c) => c.path === '/secret');
      expect(secret?.childCount).toBe(0);
    }
  });

  test('network error at child returns empty node', async () => {
    (global as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
      const path = input.toString().split('?')[0].replace(DATABASE_URL, '');
      if (path === '/.json') {
        return new Response(JSON.stringify({ a: true }), { status: 200 });
      }
      throw new Error('Network failure');
    }) as typeof fetch;

    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.children).toHaveLength(1);
      expect(result.data.children[0].childCount).toBe(0);
    }
  });

  test('concurrency is respected', async () => {
    let active = 0;
    let maxActive = 0;
    const responses: Record<string, unknown> = {
      '/': { a: true, b: true, c: true, d: true, e: true },
    };
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      responses[`/${k}`] = null;
    }

    (global as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      const cleanPath = input.toString().split('?')[0].replace(DATABASE_URL, '').replace(/\.json$/, '');
      const data = responses[cleanPath] ?? null;
      return new Response(JSON.stringify(data), { status: 200 });
    }) as typeof fetch;

    await handler.execute(HOST, { maxConcurrency: 2 });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test('deep 3-level tree builds correct nested structure', async () => {
    stubRoutes({
      '/': { users: true },
      '/users': { alice: true, bob: true },
      '/users/alice': { name: 'Alice', age: 30 },
      '/users/bob': { name: 'Bob' },
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/');
      expect(result.data.children).toHaveLength(1);
      const users = result.data.children[0];
      expect(users.path).toBe('/users');
      expect(users.children).toHaveLength(2);
      expect(users.children[0].children).toHaveLength(0);
      expect(users.children[1].children).toHaveLength(0);
    }
  });

  test('schema has empty object for null/empty database', async () => {
    stubRoutes({ '/': null });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema).toEqual({});
    }
  });

  test('schema infers types from leaf primitive values', async () => {
    stubRoutes({
      '/': { version: 1, mode: false, name: 'test', empty: null },
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema).toEqual({
        version: 'number',
        mode: 'boolean',
        name: 'string',
        empty: 'null',
      });
      expect(result.data.children).toHaveLength(0);
    }
  });

  test('schema excludes object children (value === true)', async () => {
    stubRoutes({
      '/': { users: true, count: 42 },
      '/users': null,
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema).toEqual({ count: 'number' });
      expect(result.data.children).toHaveLength(1);
      expect(result.data.children[0].path).toBe('/users');
    }
  });

  test('nested nodes have their own schema', async () => {
    stubRoutes({
      '/': { users: true },
      '/users': { alice: true },
      '/users/alice': { name: 'Alice', role: 'admin' },
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      const alice = result.data.children[0].children[0];
      expect(alice.schema).toEqual({ name: 'string', role: 'string' });
    }
  });

  test('schema populated from children that are leaf primitives (real RTDB shallow behavior)', async () => {
    stubRoutes({
      '/': { users: true },
      '/users': { alice: true },
      '/users/alice': { name: true, role: true },
      '/users/alice/name': 'Alice',
      '/users/alice/role': 'admin',
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      const alice = result.data.children[0].children[0];
      expect(alice.schema).toEqual({ name: 'string', role: 'string' });
    }
  });

  test('leaf primitive node has valueType set', async () => {
    stubRoutes({
      '/': { count: true },
      '/count': 42,
    });
    const result = await handler.execute(HOST);
    expect(result.success).toBe(true);
    if (result.success) {
      const count = result.data.children[0];
      expect(count.valueType).toBe('number');
    }
  });
});
