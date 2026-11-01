/**
 * Rules ints are signed 64-bit integers in the Firestore simulator, against
 * production's captures in the Firestore `int64-and-duration-range` and
 * `time-math-and-casts` scenarios.
 *
 * Literals and int arithmetic keep every bit above 2^53, so distinct values
 * never compare equal and `string()` prints the exact digits. A result past
 * the int64 range is production's "Integer value is out of the range" error,
 * an error value that `|| true` and `&& false` absorb, except `MIN / -1`,
 * which production returns as `MIN`. A literal past the range is refused at
 * compile with "Invalid number literal", and `-9223372036854775808` compiles.
 * Unary minus negates a duration.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

const INT_RANGE = 'Integer value is out of the [-9223372036854775808, 9223372036854775807] range.';
const MAX = '9223372036854775807';
const MIN = '(-9223372036854775807 - 1)';

interface Verdict {
  decision: string;
  message?: string;
}

function simulate(condition: string, data?: Record<string, unknown>) {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} { allow get: if ${condition}; }
  }
}`;
  return new SimulateFirestoreRulesHandler().simulate(rules, [
    {
      description: 'case',
      method: 'get',
      path: 'c/1',
      requestTime: '2026-01-01T00:00:00Z',
      ...(data === undefined ? {} : { resource: data }),
    },
  ]);
}

function firestore(condition: string, data?: Record<string, unknown>): Verdict {
  const res = simulate(condition, data);
  if (!res.success) throw new Error(res.error.message);
  const result = res.data.results[0]!;
  return { decision: result.decision, message: result.trace[0]?.message };
}

function compileError(condition: string): string | undefined {
  const res = simulate(condition);
  return res.success ? undefined : res.error.message;
}

describe('Firestore: ints above 2^53 keep every bit', () => {
  for (const condition of [
    `${MAX} > 9223372036854775806`,
    `${MAX} != 9223372036854775806`,
    '9007199254740993 != 9007199254740992',
    '9007199254740993 - 9007199254740992 == 1',
    "int('9007199254740993') - int('9007199254740992') == 1",
    "string(9007199254740993) == '9007199254740993'",
    `string(${MAX}) == '${MAX}'`,
    "string(-9223372036854775808) == '-9223372036854775808'",
    `-9223372036854775808 == ${MIN}`,
    "int('-9223372036854775808') == -9223372036854775808",
    `int(float('9.3e18')) == ${MAX} && int(float('-9.3e18')) == -9223372036854775808`,
    `math.abs(${MIN}) == ${MIN}`,
    '9007199254740992 + [1].size() == 9007199254740993',
    `${MAX} is int && !(${MAX} is float)`,
    '[9007199254740993] != [9007199254740992]',
    '!(9007199254740992 in [9007199254740993])',
  ]) {
    test(`${condition} allows`, () => {
      expect(firestore(condition).decision).toBe('ALLOW');
    });
  }

  test('distinct ints above 2^53 are not equal', () => {
    expect(firestore('9007199254740993 == 9007199254740992').decision).toBe('DENY');
  });
});

describe('Firestore: int overflow is an error value', () => {
  for (const [name, expr] of [
    ['max plus one', `${MAX} + 1`],
    ['min minus one', `${MIN} - 1`],
    ['max times two', `${MAX} * 2`],
    ['negated min', `-${MIN}`],
  ] as const) {
    test(`${name} denies with production's message, both ways`, () => {
      expect(firestore(`${expr} > 0`)).toEqual({ decision: 'DENY', message: INT_RANGE });
      expect(firestore(`!(${expr} > 0)`)).toEqual({ decision: 'DENY', message: INT_RANGE });
    });

    test(`${name} is absorbed by || true and && false`, () => {
      expect(firestore(`(${expr} > 0) || true`).decision).toBe('ALLOW');
      expect(firestore(`!((${expr} > 0) && false)`).decision).toBe('ALLOW');
    });
  }

  test('min divided by minus one is min', () => {
    expect(firestore(`${MIN} / -1 == ${MIN}`).decision).toBe('ALLOW');
  });

  test('int division and modulo still truncate toward zero, and by zero is an error', () => {
    expect(firestore('7 / 2 == 3 && -7 / 2 == -3 && 7 % 3 == 1 && -7 % 3 == -1').decision).toBe('ALLOW');
    expect(firestore('1 / 0 == 0').message).toBe('Divide by zero error.');
  });
});

describe('Firestore: int and float arithmetic is unchanged', () => {
  for (const condition of [
    '5 / 2.0 == 2.5',
    '1 + 1.5 == 2.5',
    '2.5 - 1 == 1.5',
    '1 == 1.0',
    '2 > 1.5 && 1.5 < 2',
    'int(2.7) == 2',
    'float(3) == 3.0 && float(3) is float',
    'math.round(2.5) == 3 && math.floor(3) == 3.0',
    "string(1.0) == '1.0' && string(7) == '7'",
    '[1, 2, 3][1] == 2 && [1, 2, 3][0:2] == [1, 2]',
    "'abc'.size() == 3 && [1, 2].size() == 2",
    '[1, 1.0].toSet().size() == 1',
    "{'a': 1} == {'a': 1}",
    '!([1] == [1.0])',
  ]) {
    test(`${condition} allows`, () => {
      expect(firestore(condition).decision).toBe('ALLOW');
    });
  }

  test('an int from document data computes with int literals', () => {
    expect(firestore('resource.data.n + 1 == 6 && resource.data.n is int', { n: 5 }).decision).toBe('ALLOW');
    expect(firestore('resource.data.n * 2 == 3.0', { n: 1.5 }).decision).toBe('ALLOW');
  });
});

describe('Firestore: time values take ints', () => {
  for (const condition of [
    'timestamp.value(1000).toMillis() == 1000',
    'timestamp.date(2026, 1, 1).year() == 2026',
    "duration.value(9007199254740993, 'ns').seconds() == 9007199",
    "duration.value(9007199254740993, 'ns').nanos() == 254740993",
    'duration.time(1, 0, 0, 0).seconds() == 3600',
  ]) {
    test(`${condition} allows`, () => {
      expect(firestore(condition).decision).toBe('ALLOW');
    });
  }
});

describe('Firestore: unary minus negates a duration', () => {
  for (const condition of [
    "-duration.value(1, 's') == duration.value(-1, 's')",
    "-duration.value(1, 's') < duration.value(0, 's')",
    "request.time - (-duration.value(1, 'h')) > request.time",
  ]) {
    test(`${condition} allows`, () => {
      expect(firestore(condition).decision).toBe('ALLOW');
    });
  }
});

describe('Firestore: an int literal past int64 is refused at compile', () => {
  test('one past the max is an invalid number literal', () => {
    expect(compileError('9223372036854775808 > 0')).toContain('Invalid number literal 9223372036854775808');
  });

  test('a negated literal one past the min is an invalid number literal', () => {
    expect(compileError('-9223372036854775809 < 0')).toContain('Invalid number literal 9223372036854775809');
  });

  test('the negated min compiles', () => {
    expect(compileError('-9223372036854775808 < 0')).toBeUndefined();
  });
});

describe('Firestore: a result carrying an int above 2^53 serializes', () => {
  test('the trace holds JSON values', () => {
    const res = simulate('[9007199254740993, 1] != [] && 9007199254740993 > 1');
    expect(res.success).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toContain('"9007199254740993"');
  });
});
