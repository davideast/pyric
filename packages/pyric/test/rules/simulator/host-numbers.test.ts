/**
 * A JavaScript number from a host value is typed as the Firebase SDKs send
 * it, in Firestore and Storage rules alike (#1781).
 *
 * The web SDK sends a number as an `integerValue` only when it is a safe
 * integer other than `-0` (`isSafeInteger` in `@firebase/firestore` 4.14.1),
 * and the Admin SDK applies the same rule (`@google-cloud/firestore` 7.11.6
 * `serializer.js`). Every other number is a `doubleValue`, which production's
 * rules read as a float. So `2 ** 53`, `2 ** 53 + 2`, `1e300` and `-0` in a
 * document are floats: `is float` holds, `is int` does not, and `+ 0`
 * computes a float rather than the int64 range error.
 *
 * The boundary values come from the SDKs' source, not from a rules capture:
 * no production capture yet records a rules verdict on a document written
 * with 2^53, -2^53, -2^63 or -0. These tests pin the SDK reasoning.
 *
 * Token claims are not SDK values. They reach the rules as JSON inside an ID
 * token, and the sign-in captures record integral claims as ints, so an
 * integral claim inside int64 stays an int at 2^53 and past. A claim past
 * int64, or with a fraction, is a bare number that reads as a float.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { hostNumber, isHostIntNumber } from '../../../src/rules/simulator/rules-int.js';
import { RulesFloat } from '../../../src/rules/simulator/wrappers/float.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { encodeValue } from '../../../src/firestore/sandbox/wire-encoder.js';

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const FLOATS: ReadonlyArray<readonly [string, number]> = [
  ['2^53', 2 ** 53],
  ['2^53 + 2', 2 ** 53 + 2],
  ['1e300', 1e300],
  ['-2^53', -(2 ** 53)],
  ['-2^63', -(2 ** 63)],
  ['2^63', 2 ** 63],
];

describe('isHostIntNumber: the SDKs send only a safe integer other than -0 as an int', () => {
  const ints = [0, 1, -1, SAFE_MAX, -SAFE_MAX];
  const doubles = [2 ** 53, 2 ** 53 + 2, 1e300, -(2 ** 53), -(2 ** 63), -0, 1.5, NaN, Infinity, -Infinity];
  for (const value of ints) {
    test(`${value} is an int`, () => {
      expect(isHostIntNumber(value)).toBe(true);
      expect(hostNumber(value)).toBe(value);
    });
  }
  for (const value of doubles) {
    test(`${Object.is(value, -0) ? '-0' : value} is a float`, () => {
      expect(isHostIntNumber(value)).toBe(false);
      const typed = hostNumber(value);
      expect(typed).toBeInstanceOf(RulesFloat);
      expect(Object.is((typed as RulesFloat).value, value)).toBe(true);
    });
  }
});

describe('wire encoder: a number past the safe range is a doubleValue, as the SDKs send it', () => {
  test('2^53, 2^53 + 2, 1e300 and -0 are doubles', () => {
    expect(encodeValue(2 ** 53)).toEqual({ doubleValue: 2 ** 53 });
    expect(encodeValue(2 ** 53 + 2)).toEqual({ doubleValue: 2 ** 53 + 2 });
    expect(encodeValue(1e300)).toEqual({ doubleValue: 1e300 });
    expect(Object.is(encodeValue(-0).doubleValue, -0)).toBe(true);
  });

  test('the largest safe integer is still an integerValue', () => {
    expect(encodeValue(SAFE_MAX)).toEqual({ integerValue: String(SAFE_MAX) });
    expect(encodeValue(-SAFE_MAX)).toEqual({ integerValue: String(-SAFE_MAX) });
  });
});

function firestoreSource(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} { allow get, create: if ${condition}; }
  }
}`;
}

/** The decision for a get of a document holding `n`, or a create carrying it. */
function firestore(
  condition: string,
  n: number,
  options: { method?: 'get' | 'create'; publicCases?: boolean; token?: Record<string, unknown> } = {},
): string {
  return firestoreResult(condition, n, options).decision;
}

