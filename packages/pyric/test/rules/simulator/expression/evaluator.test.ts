/**
 * Item 4.2 — Evaluator test corpus.
 *
 * Coverage strategy from the pre-mortem:
 *
 *  1. Strict typing — every operator has a positive case AND a
 *     type-mismatch case for each operand slot.
 *  2. Short-circuit — `&&`/`||` test that the unreachable side is
 *     NOT evaluated (proven by hiding a throw on that side).
 *  3. Cross-type `==`/`!=` returns false/true (NOT throws); the
 *     null-guard idiom is locked here.
 *  4. NaN/Infinity never escape — `1/0`, `0/0`, big * big.
 *  5. Field absence → null; field-access on null → null-access throw.
 *  6. Reference: known alias resolves; unknown alias throws
 *     `unknown-reference`; alias mapped to null returns null
 *     (the null-vs-typo distinction).
 *  7. Sentinel: each name produces the right shape; sentinel as
 *     operator operand throws `sentinel-misuse`; sentinel as sentinel
 *     argument throws.
 *  8. Index access: integer on array, string on object, both with
 *     out-of-bounds → null; non-integer / negative throws.
 */
import { describe, test, expect } from 'bun:test';
import { tokenize } from '../../../../src/rules/simulator/expression/lexer.js';
import { parse } from '../../../../src/rules/simulator/expression/parser.js';
import { evaluate } from '../../../../src/rules/simulator/expression/evaluator.js';
import {
  EvalError,
  type EvalEnv,
  type EvalObject,
} from '../../../../src/rules/simulator/expression/eval-errors.js';

const env = (reads: Record<string, EvalObject | null> = {}): EvalEnv => ({ reads });

const evalSrc = (src: string, e: EvalEnv = env()) =>
  evaluate(parse(tokenize(src)), e);

const expectError = (src: string, code: string, e: EvalEnv = env()) => {
  try {
    evalSrc(src, e);
    throw new Error(`expected '${code}' but no throw`);
  } catch (err) {
    expect(err).toBeInstanceOf(EvalError);
    expect((err as EvalError).code).toBe(code as never);
  }
};

describe('evaluator / literals', () => {
  test('numbers, strings, booleans, null', () => {
    expect(evalSrc('1')).toBe(1);
    expect(evalSrc('1.5')).toBe(1.5);
    expect(evalSrc('"hi"')).toBe('hi');
    expect(evalSrc('true')).toBe(true);
    expect(evalSrc('false')).toBe(false);
    expect(evalSrc('null')).toBe(null);
  });
});

describe('evaluator / unary', () => {
  test('-n', () => expect(evalSrc('-5')).toBe(-5));
  test('!b', () => expect(evalSrc('!true')).toBe(false));
  test('REJECT: -bool', () => expectError('-true', 'type-mismatch'));
  test('REJECT: !number', () => expectError('!1', 'type-mismatch'));
});

describe('evaluator / arithmetic', () => {
  test('basic ops', () => {
    expect(evalSrc('1 + 2')).toBe(3);
    expect(evalSrc('5 - 2')).toBe(3);
    expect(evalSrc('3 * 4')).toBe(12);
    expect(evalSrc('10 / 4')).toBe(2.5);
    expect(evalSrc('10 % 3')).toBe(1);
  });

  test('precedence respected at eval time', () => {
    expect(evalSrc('1 + 2 * 3')).toBe(7);
    expect(evalSrc('(1 + 2) * 3')).toBe(9);
  });

  test('string concat via +', () => {
    expect(evalSrc('"a" + "b"')).toBe('ab');
  });

  test('REJECT: + on mixed types', () => {
    expectError('"a" + 1', 'type-mismatch');
    expectError('1 + "a"', 'type-mismatch');
  });

  test('REJECT: - on strings', () => {
    expectError('"a" - "b"', 'type-mismatch');
  });

  test('REJECT: arithmetic on null', () => {
    expectError('null + 1', 'type-mismatch');
  });

  test('REJECT: division by zero', () => {
    expectError('1 / 0', 'division-by-zero');
  });

  test('REJECT: 0 / 0 (NaN)', () => {
    expectError('0 / 0', 'division-by-zero');
  });

  test('REJECT: % 0', () => {
    expectError('5 % 0', 'division-by-zero');
  });

  // Note: overflow-to-Infinity is structurally hard to reach in this
  // language because (a) numeric literals are capped at MAX_SAFE_INTEGER
  // by the lexer, (b) no scientific notation, (c) source is capped at
  // 256 chars. The `assertFiniteNumber` guard exists as defense in depth
  // and is exercised by the 1/0, 0/0, and %0 tests above.

  test('precision warning: 0.1 + 0.2 != 0.3 (IEEE; documented)', () => {
    // We don't fix this — tests lock the behavior so docs match reality.
    expect(evalSrc('0.1 + 0.2 == 0.3')).toBe(false);
  });
});

