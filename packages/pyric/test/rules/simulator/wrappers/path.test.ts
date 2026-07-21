/**
 * Path wrapper contract tests (Item 5.4) — equals + serialization +
 * coercion + bind + numeric/named field access + integration with the
 * `path()` constructor and the literal `/path/to/$(x)` form.
 */
import { describe, test, expect } from 'bun:test';
import { Path } from '../../../../src/rules/simulator/wrappers/path.js';
import { NO_OP } from '../../../../src/rules/simulator/wrappers/base.js';
import { SimulateFirestoreRulesHandler } from '../../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../../../src/rules/firestore/test/spec.js';

// ─── Wrapper-level tests ───────────────────────────────────────────────────

describe('Path — construction', () => {
  test('fromString splits on /', () => {
    expect(Path.fromString('/users/alice').segments).toEqual(['users', 'alice']);
    expect(Path.fromString('users/alice').segments).toEqual(['users', 'alice']);
  });

  test('fromString preserves placeholders', () => {
    expect(Path.fromString('/users/{uid}/posts/{postId}').segments).toEqual([
      'users', '{uid}', 'posts', '{postId}',
    ]);
  });

  test('empty string → empty segments', () => {
    expect(Path.fromString('').segments).toEqual([]);
    expect(Path.fromString('/').segments).toEqual([]);
  });
});

describe('Path — equals (0.B contract)', () => {
  test('two paths with same segments are value-equal', () => {
    const a = new Path(['users', 'alice']);
    const b = new Path(['users', 'alice']);
    expect(a === b).toBe(false);
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
  });

  test('different segments not equal', () => {
    expect(new Path(['users', 'alice']).equals(new Path(['users', 'bob']))).toBe(false);
    expect(new Path(['users']).equals(new Path(['users', 'alice']))).toBe(false);
  });

  test('not equal to non-Path values', () => {
    const p = new Path(['users']);
    expect(p.equals(null)).toBe(false);
    expect(p.equals('/users')).toBe(false);
    expect(p.equals({ segments: ['users'] })).toBe(false);
  });
});

describe('Path — serialization (0.B contract)', () => {
  test('toString round-trips with leading /', () => {
    expect(String(new Path(['users', 'alice']))).toBe('/users/alice');
    expect(String(new Path([]))).toBe('/');
  });

  test('toJSON shape', () => {
    const json = JSON.parse(JSON.stringify(new Path(['users', 'alice']))) as { __type: string; segments: string[] };
    expect(json.__type).toBe('path');
    expect(json.segments).toEqual(['users', 'alice']);
  });
});

describe('Path — coercion (0.B contract)', () => {
  test('Number() returns NaN', () => {
    expect(Number(new Path(['users']))).toBeNaN();
    expect(new Path(['users']).valueOf()).toBeNaN();
  });
});

describe('Path — bind', () => {
  test('substitutes placeholder by name', () => {
    const p = Path.fromString('/users/{uid}/posts/{postId}');
    const bound = p.bind({ uid: 'alice', postId: 'p1' });
    expect(bound.segments).toEqual(['users', 'alice', 'posts', 'p1']);
    // original unchanged
    expect(p.segments).toEqual(['users', '{uid}', 'posts', '{postId}']);
  });

  test('partial bind leaves unbound placeholders intact', () => {
    const p = Path.fromString('/users/{uid}/posts/{postId}');
    const bound = p.bind({ uid: 'alice' });
    expect(bound.segments).toEqual(['users', 'alice', 'posts', '{postId}']);
  });

  test('extra bindings are silently ignored', () => {
    const p = Path.fromString('/users/{uid}');
    const bound = p.bind({ uid: 'alice', extra: 'ignored' });
    expect(bound.segments).toEqual(['users', 'alice']);
  });

  test('null binding value throws', () => {
    const p = Path.fromString('/users/{uid}');
    expect(() => p.bind({ uid: null })).toThrow(/must not be null/);
  });

  test('non-identifier-shaped placeholder is treated as literal', () => {
    // {123} is not a valid placeholder name (must start with letter/_)
    const p = new Path(['{123}']);
    expect(p.bind({ '123': 'x' }).segments).toEqual(['{123}']);
  });
});

