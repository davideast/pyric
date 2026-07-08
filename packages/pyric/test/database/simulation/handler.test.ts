import { describe, test, expect } from 'bun:test';
import { SimulateHandler } from '../../../src/database/simulation/handler.js';
import type { RtdbIR, RtdbNode } from '../../../src/database/types.js';

function makeIR(readRule: string): RtdbIR {
  const rootNode: RtdbNode = {
    path: '/',
    pathVariables: [],
    exists: true,
    read: {
      raw: readRule,
      parsed: {
        raw: readRule,
        valid: true,
        errors: [],
        warnings: [],
        referencedIdentifiers: ['auth'],
      },
    },
    children: [],
  };
  return {
    service: 'realtime-database',
    databaseUrl: 'https://test-default-rtdb.firebaseio.com',
    rules: rootNode,
  };
}

describe('SimulateHandler', () => {
  const handler = new SimulateHandler();

  test('returns IR_NOT_GENERATED when ir is null', () => {
    const result = handler.execute(null, {
      operation: 'read',
      path: '/',
      auth: null,
      mockData: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('IR_NOT_GENERATED');
      expect(result.error.recoverable).toBe(true);
    }
  });

  test('returns INVALID_INPUT for invalid input shape', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, { operation: 'DELETE', path: '/', auth: null, mockData: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
  });

  test('returns allowed=true when auth matches rule', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/',
      auth: { uid: 'user123', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
    }
  });

  test('returns allowed=false when auth is null and rule requires auth', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/',
      auth: null,
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(false);
    }
  });

  test('returns matchedPath and matchedRule in result', () => {
    const ir = makeIR('auth !== null');
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/',
      auth: { uid: 'abc', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.matchedPath).toBe('/');
      expect(result.data.matchedRule).toBe('auth !== null');
    }
  });

  test('parent read rule cascades to child path', () => {
    const expr = (raw: string) => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const ir: RtdbIR = {
      service: 'realtime-database',
      databaseUrl: 'https://test.firebaseio.com',
      rules: {
        path: '/',
        pathVariables: [],
        exists: true,
        read: expr('false'),
        children: [
          {
            path: '/posts',
            pathVariables: [],
            exists: true,
            read: expr('true'),
            children: [
              {
                path: '/posts/$postId',
                pathVariables: ['$postId'],
                exists: false,
                // No read rule on $postId itself
                children: [
                  {
                    path: '/posts/$postId/likes',
                    pathVariables: ['$postId'],
                    exists: false,
                    // No read rule on likes either
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    // /posts has .read: true — this should cascade to /posts/post1/likes
    const result = handler.execute(ir, {
      operation: 'read',
      path: '/posts/post1/likes',
      auth: null,
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
      expect(result.data.matchedPath).toBe('/posts');
      expect(result.data.matchedRule).toBe('true');
    }
  });

  test('root write rule cascades to deep child', () => {
    const expr = (raw: string) => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const ir: RtdbIR = {
      service: 'realtime-database',
      databaseUrl: 'https://test.firebaseio.com',
      rules: {
        path: '/',
        pathVariables: [],
        exists: true,
        write: expr('auth !== null'),
        children: [
          {
            path: '/data',
            pathVariables: [],
            exists: true,
            children: [],
          },
        ],
      },
    };

    const result = handler.execute(ir, {
      operation: 'write',
      path: '/data',
      auth: { uid: 'user1', token: {} },
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
      expect(result.data.matchedPath).toBe('/');
    }
  });
});

// ── .validate enforcement on the write path (non-cascading) ────────────
//
// RTDB enforces `.validate` on the post-write value at the write location
// and every descendant present in that value. Unlike `.read`/`.write`,
// `.validate` does NOT cascade — ALL applicable rules must pass. Mirrors
// the oracle divergence `r4-validate-structure` (a `.write`-granted write
// that a deeper `.validate` rejects).
describe('SimulateHandler — .validate (write path)', () => {
  const handler = new SimulateHandler();

  const expr = (raw: string, valid = true): RtdbNode['validate'] => ({
    raw,
    parsed: { raw, valid, errors: [], warnings: [], referencedIdentifiers: [] },
  });

  const node = (partial: Partial<RtdbNode> & { path: string }): RtdbNode => ({
    pathVariables: [],
    exists: true,
    children: [],
    ...partial,
  });

  const ir = (rules: RtdbNode): RtdbIR => ({
    service: 'realtime-database',
    databaseUrl: 'https://test.firebaseio.com',
    rules,
  });

  const authed = { uid: 'alice', token: {} };

  // A node-level `.validate` at the write location, granted by `.write`.
  const structureIR = ir(
    node({
      path: '/',
      write: expr('auth !== null'),
      children: [
        node({
          path: '/entry',
          validate: expr("newData.hasChildren(['title', 'body'])"),
        }),
      ],
    }),
  );

  test('denies a write whose value fails a node-level .validate', () => {
    const result = handler.execute(structureIR, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { title: 't' }, // missing `body`
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(false);
      expect(result.data.matchedPath).toBe('/entry');
      expect(result.data.matchedRule).toBe("newData.hasChildren(['title', 'body'])");
    }
  });

  test('allows a write whose value satisfies the .validate', () => {
    const result = handler.execute(structureIR, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { title: 't', body: 'b' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowed).toBe(true);
  });

  test('.validate does not cascade-grant: a granting .write cannot rescue a failing .validate', () => {
    // The `.write` at root grants; the `.validate` at `/entry` still denies.
    const result = handler.execute(structureIR, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { onlyThis: 1 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowed).toBe(false);
  });

  test('reads ignore .validate entirely', () => {
    const readIR = ir(
      node({
        path: '/',
        read: expr('true'),
        children: [node({ path: '/entry', validate: expr('false') })],
      }),
    );
    const result = handler.execute(readIR, {
      operation: 'read',
      path: '/entry',
      auth: authed,
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowed).toBe(true);
  });

  test('enforces a descendant .validate below the write location', () => {
    const descendantIR = ir(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [
          node({
            path: '/room',
            children: [node({ path: '/room/name', validate: expr('newData.isString()') })],
          }),
        ],
      }),
    );
    const denied = handler.execute(descendantIR, {
      operation: 'write',
      path: '/room',
      auth: authed,
      mockData: {},
      newData: { name: 123 }, // not a string
    });
    expect(denied.success && denied.data.allowed).toBe(false);

    const allowed = handler.execute(descendantIR, {
      operation: 'write',
      path: '/room',
      auth: authed,
      mockData: {},
      newData: { name: 'lobby' },
    });
    expect(allowed.success && allowed.data.allowed).toBe(true);
  });

  test('binds a $pathVar when validating each child of the written value', () => {
    const pathVarIR = ir(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [
          node({
            path: '/users',
            children: [
              node({
                path: '/users/$uid',
                pathVariables: ['$uid'],
                children: [
                  node({ path: '/users/$uid/age', pathVariables: ['$uid'], validate: expr('newData.isNumber()') }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
    const denied = handler.execute(pathVarIR, {
      operation: 'write',
      path: '/users',
      auth: authed,
      mockData: {},
      newData: { alice: { age: 'old' } },
    });
    expect(denied.success && denied.data.allowed).toBe(false);

    const allowed = handler.execute(pathVarIR, {
      operation: 'write',
      path: '/users',
      auth: authed,
      mockData: {},
      newData: { alice: { age: 30 } },
    });
    expect(allowed.success && allowed.data.allowed).toBe(true);
  });

  test('a delete (null newData) is not validated', () => {
    const result = handler.execute(structureIR, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: { entry: { title: 't', body: 'b' } },
      newData: null,
    });
    expect(result.success && result.data.allowed).toBe(true);
  });

  test('an ancestor .validate above the write location does not run on a deeper write', () => {
    // Writing `/doc/extra` must NOT trigger `/doc`'s `.validate` (RTDB
    // validation runs at/below the write location, not on ancestors).
    const ancestorIR = ir(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [node({ path: '/doc', validate: expr("newData.hasChildren(['title'])") })],
      }),
    );
    const result = handler.execute(ancestorIR, {
      operation: 'write',
      path: '/doc/extra',
      auth: authed,
      mockData: {},
      newData: 5,
    });
    expect(result.success && result.data.allowed).toBe(true);
  });

  test('an unparseable .validate is skipped, never denied', () => {
    // A `.validate` the grammar can't reason about must not flip a
    // prod-legal write into a sandbox denial (the reverse-divergence trap).
    const badIR = ir(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [node({ path: '/entry', validate: expr('!! not parseable @@', false) })],
      }),
    );
    const result = handler.execute(badIR, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { anything: 1 },
    });
    expect(result.success && result.data.allowed).toBe(true);
  });
});
