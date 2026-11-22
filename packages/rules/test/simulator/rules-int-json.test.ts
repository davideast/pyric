import { describe, expect, test } from 'bun:test';
import {
  INT64_MAX,
  INT64_MIN,
  parseClaimJson,
  stringifyClaimJson,
  typeClaimNumbers,
} from '../../src/simulator/rules-int.js';

describe('parseClaimJson and stringifyClaimJson (#1817)', () => {
  test('keeps safe integers as JavaScript numbers', () => {
    const parsed = parseClaimJson(
      '{"zero":0,"negZero":-0,"small":42,"neg":-17,"maxSafe":9007199254740991,"minSafe":-9007199254740991}',
    ) as Record<string, unknown>;
    expect(parsed.zero).toBe(0);
    expect(typeof parsed.zero).toBe('number');
    expect(Object.is(parsed.negZero, -0)).toBe(true);
    expect(parsed.small).toBe(42);
    expect(parsed.neg).toBe(-17);
    expect(parsed.maxSafe).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeof parsed.maxSafe).toBe('number');
    expect(parsed.minSafe).toBe(Number.MIN_SAFE_INTEGER);
    expect(typeof parsed.minSafe).toBe('number');
  });

  test('preserves every bit of integral claims in [-(2^63), 2^63 - 1] past 2^53', () => {
    const json = [
      '{',
      '"pow53":9007199254740992,',
      '"pow53Plus1":9007199254740993,',
      '"negPow53":-9007199254740992,',
      '"negPow53Minus1":-9007199254740993,',
      '"maxInt64":9223372036854775807,',
      '"minInt64":-9223372036854775808,',
      '"nested":{"arr":[9007199254740993,-9007199254740993]}',
      '}',
    ].join('');
    const parsed = parseClaimJson(json) as {
      pow53: unknown;
      pow53Plus1: unknown;
      negPow53: unknown;
      negPow53Minus1: unknown;
      maxInt64: unknown;
      minInt64: unknown;
      nested: { arr: unknown[] };
    };
    expect(parsed.pow53).toBe(9007199254740992n);
    expect(parsed.pow53Plus1).toBe(9007199254740993n);
    expect(parsed.negPow53).toBe(-9007199254740992n);
    expect(parsed.negPow53Minus1).toBe(-9007199254740993n);
    expect(parsed.maxInt64).toBe(INT64_MAX);
    expect(parsed.minInt64).toBe(INT64_MIN);
    expect(parsed.nested.arr).toEqual([9007199254740993n, -9007199254740993n]);
  });

  test('decodes scientific notation exact int64 as bigint and fractions or out-of-range as number', () => {
    const parsed = parseClaimJson(
      '{"sciExact":9.007199254740993e15,"sciMax":9.223372036854775807e18,"pastMax":9223372036854775808,"huge":1e300,"frac":9007199254740993.5,"smallFrac":1.5}',
    ) as Record<string, unknown>;
    expect(parsed.sciExact).toBe(9007199254740993n);
    expect(parsed.sciMax).toBe(INT64_MAX);
    expect(typeof parsed.pastMax).toBe('number');
    expect(parsed.pastMax).toBe(2 ** 63);
    expect(typeof parsed.huge).toBe('number');
    expect(parsed.huge).toBe(1e300);
    expect(typeof parsed.frac).toBe('number');
    expect(parsed.smallFrac).toBe(1.5);
  });

  test('does not touch string values and guards __proto__ keys and invalid JSON', () => {
    const parsed = parseClaimJson(
      '{"str":"9007199254740993","escaped":"a\\"9007199254740993\\"b","__proto__":{"n":9007199254740993}}',
    ) as Record<string, unknown>;
    expect(parsed.str).toBe('9007199254740993');
    expect(parsed.escaped).toBe('a"9007199254740993"b');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    const protoField = Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value as Record<string, unknown>;
    expect(protoField.n).toBe(9007199254740993n);
    expect(({} as Record<string, unknown>).n).toBeUndefined();
    expect(() => parseClaimJson('{"n":9007199254740993')).toThrow(SyntaxError);
  });

  test('stringifyClaimJson emits bigint as raw JSON integer literals and handles cycles', () => {
    const json = stringifyClaimJson({
      n: 9007199254740993n,
      min: INT64_MIN,
      nested: [1, 9007199254740993n, undefined],
      omitted: undefined,
      toJsonObj: { toJSON: () => ({ inner: 9007199254740993n }) },
    });
    expect(json).toBe(
      '{"n":9007199254740993,"min":-9223372036854775808,"nested":[1,9007199254740993,null],"toJsonObj":{"inner":9007199254740993}}',
    );
    expect(parseClaimJson(json)).toEqual({
      n: 9007199254740993n,
      min: INT64_MIN,
      nested: [1, 9007199254740993n, null],
      toJsonObj: { inner: 9007199254740993n },
    });

    const cyclic: Record<string, unknown> = { n: 9007199254740993n };
    cyclic.self = cyclic;
    expect(() => stringifyClaimJson(cyclic)).toThrow(TypeError);
  });

  test('typeClaimNumbers keeps int64 bigints exact and converts out-of-range bigints to numbers', () => {
    const typed = typeClaimNumbers({
      exact: 9007199254740993n,
      max: INT64_MAX,
      min: INT64_MIN,
      over: INT64_MAX + 1n,
      under: INT64_MIN - 1n,
      safe: 42,
      frac: 1.5,
    }) as Record<string, unknown>;
    expect(typed.exact).toBe(9007199254740993n);
    expect(typed.max).toBe(INT64_MAX);
    expect(typed.min).toBe(INT64_MIN);
    expect(typeof typed.over).toBe('number');
    expect(typed.over).toBe(2 ** 63);
    expect(typeof typed.under).toBe('number');
    expect(typed.safe).toBe(42n);
    expect(typed.frac).toBe(1.5);
  });
});