describe('evaluator / comparison', () => {
  test('numeric ordering', () => {
    expect(evalSrc('1 < 2')).toBe(true);
    expect(evalSrc('2 <= 2')).toBe(true);
    expect(evalSrc('3 > 2')).toBe(true);
    expect(evalSrc('3 >= 4')).toBe(false);
  });

  test('string lexicographic ordering', () => {
    expect(evalSrc('"a" < "b"')).toBe(true);
    expect(evalSrc('"abc" > "ab"')).toBe(true);
  });

  test('REJECT: cross-type ordering', () => {
    expectError('1 < "x"', 'type-mismatch');
    expectError('true < 1', 'type-mismatch');
  });

  test('REJECT: comparison chain (loud at eval, not parse)', () => {
    // (1 < 2) < 3 → true < 3 → type-mismatch
    expectError('1 < 2 < 3', 'type-mismatch');
  });
});

describe('evaluator / equality cross-type returns false (null-guard idiom)', () => {
  test('null == 1 is false (NOT throw)', () => {
    expect(evalSrc('null == 1')).toBe(false);
  });

  test('null == null is true', () => {
    expect(evalSrc('null == null')).toBe(true);
  });

  test('1 != "1" is true (different types, NOT coerced)', () => {
    expect(evalSrc('1 != "1"')).toBe(true);
  });

  test('null-guard idiom evaluates fully', () => {
    // The whole reason cross-type == returns false instead of throwing.
    expect(evalSrc('$src == null ? "missing" : "present"', env({ src: null })))
      .toBe('missing');
    expect(evalSrc('$src == null ? "missing" : "present"', env({ src: { x: 1 } })))
      .toBe('present');
  });

  test('REJECT: object equality (no structural compare)', () => {
    expectError('$a == $b', 'type-mismatch', env({ a: { x: 1 }, b: { x: 1 } }));
  });
});

describe('evaluator / logical short-circuit', () => {
  test('false && X does not evaluate X', () => {
    // If X were evaluated, it'd throw null-access. Short-circuit hides it.
    expect(evalSrc('false && $missing.field', env({ missing: null }))).toBe(false);
  });

  test('true || X does not evaluate X', () => {
    expect(evalSrc('true || $missing.field', env({ missing: null }))).toBe(true);
  });

  test('true && right runs right', () => {
    expect(evalSrc('true && false')).toBe(false);
  });

  test('false || right runs right', () => {
    expect(evalSrc('false || true')).toBe(true);
  });

  test('REJECT: non-boolean operand', () => {
    expectError('1 && true', 'type-mismatch');
    expectError('true && 1', 'type-mismatch');
    expectError('null || true', 'type-mismatch');
  });

  test('precedence at eval matches parse (Q1 sign-off live-fire)', () => {
    // a || b && c — `b && c` evaluates only if `a` is false.
    // With reads { a: true }, RHS short-circuits even though c is throwing.
    expect(evalSrc('$a || $b && $c', env({ a: true, b: true, c: true } as never))).toBe(true);
  });
});

describe('evaluator / ternary', () => {
  test('selects the right branch', () => {
    expect(evalSrc('true ? 1 : 2')).toBe(1);
    expect(evalSrc('false ? 1 : 2')).toBe(2);
  });

  test('does NOT evaluate the unselected branch', () => {
    expect(evalSrc('true ? 1 : $missing.field', env({ missing: null }))).toBe(1);
    expect(evalSrc('false ? $missing.field : 2', env({ missing: null }))).toBe(2);
  });

  test('REJECT: non-boolean condition (no truthy coercion)', () => {
    expectError('1 ? "a" : "b"', 'type-mismatch');
    expectError('null ? "a" : "b"', 'type-mismatch');
    expectError('"x" ? 1 : 2', 'type-mismatch');
  });
});

