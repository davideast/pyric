/**
 * projectAfterState contract tests — Item 0.D / Item 7.
 *
 * The four WriteMode kinds must produce the documented after-state shape
 * for every payload + pre-state combination. Particular focus on the
 * trap the hindsight describes: `update` with a top-level map key that
 * the existing doc also has — the entire key is replaced, not merged.
 * Recursive merge only happens for set({merge: true}); update uses
 * dot-paths for nested patches.
 */
import { describe, test, expect } from 'bun:test';
import { projectAfterState } from 'pyric/rules';

describe('projectAfterState — create', () => {
  test('returns payload as-is', () => {
    expect(projectAfterState({ kind: 'create' }, null, { a: 1 })).toEqual({ a: 1 });
  });

  test('ignores existing pre-state', () => {
    expect(projectAfterState({ kind: 'create' }, { x: 'old' }, { a: 1 })).toEqual({ a: 1 });
  });
});

describe('projectAfterState — set { merge: false }', () => {
  test('full replace, ignores existing', () => {
    expect(
      projectAfterState({ kind: 'set', merge: false }, { x: 'old', y: 'old' }, { a: 1 }),
    ).toEqual({ a: 1 });
  });
});

describe('projectAfterState — set { merge: true }', () => {
  test('top-level keys merge', () => {
    expect(
      projectAfterState({ kind: 'set', merge: true }, { a: 1 }, { b: 2 }),
    ).toEqual({ a: 1, b: 2 });
  });

  test('nested maps recurse', () => {
    expect(
      projectAfterState(
        { kind: 'set', merge: true },
        { profile: { name: 'old', email: 'e@x' } },
        { profile: { name: 'new' } },
      ),
    ).toEqual({ profile: { name: 'new', email: 'e@x' } });
  });

  test('payload leaf wins on collision', () => {
    expect(
      projectAfterState({ kind: 'set', merge: true }, { a: 'old' }, { a: 'new' }),
    ).toEqual({ a: 'new' });
  });

  test('non-map collision replaces (no merge into arrays)', () => {
    expect(
      projectAfterState({ kind: 'set', merge: true }, { tags: ['a', 'b'] }, { tags: ['c'] }),
    ).toEqual({ tags: ['c'] });
  });

  test('null existing treated as empty', () => {
    expect(
      projectAfterState({ kind: 'set', merge: true }, null, { a: 1 }),
    ).toEqual({ a: 1 });
  });
});

describe('projectAfterState — update (the 0.D trap)', () => {
  test('top-level key REPLACES, does not recursively merge', () => {
    // This is THE 0.D trap: shallow-merge or recursive merge would have
    // produced { profile: { name: 'new', email: 'old@x' } } — wrong for
    // `update`. Firestore update semantics replace at the top-level key.
    expect(
      projectAfterState(
        { kind: 'update' },
        { profile: { name: 'old', email: 'old@x' } },
        { profile: { name: 'new' } },
      ),
    ).toEqual({ profile: { name: 'new' } });
  });

  test('preserves non-mentioned top-level keys', () => {
    expect(
      projectAfterState({ kind: 'update' }, { a: 1, b: 2 }, { b: 3 }),
    ).toEqual({ a: 1, b: 3 });
  });

  test('dot-path patches nested map (the official Firestore mechanism)', () => {
    expect(
      projectAfterState(
        { kind: 'update' },
        { profile: { name: 'old', email: 'old@x' } },
        { 'profile.name': 'new' },
      ),
    ).toEqual({ profile: { name: 'new', email: 'old@x' } });
  });

  test('dot-path creates missing intermediate maps', () => {
    expect(
      projectAfterState({ kind: 'update' }, {}, { 'a.b.c': 42 }),
    ).toEqual({ a: { b: { c: 42 } } });
  });

  test('dot-path overwrites non-map intermediate', () => {
    // If `a` was a string, dot-path 'a.b' should replace `a` with a map.
    expect(
      projectAfterState({ kind: 'update' }, { a: 'string' }, { 'a.b': 1 }),
    ).toEqual({ a: { b: 1 } });
  });

  test('mix top-level and dot-path', () => {
    expect(
      projectAfterState(
        { kind: 'update' },
        { x: 1, profile: { name: 'old', email: 'e' } },
        { x: 2, 'profile.name': 'new' },
      ),
    ).toEqual({ x: 2, profile: { name: 'new', email: 'e' } });
  });
});

describe('projectAfterState — delete', () => {
  test('returns null', () => {
    expect(projectAfterState({ kind: 'delete' }, { a: 1 }, {})).toBe(null);
  });

  test('null pre-state still returns null', () => {
    expect(projectAfterState({ kind: 'delete' }, null, {})).toBe(null);
  });
});
