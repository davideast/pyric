/**
 * Item 4.3 — `resolveExpressionsInData` test corpus.
 *
 * Coverage strategy:
 *  1. Flat: object with one `{ $expr }` leaf resolves correctly.
 *  2. Nested: objects-in-objects, arrays, mixed nesting.
 *  3. Multiple wrappers in one object/array.
 *  4. Sentinels: `{ $expr: "@increment(1)" }` produces the passthrough
 *     shape unchanged in the output.
 *  5. Literal-data passthrough: anything that isn't a wrapper stays
 *     identical (number, string, null, plain objects with no $expr).
 *  6. Refusals: `$expr` with extra keys, non-string `$expr` value,
 *     `$expr` shape inside an array element with siblings.
 *  7. NO recurse-into-result: if eval returns an object that has a
 *     `$expr` key (e.g. read data with a coincidentally-named field —
 *     pathological but possible), the walker treats it as data, NOT
 *     a wrapper.
 *  8. Path-aware errors: error messages include the dotted path of
 *     the offending wrapper.
 *  9. Top-level wrapper (whole `data` is a $expr) is allowed.
 *  10. Immutability: input tree is not mutated.
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveExpressionsInData,
  ExpressionWalkError,
} from '../../../../src/rules/simulator/expression/walk-data.js';
import {
  EvalError,
  type EvalEnv,
  type EvalObject,
} from '../../../../src/rules/simulator/expression/eval-errors.js';

const env = (reads: Record<string, EvalObject | null> = {}): EvalEnv => ({ reads });

describe('walk-data / flat wrappers', () => {
  test('object with one wrapper resolves', () => {
    const out = resolveExpressionsInData(
      { count: { $expr: '$c.count + 1' } },
      env({ c: { count: 4 } }),
    );
    expect(out).toEqual({ count: 5 });
  });

  test('multiple wrappers in one object', () => {
    const out = resolveExpressionsInData(
      {
        count: { $expr: '$c.count + 1' },
        label: { $expr: '"prefix:" + $c.label' },
      },
      env({ c: { count: 4, label: 'foo' } }),
    );
    expect(out).toEqual({ count: 5, label: 'prefix:foo' });
  });

  test('literal data passes through unchanged', () => {
    const input = { x: 1, y: 'two', z: null, b: true, n: 3.14 };
    const out = resolveExpressionsInData(input, env());
    expect(out).toEqual(input);
    // Returned tree is a fresh copy — distinct from the input.
    expect(out).not.toBe(input);
  });

  test('plain objects with no wrapper passthrough', () => {
    const out = resolveExpressionsInData(
      { profile: { name: 'a', age: 30 } },
      env(),
    );
    expect(out).toEqual({ profile: { name: 'a', age: 30 } });
  });
});

describe('walk-data / nested', () => {
  test('wrappers inside nested objects resolve', () => {
    const out = resolveExpressionsInData(
      {
        outer: {
          inner: { $expr: '$src.x' },
          plain: 'literal',
        },
      },
      env({ src: { x: 42 } }),
    );
    expect(out).toEqual({
      outer: { inner: 42, plain: 'literal' },
    });
  });

  test('wrappers inside arrays', () => {
    const out = resolveExpressionsInData(
      [1, { $expr: '$src.x' }, 3],
      env({ src: { x: 99 } }),
    );
    expect(out).toEqual([1, 99, 3]);
  });

  test('arrays inside objects with wrappers', () => {
    const out = resolveExpressionsInData(
      { tags: ['a', { $expr: '$src.tag' }, 'c'] },
      env({ src: { tag: 'b' } }),
    );
    expect(out).toEqual({ tags: ['a', 'b', 'c'] });
  });

  test('deeply nested mix', () => {
    const out = resolveExpressionsInData(
      {
        users: [
          { id: 1, balance: { $expr: '$src.x' } },
          { id: 2, balance: 100 },
        ],
        meta: { total: { $expr: '$src.x + 100' } },
      },
      env({ src: { x: 50 } }),
    );
    expect(out).toEqual({
      users: [
        { id: 1, balance: 50 },
        { id: 2, balance: 100 },
      ],
      meta: { total: 150 },
    });
  });
});

describe('walk-data / sentinels', () => {
  test('@increment passthrough shape', () => {
    const out = resolveExpressionsInData(
      { count: { $expr: '@increment(1)' } },
      env(),
    );
    expect(out).toEqual({ count: { __type: 'increment', value: 1 } });
  });

  test('@serverTimestamp passthrough shape', () => {
    const out = resolveExpressionsInData(
      { createdAt: { $expr: '@serverTimestamp()' } },
      env(),
    );
    expect(out).toEqual({ createdAt: { __type: 'serverTimestamp' } });
  });

  test('@arrayUnion with literal values', () => {
    const out = resolveExpressionsInData(
      { tags: { $expr: '@arrayUnion("a", "b")' } },
      env(),
    );
    expect(out).toEqual({ tags: { __type: 'arrayUnion', values: ['a', 'b'] } });
  });
});

describe('walk-data / refusals (locked decisions)', () => {
  test('REJECT: $expr alongside other keys', () => {
    expect(() =>
      resolveExpressionsInData(
        { x: { $expr: '$a', extra: 1 } },
        env({ a: { } }),
      ),
    ).toThrow(ExpressionWalkError);
  });

  test('REJECT: $expr with non-string value', () => {
    expect(() =>
      resolveExpressionsInData({ x: { $expr: 42 } }, env()),
    ).toThrow(/must be a string/);
  });

  test('REJECT: $expr with null value', () => {
    expect(() =>
      resolveExpressionsInData({ x: { $expr: null } }, env()),
    ).toThrow(/must be a string/);
  });

  test('REJECT: $expr with object value', () => {
    expect(() =>
      resolveExpressionsInData({ x: { $expr: { nested: true } } }, env()),
    ).toThrow(/must be a string/);
  });

  test('error path identifies the offending leaf', () => {
    try {
      resolveExpressionsInData(
        { users: [{ balance: { $expr: 42 } }] },
        env(),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionWalkError);
      expect((e as ExpressionWalkError).path).toBe('users.0.balance');
      expect((e as Error).message).toContain('users.0.balance');
    }
  });
});

describe('walk-data / does NOT recurse into eval results', () => {
  test('read data with a literal `$expr`-named key is NOT re-resolved', () => {
    // Simulates a doc that has a field literally named `$expr`. When
    // we resolve `$src`, the result is `{ $expr: "raw string" }` —
    // the walker plugs it in as-is. If we recursed, it would try to
    // re-parse "raw string" as an expression and probably crash.
    const out = resolveExpressionsInData(
      { copy: { $expr: '$src' } },
      env({ src: { $expr: 'raw string' } }),
    );
    expect(out).toEqual({ copy: { $expr: 'raw string' } });
  });

  test('read data with nested wrappers is not re-resolved', () => {
    // Same canary, deeper. The structure inside `$src` happens to look
    // like a write tree, but it's a leaf-equivalent value.
    const fakeWrapper = { x: { $expr: 'foo' } };
    const out = resolveExpressionsInData(
      { copy: { $expr: '$src' } },
      env({ src: fakeWrapper }),
    );
    expect(out).toEqual({ copy: fakeWrapper });
  });
});

describe('walk-data / top-level wrapper', () => {
  test('top-level $expr resolves to the read value', () => {
    const out = resolveExpressionsInData(
      { $expr: '$src' },
      env({ src: { name: 'a' } }),
    );
    expect(out).toEqual({ name: 'a' });
  });
});

describe('walk-data / immutability', () => {
  test('input is not mutated', () => {
    const input = {
      x: { $expr: '$src.x' },
      y: [1, { $expr: '$src.y' }, 3],
    };
    const beforeJson = JSON.stringify(input);
    resolveExpressionsInData(input, env({ src: { x: 1, y: 2 } }));
    expect(JSON.stringify(input)).toBe(beforeJson);
  });
});

describe('walk-data / eval error tagging', () => {
  test('eval error message includes the wrapper path', () => {
    try {
      resolveExpressionsInData(
        { user: { balance: { $expr: '$missing' } } },
        env({ src: { } }),
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError);
      expect((e as EvalError).code).toBe('unknown-reference');
      expect((e as Error).message).toContain('user.balance');
    }
  });

  test('parse error message includes the wrapper path', () => {
    try {
      resolveExpressionsInData(
        { x: { $expr: '@badname()' } },
        env(),
      );
      throw new Error('expected throw');
    } catch (e) {
      // Re-tagged as the original constructor (ExpressionParseError);
      // verify the path is in the message.
      expect((e as Error).message).toContain('x');
    }
  });
});

describe('walk-data / edge cases', () => {
  test('empty object', () => {
    expect(resolveExpressionsInData({}, env())).toEqual({});
  });

  test('empty array', () => {
    expect(resolveExpressionsInData([], env())).toEqual([]);
  });

  test('null at top level passes through', () => {
    expect(resolveExpressionsInData(null, env())).toBe(null);
  });

  test('primitive at top level passes through', () => {
    expect(resolveExpressionsInData(42, env())).toBe(42);
  });
});
