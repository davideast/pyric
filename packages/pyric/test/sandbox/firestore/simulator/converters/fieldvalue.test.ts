/**
 * Item 2 — FieldValue sentinel parity tests.
 *
 * Plan §Item 2 test contract:
 *   - Counter: seed `{count:0}`; three `increment(1)` writes through
 *     the simulator land `{count:3}`.
 *   - arrayUnion is dedup'd; arrayRemove no-ops on missing values.
 *   - deleteField() makes the key absent in `resource.data` after
 *     the write (visible to the next rule eval).
 *   - Rule `request.resource.data.count == resource.data.count + 1`
 *     PASSES for an `increment(1)` write.
 *   - Type-mismatch path (FS-B11): `increment(1)` against a string-typed
 *     prior OVERWRITES (base 0 → 1) rather than denying; arrayUnion/
 *     arrayRemove coerce a non-array prior to `[]`.
 *
 * Plus direct converter unit-tests for KEEP/idempotency contracts
 * (matching the timestamp.test.ts shape).
 */
import { describe, test, expect } from 'bun:test';
import {
  incrementConverter,
  arrayUnionConverter,
  arrayRemoveConverter,
  deleteFieldConverter,
  INCREMENT,
  ARRAY_UNION,
  ARRAY_REMOVE,
  DELETE_FIELD,
} from 'pyric/sandbox/internal';
import {
  KEEP,
  DELETE_MARKER,
  partitionDeletes,
} from 'pyric/sandbox/internal';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const ALLOW_ALL =
  "rules_version = '2'; service cloud.firestore { " +
  '  match /databases/{database}/documents {' +
  '    match /{document=**} { allow read, write: if true; }' +
  '  }' +
  '}';

const baseCtx = (
  overrides: Partial<{
    path: string;
    method: 'create' | 'update' | 'set' | 'seed';
    prior: Record<string, unknown> | null;
    fieldPath: string;
    serverTime: unknown;
  }> = {},
) => ({
  path: 'p/x',
  method: 'update' as const,
  prior: null,
  fieldPath: 'count',
  ...overrides,
});

// ─── Converter unit tests ──────────────────────────────────────────────────

describe('incrementConverter', () => {
  test('adds delta to numeric prior at fieldPath', () => {
    const out = incrementConverter.convert(
      INCREMENT(5),
      baseCtx({ prior: { count: 10 }, fieldPath: 'count' }),
    );
    expect(out).toBe(15);
  });

  test('treats absent prior as 0', () => {
    const out = incrementConverter.convert(
      INCREMENT(3),
      baseCtx({ prior: {}, fieldPath: 'count' }),
    );
    expect(out).toBe(3);
  });

  test('treats null prior doc as absent (initial create)', () => {
    const out = incrementConverter.convert(
      INCREMENT(7),
      baseCtx({ prior: null, fieldPath: 'count' }),
    );
    expect(out).toBe(7);
  });

  test('overwrites a non-numeric prior — base value 0, result is the operand (FS-B11)', () => {
    // Prod does not throw; `increment(1)` on a string uses base 0 → 1.
    const out = incrementConverter.convert(
      INCREMENT(1),
      baseCtx({ prior: { count: 'oops' }, fieldPath: 'count' }),
    );
    expect(out).toBe(1);
  });

  test('declines non-sentinel values (idempotent on its own output)', () => {
    expect(incrementConverter.convert(42, baseCtx())).toBe(KEEP);
    expect(incrementConverter.convert({ __type: 'other' }, baseCtx())).toBe(KEEP);
    // Substituted output (a number) — second pass declines.
    expect(incrementConverter.convert(99, baseCtx())).toBe(KEEP);
  });
});

