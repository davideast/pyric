import { describe, test, expect } from 'bun:test';
import { SimulateHandler } from '../../../../src/rules/rtdb/simulation/handler.js';
import type { RtdbNode } from '../../../../src/rules/rtdb/types.js';

function makeRules(readRule: string): RtdbNode {
  const rootNode: RtdbNode = {
    path: '/',
    pathVariables: [],
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
  return rootNode;
}

describe('SimulateHandler', () => {
  const handler = new SimulateHandler();

  test('returns INVALID_INPUT for invalid input shape', () => {
    const compiled = makeRules('auth !== null');
    const result = handler.execute(compiled, { operation: 'DELETE', path: '/', auth: null, mockData: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
  });

  test('returns allowed=true when auth matches rule', () => {
    const compiled = makeRules('auth !== null');
    const result = handler.execute(compiled, {
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
    const compiled = makeRules('auth !== null');
    const result = handler.execute(compiled, {
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
    const compiled = makeRules('auth !== null');
    const result = handler.execute(compiled, {
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
    const compiled: RtdbNode = {
        path: '/',
        pathVariables: [],
        read: expr('false'),
        children: [
          {
            path: '/posts',
            pathVariables: [],
            read: expr('true'),
            children: [
              {
                path: '/posts/$postId',
                pathVariables: ['$postId'],
                // No read rule on $postId itself
                children: [
                  {
                    path: '/posts/$postId/likes',
                    pathVariables: ['$postId'],
                    // No read rule on likes either
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
    };

    // /posts has .read: true — this should cascade to /posts/post1/likes
    const result = handler.execute(compiled, {
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
    const compiled: RtdbNode = {
        path: '/',
        pathVariables: [],
        write: expr('auth !== null'),
        children: [
          {
            path: '/data',
            pathVariables: [],
            children: [],
          },
        ],
    };

    const result = handler.execute(compiled, {
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

  test('an unparseable .write rule is reported unsupported, not silently skipped', () => {
    // An ancestor `.write` the grammar can't parse must not be treated as
    // "no rule here" — production would still evaluate it and might grant
    // on it. No other ancestor grants, so this must surface as a reported
    // gap rather than a fabricated deny.
    const expr = (raw: string, valid = true) => ({
      raw,
      parsed: { raw, valid, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const badWriteRules: RtdbNode = {
        path: '/',
        pathVariables: [],
        write: expr('!! not parseable @@', false),
        children: [{ path: '/data', pathVariables: [], children: [] }],
    };
    const result = handler.execute(badWriteRules, {
      operation: 'write',
      path: '/data',
      auth: { uid: 'user1', token: {} },
      mockData: {},
      newData: 1,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(false);
      expect(result.data.unsupported).toBe(true);
      expect(result.data.matchedPath).toBe('/');
      expect(result.data.reason).toContain('!! not parseable @@');
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
    children: [],
    ...partial,
  });

  const compiled = (rules: RtdbNode): RtdbNode => rules;

  const authed = { uid: 'alice', token: {} };

  // A node-level `.validate` at the write location, granted by `.write`.
  const structureRules = compiled(
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
    const result = handler.execute(structureRules, {
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
    const result = handler.execute(structureRules, {
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
    const result = handler.execute(structureRules, {
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
    const readRules = compiled(
      node({
        path: '/',
        read: expr('true'),
        children: [node({ path: '/entry', validate: expr('false') })],
      }),
    );
    const result = handler.execute(readRules, {
      operation: 'read',
      path: '/entry',
      auth: authed,
      mockData: {},
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowed).toBe(true);
  });

  test('enforces a descendant .validate below the write location', () => {
    const descendantRules = compiled(
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
    const denied = handler.execute(descendantRules, {
      operation: 'write',
      path: '/room',
      auth: authed,
      mockData: {},
      newData: { name: 123 }, // not a string
    });
    expect(denied.success && denied.data.allowed).toBe(false);

    const allowed = handler.execute(descendantRules, {
      operation: 'write',
      path: '/room',
      auth: authed,
      mockData: {},
      newData: { name: 'lobby' },
    });
    expect(allowed.success && allowed.data.allowed).toBe(true);
  });

  test('binds a $pathVar when validating each child of the written value', () => {
    const pathVarRules = compiled(
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
    const denied = handler.execute(pathVarRules, {
      operation: 'write',
      path: '/users',
      auth: authed,
      mockData: {},
      newData: { alice: { age: 'old' } },
    });
    expect(denied.success && denied.data.allowed).toBe(false);

    const allowed = handler.execute(pathVarRules, {
      operation: 'write',
      path: '/users',
      auth: authed,
      mockData: {},
      newData: { alice: { age: 30 } },
    });
    expect(allowed.success && allowed.data.allowed).toBe(true);
  });

  test('a delete (null newData) is not validated', () => {
    const result = handler.execute(structureRules, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: { entry: { title: 't', body: 'b' } },
      newData: null,
    });
    expect(result.success && result.data.allowed).toBe(true);
  });

  test('an ancestor .validate runs against its merged value on a deeper write', () => {
    // Production evaluates `/doc`'s rule against `{extra: 5}` and denies
    // because the merged ancestor value still lacks `title`.
    const ancestorRules = compiled(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [node({ path: '/doc', validate: expr("newData.hasChildren(['title'])") })],
      }),
    );
    const result = handler.execute(ancestorRules, {
      operation: 'write',
      path: '/doc/extra',
      auth: authed,
      mockData: {},
      newData: 5,
    });
    expect(result.success && result.data.allowed).toBe(false);
    if (result.success) {
      expect(result.data.matchedPath).toBe('/doc');
      expect(result.data.matchedRule).toBe("newData.hasChildren(['title'])");
    }
  });

  test('an unparseable .validate is reported unsupported, not silently passed', () => {
    // A `.validate` the grammar can't reason about must not flip a
    // prod-legal write into a fabricated sandbox denial, and it must not
    // silently pass either — production would still evaluate it and may
    // reject the write. It is a reported simulator gap: `allowed: false`,
    // `unsupported: true`, naming the rule path and the construct.
    const badRules = compiled(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [node({ path: '/entry', validate: expr('!! not parseable @@', false) })],
      }),
    );
    const result = handler.execute(badRules, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { anything: 1 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(false);
      expect(result.data.unsupported).toBe(true);
      expect(result.data.matchedPath).toBe('/entry');
      expect(result.data.reason).toContain('/entry');
      expect(result.data.reason).toContain('!! not parseable @@');
    }
  });

  test('a real deny elsewhere still wins over an unsupported .validate', () => {
    // AND-semantics: a confirmed failing .validate is stronger evidence
    // than an abstention, so it must be reported (not masked by the gap).
    const mixedRules = compiled(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [
          node({
            path: '/entry',
            children: [
              node({ path: '/entry/a', validate: expr('!! not parseable @@', false) }),
              node({ path: '/entry/b', validate: expr('newData.isString()') }),
            ],
          }),
        ],
      }),
    );
    const result = handler.execute(mixedRules, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { a: 1, b: 123 }, // b fails: not a string
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(false);
      expect(result.data.unsupported).toBeFalsy();
      expect(result.data.matchedPath).toBe('/entry/b');
    }
  });

  test('a parseable failing .validate still denies as today', () => {
    const result = handler.execute(structureRules, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { title: 't' }, // missing `body`
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(false);
      expect(result.data.unsupported).toBeFalsy();
    }
  });

  test('a parseable passing .validate still allows as today', () => {
    const result = handler.execute(structureRules, {
      operation: 'write',
      path: '/entry',
      auth: authed,
      mockData: {},
      newData: { title: 't', body: 'b' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowed).toBe(true);
      expect(result.data.unsupported).toBeFalsy();
    }
  });
});

// ── `data`/`newData` rooting at the RULE's own location ─────────────────
//
// Live RTDB roots `data`/`newData` at the location of the RULE being
// evaluated, not at the operation's target path. A rule declared on an
// ANCESTOR of a deeper write/read must see `data`/`newData` as the
// snapshot at the ancestor's own location — not at the deeper path, and
// not "no data" just because the deeper path itself is empty. Getting
// this wrong is a false-ALLOW bug class: an ancestor rule like
// `data.child('owner').val() === auth.uid || !data.exists()` is meant as
// "owner check, but allow creating a brand-new room" — rooting `data` at
// the deep write path instead of the room's own path makes `data.exists()`
// false for every write below an existing room, so the `!data.exists()`
// escape hatch fires even though the room (and its `owner`) already exist.
describe('SimulateHandler — data/newData rooted at rule location', () => {
  const handler = new SimulateHandler();

  const expr = (raw: string): RtdbNode['read'] => ({
    raw,
    parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
  });

  const node = (partial: Partial<RtdbNode> & { path: string }): RtdbNode => ({
    pathVariables: [],
    children: [],
    ...partial,
  });

  const compiled = (rules: RtdbNode): RtdbNode => rules;

  test('an ancestor .write rooted with an owner-or-new-doc escape hatch denies writes under an EXISTING doc owned by someone else', () => {
    // `.write` at `/rooms/$roomId` — `data` must be the snapshot at
    // `/rooms/$roomId` (with `owner: 'bob'`), not at the deep write path
    // `/rooms/room1/title` (which has no value and so looks "not exists").
    const ownerOrNewRules = compiled(
      node({
        path: '/',
        children: [
          node({
            path: '/rooms',
            children: [
              node({
                path: '/rooms/$roomId',
                pathVariables: ['$roomId'],
                write: expr("data.child('owner').val() === auth.uid || !data.exists()"),
              }),
            ],
          }),
        ],
      }),
    );

    const mockData = { rooms: { room1: { owner: 'bob', title: 'old' } } };

    // mallory is not the owner of the EXISTING room1 — must be denied.
    const denied = handler.execute(ownerOrNewRules, {
      operation: 'write',
      path: '/rooms/room1/title',
      auth: { uid: 'mallory', token: {} },
      mockData,
      newData: 'hijacked',
    });
    expect(denied.success).toBe(true);
    if (denied.success) expect(denied.data.allowed).toBe(false);

    // bob IS the owner — allowed.
    const allowed = handler.execute(ownerOrNewRules, {
      operation: 'write',
      path: '/rooms/room1/title',
      auth: { uid: 'bob', token: {} },
      mockData,
      newData: 'new title',
    });
    expect(allowed.success).toBe(true);
    if (allowed.success) expect(allowed.data.allowed).toBe(true);

    // Nobody owns a room that doesn't exist yet — the `!data.exists()`
    // escape hatch still legitimately allows creating a brand-new room.
    const created = handler.execute(ownerOrNewRules, {
      operation: 'write',
      path: '/rooms/room2/title',
      auth: { uid: 'mallory', token: {} },
      mockData,
      newData: 'brand new room',
    });
    expect(created.success).toBe(true);
    if (created.success) expect(created.data.allowed).toBe(true);
  });

  test('a rule reading data.child(...) at the rule location sees the correct nested value regardless of write depth', () => {
    const readRules = compiled(
      node({
        path: '/',
        children: [
          node({
            path: '/rooms',
            children: [
              node({
                path: '/rooms/$roomId',
                pathVariables: ['$roomId'],
                read: expr("data.child('visibility').val() === 'public'"),
              }),
            ],
          }),
        ],
      }),
    );

    const mockData = { rooms: { room1: { visibility: 'private', messages: { m1: 'hi' } } } };

    const denied = handler.execute(readRules, {
      operation: 'read',
      path: '/rooms/room1/messages/m1',
      auth: null,
      mockData,
    });
    expect(denied.success).toBe(true);
    if (denied.success) expect(denied.data.allowed).toBe(false);

    const publicMockData = { rooms: { room1: { visibility: 'public', messages: { m1: 'hi' } } } };
    const allowed = handler.execute(readRules, {
      operation: 'read',
      path: '/rooms/room1/messages/m1',
      auth: null,
      mockData: publicMockData,
    });
    expect(allowed.success).toBe(true);
    if (allowed.success) expect(allowed.data.allowed).toBe(true);
  });

  test('newData at an ancestor rule reflects the merged post-write value at that ancestor location, not the raw payload at the deep write path', () => {
    // `.write` at `/rooms/$roomId` checks `newData.child('locked').val()`
    // — the post-write value of the ROOM, which must still show
    // `locked: true` (untouched by a write to a sibling field) rather than
    // being computed from the raw write payload at the deep path.
    const lockedRules = compiled(
      node({
        path: '/',
        children: [
          node({
            path: '/rooms',
            children: [
              node({
                path: '/rooms/$roomId',
                pathVariables: ['$roomId'],
                write: expr("newData.child('locked').val() !== true"),
              }),
            ],
          }),
        ],
      }),
    );

    const mockData = { rooms: { room1: { locked: true, title: 'old' } } };

    // Writing just `/title` on a locked room: the merged post-write room
    // still has `locked: true`, so the rule must deny.
    const denied = handler.execute(lockedRules, {
      operation: 'write',
      path: '/rooms/room1/title',
      auth: { uid: 'anyone', token: {} },
      mockData,
      newData: 'new title',
    });
    expect(denied.success).toBe(true);
    if (denied.success) expect(denied.data.allowed).toBe(false);

    // An unlocked room allows the same write.
    const unlockedMockData = { rooms: { room1: { locked: false, title: 'old' } } };
    const allowed = handler.execute(lockedRules, {
      operation: 'write',
      path: '/rooms/room1/title',
      auth: { uid: 'anyone', token: {} },
      mockData: unlockedMockData,
      newData: 'new title',
    });
    expect(allowed.success).toBe(true);
    if (allowed.success) expect(allowed.data.allowed).toBe(true);
  });

  test('newData.parent() from a nested write resolves through the merged tree, not just the written subtree', () => {
    // A `.validate` at a deep node using `newData.parent()` must be able
    // to see sibling fields merged from the pre-write tree.
    const expr2 = (raw: string): RtdbNode['validate'] => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const parentRules = compiled(
      node({
        path: '/',
        write: expr('auth !== null'),
        children: [
          node({
            path: '/rooms',
            children: [
              node({
                path: '/rooms/$roomId',
                pathVariables: ['$roomId'],
                children: [
                  node({
                    path: '/rooms/$roomId/title',
                    pathVariables: ['$roomId'],
                    validate: expr2("newData.parent().child('locked').val() !== true"),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );

    const mockData = { rooms: { room1: { locked: true, title: 'old' } } };
    const denied = handler.execute(parentRules, {
      operation: 'write',
      path: '/rooms/room1/title',
      auth: { uid: 'anyone', token: {} },
      mockData,
      newData: 'new title',
    });
    expect(denied.success).toBe(true);
    if (denied.success) expect(denied.data.allowed).toBe(false);
  });
});

// ── atomic multi-path update projection ─────────────────────────────────
//
// An atomic multi-path `update()` (the `{ "/a/b": 1, "/c/d": 2 }` shape)
// applies every listed path together. Production RTDB evaluates each
// written path's rules against a `newData` reflecting the ENTIRE projected
// post-update tree — all paths merged — while still checking each path's
// rules individually. Evaluating leaf-by-leaf (each path against only its
// own new value) is a wrong-verdict bug: a rule on path A that depends on a
// sibling path B written in the SAME update sees B as absent, flipping a
// legal write to a false DENY. The `updates` field carries the full update
// set so the simulator builds one shared projection.
describe('SimulateHandler — atomic multi-path update projection', () => {
  const handler = new SimulateHandler();

  const expr = (raw: string): RtdbNode['write'] => ({
    raw,
    parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
  });

  const node = (partial: Partial<RtdbNode> & { path: string }): RtdbNode => ({
    pathVariables: [],
    children: [],
    ...partial,
  });

  const compiled = (rules: RtdbNode): RtdbNode => rules;

  const authed = { uid: 'alice', token: {} };

  // `.write` on the messages path depends on a sibling `meta/count` under
  // the SAME room; the room's `/meta` subtree is write-open so the second
  // leaf lands on its own merit.
  const siblingDepRules = compiled(
    node({
      path: '/',
      children: [
        node({
          path: '/rooms',
          children: [
            node({
              path: '/rooms/$roomId',
              pathVariables: ['$roomId'],
              children: [
                node({
                  path: '/rooms/$roomId/messages',
                  pathVariables: ['$roomId'],
                  write: expr("newData.parent().child('meta/count').exists()"),
                }),
                node({
                  path: '/rooms/$roomId/meta',
                  pathVariables: ['$roomId'],
                  write: expr('true'),
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  );

  test('(a) ALLOWS a path whose rule depends on a sibling path written in the SAME update', () => {
    // Old leaf-by-leaf behavior: `/rooms/room1/messages` was projected with
    // ONLY its own value, so `meta/count` looked absent → false DENY.
    const updates = [
      { path: '/rooms/room1/messages', value: { m1: 'hi' } },
      { path: '/rooms/room1/meta/count', value: 1 },
    ];
    const result = handler.execute(siblingDepRules, {
      operation: 'write',
      path: '/rooms/room1/messages',
      auth: authed,
      mockData: {},
      newData: { m1: 'hi' },
      updates,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowed).toBe(true);
  });

  test('(b) DENIES the same path when the depended-on sibling is NOT part of the update', () => {
    // No `updates` (or a single-path update): the projection contains only
    // the messages write, `meta/count` is genuinely absent → correct DENY.
    const result = handler.execute(siblingDepRules, {
      operation: 'write',
      path: '/rooms/room1/messages',
      auth: authed,
      mockData: {},
      newData: { m1: 'hi' },
      updates: [{ path: '/rooms/room1/messages', value: { m1: 'hi' } }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowed).toBe(false);
  });

  test('(b2) characterizes the OLD leaf-by-leaf behavior — a single-path projection of the depended-on path denies', () => {
    // With no `updates` the handler projects only `path`/`newData`. This is
    // exactly what the pre-fix fan-out did for EVERY path, which is why the
    // legal cross-path write in (a) used to falsely deny.
    const result = handler.execute(siblingDepRules, {
      operation: 'write',
      path: '/rooms/room1/messages',
      auth: authed,
      mockData: {},
      newData: { m1: 'hi' },
    });
    expect(result.success && result.data.allowed).toBe(false);
  });

  test('(c) evaluates .validate against the shared projected tree', () => {
    const validateExpr = (raw: string): RtdbNode['validate'] => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: [] },
    });
    const validateRules = compiled(
      node({
        path: '/',
        write: expr('true'),
        children: [
          node({
            path: '/rooms',
            children: [
              node({
                path: '/rooms/$roomId',
                pathVariables: ['$roomId'],
                children: [
                  node({
                    path: '/rooms/$roomId/messages',
                    pathVariables: ['$roomId'],
                    // A message may only be written when the room's total is
                    // present in the same atomic update.
                    validate: validateExpr("newData.parent().child('meta/count').exists()"),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );

    const allowed = handler.execute(validateRules, {
      operation: 'write',
      path: '/rooms/room1/messages',
      auth: authed,
      mockData: {},
      newData: { m1: 'hi' },
      updates: [
        { path: '/rooms/room1/messages', value: { m1: 'hi' } },
        { path: '/rooms/room1/meta/count', value: 1 },
      ],
    });
    expect(allowed.success && allowed.data.allowed).toBe(true);

    const denied = handler.execute(validateRules, {
      operation: 'write',
      path: '/rooms/room1/messages',
      auth: authed,
      mockData: {},
      newData: { m1: 'hi' },
      updates: [{ path: '/rooms/room1/messages', value: { m1: 'hi' } }],
    });
    expect(denied.success && denied.data.allowed).toBe(false);
  });

  test('(d) a denied path in the update returns allowed=false (caller rejects the whole atomic batch)', () => {
    // The fan-out throws on the first denied path so nothing applies; at the
    // handler level the denied path surfaces as allowed=false.
    const ownedRules = compiled(
      node({
        path: '/',
        children: [
          node({
            path: '/users',
            children: [
              node({
                path: '/users/$uid',
                pathVariables: ['$uid'],
                write: expr('auth.uid === $uid'),
              }),
            ],
          }),
        ],
      }),
    );
    const updates = [
      { path: '/users/alice/name', value: 'Alice' },
      { path: '/users/bob/name', value: 'Bob' },
    ];
    const ownPath = handler.execute(ownedRules, {
      operation: 'write',
      path: '/users/alice/name',
      auth: authed,
      mockData: {},
      newData: 'Alice',
      updates,
    });
    expect(ownPath.success && ownPath.data.allowed).toBe(true);

    const otherPath = handler.execute(ownedRules, {
      operation: 'write',
      path: '/users/bob/name',
      auth: authed,
      mockData: {},
      newData: 'Bob',
      updates,
    });
    expect(otherPath.success && otherPath.data.allowed).toBe(false);
  });

  test('(e) an ANCESTOR rule over deep paths sees the full merged projection of all update paths', () => {
    // `.write` at `/rooms/$roomId` requires both `a` and `b` present in the
    // post-write room. Two deep paths under the common ancestor supply them
    // in one update; evaluating either deep path, the ancestor rule (rooted
    // at the room) must see both.
    const ancestorRules = compiled(
      node({
        path: '/',
        children: [
          node({
            path: '/rooms',
            children: [
              node({
                path: '/rooms/$roomId',
                pathVariables: ['$roomId'],
                write: expr("newData.hasChildren(['a', 'b'])"),
              }),
            ],
          }),
        ],
      }),
    );
    const updates = [
      { path: '/rooms/room1/a', value: 1 },
      { path: '/rooms/room1/b', value: 2 },
    ];
    for (const target of ['/rooms/room1/a', '/rooms/room1/b']) {
      const result = handler.execute(ancestorRules, {
        operation: 'write',
        path: target,
        auth: authed,
        mockData: {},
        newData: target.endsWith('/a') ? 1 : 2,
        updates,
      });
      expect(result.success && result.data.allowed).toBe(true);
    }

    // Without the sibling in the update, the ancestor rule denies — only one
    // of the two required children is present.
    const partial = handler.execute(ancestorRules, {
      operation: 'write',
      path: '/rooms/room1/a',
      auth: authed,
      mockData: {},
      newData: 1,
      updates: [{ path: '/rooms/room1/a', value: 1 }],
    });
    expect(partial.success && partial.data.allowed).toBe(false);
  });

  test('enforces validate rule with single-quoted string escape sequence', () => {
    const expr = (raw: string) => ({
      raw,
      parsed: { raw, valid: true, errors: [], warnings: [], referencedIdentifiers: ['newData'] },
    });
    const rules: RtdbNode = {
      path: '/',
      pathVariables: [],
      children: [
        {
          path: '/logs',
          pathVariables: [],
          write: expr('true'),
          validate: expr("newData.val() === 'line1\\nline2'"),
          children: [],
        },
      ],
    };

    // Passing write with exact newline
    const allowResult = handler.execute(rules, {
      operation: 'write',
      path: '/logs',
      auth: { uid: 'user1', token: {} },
      mockData: {},
      newData: 'line1\nline2',
    });
    expect(allowResult.success && allowResult.data.allowed).toBe(true);

    // Denied write with literal backslash n
    const denyResult = handler.execute(rules, {
      operation: 'write',
      path: '/logs',
      auth: { uid: 'user1', token: {} },
      mockData: {},
      newData: 'line1\\nline2',
    });
    expect(denyResult.success && denyResult.data.allowed).toBe(false);
  });
});