describe('Path — field (numeric and named)', () => {
  test('numeric index returns segment', () => {
    const p = new Path(['users', 'alice', 'posts']);
    expect(p.field('0')).toBe('users');
    expect(p.field('1')).toBe('alice');
    expect(p.field('2')).toBe('posts');
  });

  test('numeric out of bounds → null', () => {
    expect(new Path(['x']).field('5')).toBe(null);
    expect(new Path([]).field('0')).toBe(null);
  });

  test('named lookup → null (post-bind paths do not retain names)', () => {
    expect(new Path(['users', 'alice']).field('uid')).toBe(null);
  });
});

describe('Path — method dispatch', () => {
  test('callMethod bind succeeds for valid map', () => {
    const p = Path.fromString('/users/{uid}');
    const result = p.callMethod('bind', [{ uid: 'alice' }]);
    expect(result instanceof Path).toBe(true);
    expect((result as Path).segments).toEqual(['users', 'alice']);
  });

  test('callMethod bind on non-map throws TypeError', () => {
    const p = Path.fromString('/users/{uid}');
    expect(() => p.callMethod('bind', ['not-a-map'])).toThrow(TypeError);
    expect(() => p.callMethod('bind', [null])).toThrow(TypeError);
    expect(() => p.callMethod('bind', [['a', 'b']])).toThrow(TypeError);
  });

  test('unknown method returns NO_OP', () => {
    expect(new Path([]).callMethod('mystery', [])).toBe(NO_OP);
  });
});

// ─── Integration tests through the evaluator ───────────────────────────────

const sim = new SimulateFirestoreRulesHandler();

function rules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow create: if ${condition};
    }
  }
}`;
}

function tc(condition: string, expectation: 'ALLOW' | 'DENY'): TestCase {
  return {
    description: condition,
    expectation,
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'u1' },
    data: {},
  };
}

describe('path() builtin — through evaluator', () => {
  test("path('users/alice') is path", () => {
    const r = sim.simulate(
      rules("path('users/alice') is path"),
      [tc('path is path', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('path literal /foo/$(x) is path', () => {
    const r = sim.simulate(
      rules("/databases/$(database)/documents/users/alice is path"),
      [tc('literal is path', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("path() == path() with same string is true", () => {
    const r = sim.simulate(
      rules("path('users/alice') == path('users/alice')"),
      [tc('path equality', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("path() != path() with different string is true", () => {
    const r = sim.simulate(
      rules("path('users/alice') != path('users/bob')"),
      [tc('path inequality', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('path() on non-string denies (real type error)', () => {
    const r = sim.simulate(
      rules("path(123) is path"),
      [tc('path on int denies', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('path is not string / not map (typeName specificity)', () => {
    const r = sim.simulate(
      rules("!(path('a/b') is string) && !(path('a/b') is map)"),
      [tc('path excluded from string/map', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("Path.bind() substitutes placeholders", () => {
    const r = sim.simulate(
      rules("path('users/{uid}').bind({'uid': 'alice'}) == path('users/alice')"),
      [tc('bind matches literal', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("Path.bind() with no matching placeholder returns same path", () => {
    const r = sim.simulate(
      rules("path('users/alice').bind({'uid': 'x'}) == path('users/alice')"),
      [tc('bind without placeholder', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("Path numeric index returns segment", () => {
    const r = sim.simulate(
      rules("path('users/alice')[1] == 'alice'"),
      [tc('path[1] segment', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("path(path(x)) rejects the non-string argument", () => {
    const r = sim.simulate(
      rules("path(path('users/alice')) == path('users/alice')"),
      [tc('path requires a string', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('unknown method on path → UNSUPPORTED', () => {
    const r = sim.simulate(
      rules("path('a/b').mystery() == 'x'"),
      [tc('unknown path method', 'ALLOW')],
    );
    expect(r.success && r.data.unsupported).toBe(1);
  });
});

describe('Path literal — get/exists still work after wrapper flip', () => {
  test('get(/databases/$(db)/documents/users/alice) — wrapper String() round-trips', () => {
    // No mock data, so .data is null → comparison fails → DENY. The
    // important thing is the path resolves correctly via toString() and
    // doesn't throw a type error.
    const r = sim.simulate(
      rules("get(/databases/$(database)/documents/users/alice).data.x == 1"),
      [tc('get with no mock denies', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});