describe('arrayUnionConverter', () => {
  test('appends new values, dedups existing', () => {
    const out = arrayUnionConverter.convert(
      ARRAY_UNION('b', 'c', 'a'),
      baseCtx({ prior: { tags: ['a', 'b'] }, fieldPath: 'tags' }),
    );
    expect(out).toEqual(['a', 'b', 'c']);
  });

  test('deep-equality dedup for plain objects', () => {
    const out = arrayUnionConverter.convert(
      ARRAY_UNION({ id: 1 }, { id: 2 }),
      baseCtx({ prior: { items: [{ id: 1 }] }, fieldPath: 'items' }),
    );
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('treats absent prior as empty array', () => {
    const out = arrayUnionConverter.convert(
      ARRAY_UNION('x'),
      baseCtx({ prior: {}, fieldPath: 'tags' }),
    );
    expect(out).toEqual(['x']);
  });

  test('overwrites a non-array prior — coerced to [] then unioned (FS-B11)', () => {
    // Prod does not throw; a non-array prior is treated as [].
    const out = arrayUnionConverter.convert(
      ARRAY_UNION('x'),
      baseCtx({ prior: { tags: 'string-not-array' }, fieldPath: 'tags' }),
    );
    expect(out).toEqual(['x']);
  });

  test('declines non-sentinel values', () => {
    expect(arrayUnionConverter.convert([1, 2, 3], baseCtx())).toBe(KEEP);
    expect(arrayUnionConverter.convert({ values: [1] }, baseCtx())).toBe(KEEP);
  });
});

describe('arrayRemoveConverter', () => {
  test('removes listed values, no-ops on missing', () => {
    const out = arrayRemoveConverter.convert(
      ARRAY_REMOVE('b', 'z'),
      baseCtx({ prior: { tags: ['a', 'b', 'c'] }, fieldPath: 'tags' }),
    );
    expect(out).toEqual(['a', 'c']);
  });

  test('returns empty array when prior is absent', () => {
    const out = arrayRemoveConverter.convert(
      ARRAY_REMOVE('a'),
      baseCtx({ prior: {}, fieldPath: 'tags' }),
    );
    expect(out).toEqual([]);
  });

  test('overwrites a non-array prior — coerced to [], result is [] (FS-B11)', () => {
    // Prod does not throw; a non-array prior is treated as [].
    const out = arrayRemoveConverter.convert(
      ARRAY_REMOVE('a'),
      baseCtx({ prior: { tags: 5 }, fieldPath: 'tags' }),
    );
    expect(out).toEqual([]);
  });

  test('declines non-sentinel values', () => {
    expect(arrayRemoveConverter.convert(['a'], baseCtx())).toBe(KEEP);
  });
});

describe('deleteFieldConverter', () => {
  test('substitutes the DELETE_MARKER symbol', () => {
    const out = deleteFieldConverter.convert(DELETE_FIELD, baseCtx());
    expect(out).toBe(DELETE_MARKER);
  });

  test('declines non-sentinel values', () => {
    expect(deleteFieldConverter.convert({ __type: 'other' }, baseCtx())).toBe(KEEP);
    expect(deleteFieldConverter.convert(null, baseCtx())).toBe(KEEP);
    // Idempotent on the marker itself — converter only matches the
    // sentinel object shape, not the symbol output.
    expect(deleteFieldConverter.convert(DELETE_MARKER, baseCtx())).toBe(KEEP);
  });
});

// ─── partitionDeletes tests ────────────────────────────────────────────────

describe('partitionDeletes', () => {
  test('separates top-level DELETE_MARKER keys from writes', () => {
    const { writes, deletedKeys } = partitionDeletes({
      a: 1,
      b: DELETE_MARKER,
      c: 'keep',
    });
    expect(writes).toEqual({ a: 1, c: 'keep' });
    expect(deletedKeys).toEqual(['b']);
  });

  test('strips nested DELETE_MARKER from objects (no top-level delete)', () => {
    const { writes, deletedKeys } = partitionDeletes({
      user: { name: 'alice', tag: DELETE_MARKER },
    });
    expect(writes).toEqual({ user: { name: 'alice' } });
    expect(deletedKeys).toEqual([]);
  });

  test('idempotent — second call sees no markers', () => {
    const first = partitionDeletes({ a: 1, b: DELETE_MARKER });
    const second = partitionDeletes(first.writes);
    expect(second.writes).toEqual({ a: 1 });
    expect(second.deletedKeys).toEqual([]);
  });
});

// ─── End-to-end through LocalEnvironment ──────────────────────────────────

describe('LocalEnvironment — increment counter', () => {
  test('three increment(1) writes against {count:0} land at {count:3}', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'counters/c1': { count: 0 } } });

    for (let i = 0; i < 3; i++) {
      const r = env.execute({
        method: 'update',
        path: 'counters/c1',
        data: { count: INCREMENT(1) },
        auth: null,
      });
      expect(r.allowed).toBe(true);
    }

    const after = env.snapshot();
    expect(after['counters/c1']).toEqual({ count: 3 });
  });

  test('rule comparing post-write to prior + 1 PASSES for increment(1)', () => {
    const RULES =
      "rules_version = '2'; service cloud.firestore { " +
      '  match /databases/{database}/documents {' +
      '    match /counters/{id} {' +
      '      allow update: if request.resource.data.count == resource.data.count + 1;' +
      '      allow read: if true;' +
      '    }' +
      '  }' +
      '}';
    const env = new LocalEnvironment();
    env.seed({ rules: RULES, documents: { 'counters/c1': { count: 5 } } });

    const r = env.execute({
      method: 'update',
      path: 'counters/c1',
      data: { count: INCREMENT(1) },
      auth: null,
    });
    expect(r.allowed).toBe(true);
    expect(env.snapshot()['counters/c1']).toEqual({ count: 6 });
  });

  test('increment(1) against a string-typed prior OVERWRITES — base 0 (FS-B11)', () => {
    // Prod does not deny: `increment` on a non-numeric prior uses base 0,
    // so the string is overwritten with the operand value.
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'counters/c1': { count: 'not-a-number' } } });

    const r = env.execute({
      method: 'update',
      path: 'counters/c1',
      data: { count: INCREMENT(1) },
      auth: null,
    });
    expect(r.allowed).toBe(true);
    expect(env.snapshot()['counters/c1']).toEqual({ count: 1 });
  });
});

