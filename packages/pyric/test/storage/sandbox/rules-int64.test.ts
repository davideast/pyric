/**
 * Rules ints are signed 64-bit integers in the Storage evaluator, against
 * production's captures in the Storage `h1-int64-precision`,
 * `xref-shared-language-semantics` and `conversion-functions` scenarios.
 *
 * Literals and int arithmetic keep every bit above 2^53. A result past the
 * int64 range is production's "Integer value is out of the range" error
 * value, which denies through `!` and which `|| true` absorbs, except
 * `MIN / -1`, which is `MIN`. A literal past the range does not compile.
 */
import { describe, expect, test } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

const INT_RANGE = 'Integer value is out of the [-9223372036854775808, 9223372036854775807] range.';
const MAX = '9223372036854775807';
const MIN = '(-9223372036854775807 - 1)';

function source(condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} { allow read, write: if ${condition}; }
  }
}`;
}

function evaluate(condition: string, metadata?: Record<string, string>) {
  const rules = parseStorageRules(source(condition));
  const request = metadata === undefined
    ? { auth: { uid: 'alice' }, method: 'read' as const, path: 'b/pyric-default/o/docs/d1' }
    : {
      auth: { uid: 'alice' },
      method: 'create' as const,
      path: 'b/pyric-default/o/docs/d1',
      resource: { size: 1, contentType: 'text/plain', metadata },
    };
  return evaluateStorageRules(
    rules,
    { request, resource: metadata === undefined ? { size: 1 } : null },
    new Date('2026-01-01T00:00:00Z'),
  );
}

function storage(condition: string, metadata?: Record<string, string>): boolean {
  return evaluate(condition, metadata).allowed;
}

describe('Storage: ints above 2^53 keep every bit', () => {
  for (const condition of [
    `${MAX} > 9223372036854775806`,
    '9007199254740993 != 9007199254740992',
    '9007199254740993 - 1 == 9007199254740992',
    "string(9007199254740993) == '9007199254740993'",
    "int('-9223372036854775808') == -9223372036854775808",
    `int(${MAX}) == ${MAX} && int(float('9.3e18')) == ${MAX} && int(float('-9.3e18')) == -9223372036854775808`,
    `math.abs(${MIN}) < 0 && math.abs(${MIN}) == ${MIN}`,
    `${MAX} is int && !(${MAX} is float)`,
    '[1, 2, 3][1] == 2 && [1, 2, 3][0:2] == [1, 2]',
  ]) {
    test(`${condition} allows`, () => {
      expect(storage(condition)).toBe(true);
    });
  }

  test('distinct ints above 2^53 are not equal', () => {
    expect(storage('9007199254740993 == 9007199254740992')).toBe(false);
  });

  test('int() of a metadata string keeps the low bit', () => {
    expect(storage('int(request.resource.metadata.v) == 9007199254740992', { v: '9007199254740993' })).toBe(false);
    expect(storage('int(request.resource.metadata.v) == 9007199254740993', { v: '9007199254740993' })).toBe(true);
  });
});

describe('Storage: int overflow is an error value', () => {
  for (const [name, expr] of [
    ['max plus one', `${MAX} + 1`],
    ['min minus one', `${MIN} - 1`],
    ['max times two', `${MAX} * 2`],
    ['negated min', `-${MIN}`],
  ] as const) {
    test(`${name} denies both ways with production's message`, () => {
      const positive = evaluate(`${expr} > 0`);
      expect(positive.allowed).toBe(false);
      expect(positive.reasons.join(' ')).toContain(INT_RANGE);
      expect(storage(`${expr} < 0`)).toBe(false);
      expect(storage(`!(${expr} == 0)`)).toBe(false);
    });

    test(`${name} is absorbed by || true`, () => {
      expect(storage(`(${expr} == 0) || true`)).toBe(true);
    });
  }

  test('min divided by minus one is min', () => {
    expect(storage(`${MIN} / -1 == ${MIN}`)).toBe(true);
  });
});

describe('Storage: int and float arithmetic is unchanged', () => {
  for (const condition of [
    '5 / 2.0 == 2.5',
    '1 + 1.5 == 2.5',
    '7 / 2 == 3 && -7 % 3 == -1',
    '2 > 1.5',
    'resource.size + 1 == 2',
    "duration.value(9007199254740993, 'ns').nanos() == 254740993",
    "-duration.value(1, 's') < duration.value(0, 's')",
  ]) {
    test(`${condition} allows`, () => {
      expect(storage(condition)).toBe(true);
    });
  }
});

describe('Storage: an int literal past int64 does not compile', () => {
  test('one past the max is an invalid number literal', () => {
    expect(() => parseStorageRules(source('9223372036854775808 > 0'))).toThrow('Invalid number literal 9223372036854775808');
  });

  test('the negated min compiles', () => {
    expect(() => parseStorageRules(source('-9223372036854775808 < 0'))).not.toThrow();
  });
});