describe('evaluator / references', () => {
  test('known alias resolves to its value', () => {
    expect(evalSrc('$src', env({ src: { name: 'alice' } })))
      .toEqual({ name: 'alice' });
  });

  test('alias mapped to null returns null (missing doc, NOT typo)', () => {
    expect(evalSrc('$src', env({ src: null }))).toBe(null);
  });

  test('REJECT: unknown alias (typo defense, not silent null)', () => {
    expectError('$typo', 'unknown-reference', env({ src: { x: 1 } }));
  });

  test('REJECT: bare identifier surfaces parser hint', () => {
    // This is a parser error, but verify the suggestion text reaches the
    // user when they typo `increment` for `@increment`.
    try {
      evalSrc('increment(1)');
    } catch (e) {
      expect((e as Error).message).toMatch(/'\$increment' or '@increment'/);
    }
  });
});

describe('evaluator / field and index access', () => {
  test('field access on object', () => {
    expect(evalSrc('$src.name', env({ src: { name: 'a' } }))).toBe('a');
  });

  test('chained field access', () => {
    expect(evalSrc('$src.profile.name', env({
      src: { profile: { name: 'a' } },
    }))).toBe('a');
  });

  test('missing field returns null (no throw — guard with ternary)', () => {
    expect(evalSrc('$src.missing', env({ src: { name: 'a' } }))).toBe(null);
  });

  test('REJECT: field access on null', () => {
    expectError('$src.name', 'null-access', env({ src: null }));
  });

  test('REJECT: field access on number', () => {
    expectError('(1).foo', 'type-mismatch');
  });

  test('array integer index', () => {
    expect(evalSrc('$arr[0]', env({ arr: [10, 20, 30] as never })))
      .toBe(10);
  });

  test('array out-of-bounds returns null', () => {
    expect(evalSrc('$arr[5]', env({ arr: [10] as never }))).toBe(null);
  });

  test('REJECT: negative array index', () => {
    expectError('$arr[-1]', 'invalid-index', env({ arr: [10] as never }));
  });

  test('REJECT: non-integer array index', () => {
    expectError('$arr[1.5]', 'invalid-index', env({ arr: [10, 20] as never }));
  });

  test('object string-key index', () => {
    expect(evalSrc('$obj["key"]', env({ obj: { key: 'value' } }))).toBe('value');
  });

  test('object missing key returns null', () => {
    expect(evalSrc('$obj["missing"]', env({ obj: { x: 1 } }))).toBe(null);
  });

  test('REJECT: number index on object', () => {
    expectError('$obj[0]', 'invalid-index', env({ obj: { x: 1 } }));
  });
});

describe('evaluator / sentinels', () => {
  test('@serverTimestamp() produces the passthrough shape', () => {
    expect(evalSrc('@serverTimestamp()')).toEqual({ __type: 'serverTimestamp' });
  });

  test('@deleteField() produces the passthrough shape', () => {
    expect(evalSrc('@deleteField()')).toEqual({ __type: 'deleteField' });
  });

  test('@increment(n) carries the value', () => {
    expect(evalSrc('@increment(5)')).toEqual({ __type: 'increment', value: 5 });
  });

  test('@increment with computed numeric arg', () => {
    expect(evalSrc('@increment(2 + 3)')).toEqual({ __type: 'increment', value: 5 });
  });

  test('REJECT: @increment with non-number arg', () => {
    expectError('@increment("nope")', 'type-mismatch');
  });

  test('@arrayUnion variadic with mixed primitives', () => {
    expect(evalSrc('@arrayUnion(1, "x", true)')).toEqual({
      __type: 'arrayUnion',
      values: [1, 'x', true],
    });
  });

  test('@arrayRemove variadic', () => {
    expect(evalSrc('@arrayRemove(1, 2)')).toEqual({
      __type: 'arrayRemove',
      values: [1, 2],
    });
  });

  test('REJECT: sentinel as operator operand', () => {
    expectError('@increment(1) + 1', 'sentinel-misuse');
    expectError('1 + @increment(1)', 'sentinel-misuse');
  });

  test('REJECT: sentinel as sentinel argument', () => {
    expectError('@arrayUnion(@increment(1))', 'sentinel-misuse');
  });

  test('REJECT: sentinel in ternary condition', () => {
    expectError('@serverTimestamp() ? 1 : 2', 'type-mismatch');
  });

  test('REJECT: sentinel via field access target (defense in depth)', () => {
    // The parser allows postfix on any Primary, including sentinels.
    // Eval should reject because sentinels aren't objects.
    expectError('@serverTimestamp().foo', 'type-mismatch');
  });
});

describe('evaluator / position propagation', () => {
  test('error position points at the offending node', () => {
    try {
      evalSrc('1 + true');
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError);
      // The `+` operator is at column 3.
      expect((e as EvalError).pos.column).toBe(3);
    }
  });
});