describe('LocalEnvironment — arrayUnion / arrayRemove', () => {
  test('arrayUnion dedups against existing values', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'docs/d1': { tags: ['a', 'b'] } } });
    const r = env.execute({
      method: 'update',
      path: 'docs/d1',
      data: { tags: ARRAY_UNION('b', 'c') },
      auth: null,
    });
    expect(r.allowed).toBe(true);
    expect(env.snapshot()['docs/d1']).toEqual({ tags: ['a', 'b', 'c'] });
  });

  test('arrayRemove no-ops on values not present', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'docs/d1': { tags: ['a', 'b'] } } });
    const r = env.execute({
      method: 'update',
      path: 'docs/d1',
      data: { tags: ARRAY_REMOVE('zzz') },
      auth: null,
    });
    expect(r.allowed).toBe(true);
    expect(env.snapshot()['docs/d1']).toEqual({ tags: ['a', 'b'] });
  });
});

describe('LocalEnvironment — deleteField', () => {
  test('after deleteField update the key is absent in storage', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'docs/d1': { name: 'alice', tag: 'x' } } });
    const r = env.execute({
      method: 'update',
      path: 'docs/d1',
      data: { tag: DELETE_FIELD },
      auth: null,
    });
    expect(r.allowed).toBe(true);
    const after = env.snapshot()['docs/d1'];
    expect('tag' in after).toBe(false);
    expect(after).toEqual({ name: 'alice' });
  });

  test('rule asserting !("tag" in resource.data) PASSES on the post-write doc', () => {
    // The buildTestCase merge for `update` strips DELETE_FIELD-marked
    // keys from `request.resource.data`, so a rule that checks the
    // post-write shape sees the key as absent.
    const RULES =
      "rules_version = '2'; service cloud.firestore { " +
      '  match /databases/{database}/documents {' +
      '    match /docs/{id} {' +
      '      allow update: if !("tag" in request.resource.data);' +
      '      allow read: if true;' +
      '    }' +
      '  }' +
      '}';
    const env = new LocalEnvironment();
    env.seed({ rules: RULES, documents: { 'docs/d1': { name: 'alice', tag: 'x' } } });
    const r = env.execute({
      method: 'update',
      path: 'docs/d1',
      data: { tag: DELETE_FIELD },
      auth: null,
    });
    expect(r.allowed).toBe(true);
  });
});

// ─── FS-B11 — sentinel overwrite semantics (not throws) ───────────────────

describe('FS-B11 — sentinels overwrite a type-mismatched prior', () => {
  test('increment(5) on a string prior overwrites to 5', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'd/x': { n: 'hello' } } });
    const r = env.execute({ method: 'update', path: 'd/x', data: { n: INCREMENT(5) }, auth: null });
    expect(r.allowed).toBe(true);
    expect(env.snapshot()['d/x']).toEqual({ n: 5 });
  });

  test('arrayUnion on a string prior coerces to [] then unions', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'd/x': { tags: 'oops' } } });
    const r = env.execute({ method: 'update', path: 'd/x', data: { tags: ARRAY_UNION('a', 'b') }, auth: null });
    expect(r.allowed).toBe(true);
    expect(env.snapshot()['d/x']).toEqual({ tags: ['a', 'b'] });
  });

  test('arrayRemove on a number prior coerces to [] (result [])', () => {
    const env = new LocalEnvironment();
    env.seed({ rules: ALLOW_ALL, documents: { 'd/x': { tags: 42 } } });
    const r = env.execute({ method: 'update', path: 'd/x', data: { tags: ARRAY_REMOVE('a') }, auth: null });
    expect(r.allowed).toBe(true);
    expect(env.snapshot()['d/x']).toEqual({ tags: [] });
  });
});