/** The first result of a get or create of a document holding `n`. */
function firestoreResult(
  condition: string,
  n: number,
  options: { method?: 'get' | 'create'; publicCases?: boolean; token?: Record<string, unknown> } = {},
) {
  const method = options.method ?? 'get';
  const data = { n };
  const res = new SimulateFirestoreRulesHandler().simulate(firestoreSource(condition), [
    {
      description: 'case',
      expectation: 'ALLOW',
      method,
      path: 'c/1',
      requestTime: '2026-01-01T00:00:00Z',
      ...(options.token === undefined ? {} : { auth: { uid: 'alice', token: options.token } }),
      ...(method === 'get' ? { resource: data } : { data }),
    },
  ], { publicCases: options.publicCases });
  if (!res.success) throw new Error(res.error.message);
  return res.data.results[0]!;
}

describe('Firestore: an integral token claim inside int64 stays an int', () => {
  for (const [name, value] of [['2^53', 2 ** 53], ['2^53 + 2', 2 ** 53 + 2]] as const) {
    test(`request.auth.token.n = ${name} is an int, not a float`, () => {
      const token = { n: value };
      expect(firestore('request.auth.token.n is int && !(request.auth.token.n is float)', 0, { token })).toBe('ALLOW');
      expect(firestore('request.auth.token.n is float', 0, { token })).toBe('DENY');
    });
  }

  test('a nested integral claim is an int too', () => {
    const token = { nested: { n: 2 ** 53 } };
    expect(firestore('request.auth.token.nested.n is int', 0, { token })).toBe('ALLOW');
    expect(firestore('request.auth.token.nested.n is float', 0, { token })).toBe('DENY');
  });

  test('a claim of exactly 2^63 is past int64, so it is a float', () => {
    const token = { n: 2 ** 63 };
    expect(firestore('request.auth.token.n is float && !(request.auth.token.n is int)', 0, { token })).toBe('ALLOW');
  });

  test('a claim with a fraction is a bare float that combines with a float literal', () => {
    const token = { f: 1.5 };
    expect(firestore('request.auth.token.f is float && !(request.auth.token.f is int)', 0, { token })).toBe('ALLOW');
    expect(firestore('request.auth.token.f - 1.0 == 0.5', 0, { token })).toBe('ALLOW');
  });

  test('a claim past int64 is a float, and error messages name it a float', () => {
    const token = { n: 1e300 };
    expect(firestore('request.auth.token.n is float', 0, { token })).toBe('ALLOW');
    const result = firestoreResult("request.auth.token.n + 'a' == 'a'", 0, { token });
    expect(result.decision).toBe('DENY');
    expect(JSON.stringify(result.trace)).toContain('between float and string');
  });
});

describe('Firestore: a host number past the safe range reads as a float', () => {
  for (const [name, value] of FLOATS) {
    test(`resource.data.n = ${name} is a float, not an int`, () => {
      expect(firestore('resource.data.n is float && !(resource.data.n is int)', value)).toBe('ALLOW');
      expect(firestore('resource.data.n is int', value)).toBe('DENY');
    });

    test(`request.resource.data.n = ${name} is a float`, () => {
      expect(firestore('request.resource.data.n is float', value, { method: 'create' })).toBe('ALLOW');
      expect(firestore('request.resource.data.n is int', value, { method: 'create' })).toBe('DENY');
    });

    test(`a public case literal ${name} is a float`, () => {
      expect(firestore('resource.data.n is float', value, { publicCases: true })).toBe('ALLOW');
    });

    test(`resource.data.n = ${name} plus 0 is a float, not the int64 range error`, () => {
      expect(firestore('resource.data.n + 0 is float && resource.data.n + 0 == resource.data.n', value)).toBe('ALLOW');
    });
  }

  test('2^53 prints and converts as a float', () => {
    expect(firestore("string(resource.data.n) == '9.007199254740992E15'", 2 ** 53)).toBe('ALLOW');
    expect(firestore('int(resource.data.n) == 9007199254740992', 2 ** 53)).toBe('ALLOW');
    expect(firestore('resource.data.n == 9007199254740992.0', 2 ** 53)).toBe('ALLOW');
  });

  test('the largest safe integer is still an int', () => {
    expect(firestore('resource.data.n is int && resource.data.n + 1 == 9007199254740992', SAFE_MAX)).toBe('ALLOW');
    expect(firestore('resource.data.n is int', -SAFE_MAX)).toBe('ALLOW');
  });

  test('-0 is a float, as the SDKs send it', () => {
    expect(firestore("resource.data.n is float && string(resource.data.n) == '-0.0'", -0)).toBe('ALLOW');
    expect(firestore('resource.data.n is int', -0)).toBe('DENY');
  });

  test('a public case literal -0 is a float', () => {
    expect(firestore('resource.data.n is float', -0, { publicCases: true })).toBe('ALLOW');
    expect(firestore('resource.data.n is int', -0, { publicCases: true })).toBe('DENY');
  });

  test('a float index is an error value that || true and && false absorb, and ! keeps', () => {
    expect(firestore('([1][resource.data.n] == 1) || true', 2 ** 53)).toBe('ALLOW');
    expect(firestore('([1][resource.data.n] == 1) && false', 2 ** 53)).toBe('DENY');
    expect(firestore('!([1][resource.data.n] == 1)', 2 ** 53)).toBe('DENY');
  });
});

function storageSource(condition: string): string {
  return `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} { allow read: if ${condition}; }
  }
}`;
}

/** Whether a read is allowed, with `n` as `resource.size`, a token claim and a Firestore field. */
function storage(condition: string, n: number): boolean {
  const lookup = {
    get: (path: string) => (path === 'c/1' ? { n } : null),
    exists: (path: string) => path === 'c/1',
  };
  return evaluateStorageRules(
    parseStorageRules(storageSource(condition)),
    {
      request: { auth: { uid: 'alice', token: { n } }, method: 'read', path: 'b/pyric-default/o/docs/d1' },
      resource: { size: n },
    },
    new Date('2026-01-01T00:00:00Z'),
    lookup,
  ).allowed;
}

const LOOKUP = 'firestore.get(/databases/(default)/documents/c/1).data.n';

describe('Storage: a host number past the safe range reads as a float', () => {
  for (const [name, value] of FLOATS) {
    test(`a Firestore field of ${name} is a float, not an int`, () => {
      expect(storage(`${LOOKUP} is float && !(${LOOKUP} is int)`, value)).toBe(true);
      expect(storage(`${LOOKUP} is int`, value)).toBe(false);
      expect(storage(`${LOOKUP} + 0 is float && ${LOOKUP} + 0 == ${LOOKUP}`, value)).toBe(true);
    });
  }

  test('2^53 prints and converts as a float', () => {
    expect(storage(`string(${LOOKUP}) == '9.007199254740992E15'`, 2 ** 53)).toBe(true);
    expect(storage(`int(${LOOKUP}) == 9007199254740992`, 2 ** 53)).toBe(true);
  });

  for (const [name, value] of [['2^53', 2 ** 53], ['2^53 + 2', 2 ** 53 + 2]] as const) {
    test(`a token claim of ${name} is an int, not a float`, () => {
      expect(storage('request.auth.token.n is int && !(request.auth.token.n is float)', value)).toBe(true);
      expect(storage('request.auth.token.n is float', value)).toBe(false);
    });
  }

  test('the largest safe integer is still an int', () => {
    expect(storage('resource.size is int && resource.size + 1 == 9007199254740992', SAFE_MAX)).toBe(true);
  });

  test('a Firestore field holding -0 is a float, as the SDKs send it', () => {
    expect(storage(`${LOOKUP} is float`, -0)).toBe(true);
  });

  test('a float index is an error value that || true and && false absorb, and ! keeps', () => {
    expect(storage(`([1][${LOOKUP}] == 1) || true`, 2 ** 53)).toBe(true);
    expect(storage(`([1][${LOOKUP}] == 1) && false`, 2 ** 53)).toBe(false);
    expect(storage(`!([1][${LOOKUP}] == 1)`, 2 ** 53)).toBe(false);
  });
});
