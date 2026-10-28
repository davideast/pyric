/**
 * Timestamp and duration range in the shared rules wrappers, against
 * production's captures in the Firestore int64-and-duration-range scenario
 * and the Storage xref-shared-language-semantics scenario.
 *
 * A timestamp outside 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999999999Z,
 * or a duration past the protobuf bound of 315,576,000,000 seconds, is
 * production's "Timestamp is not valid" or "Duration is not valid" error. It
 * is an error value: `|| true` absorbs it, and on its own it denies. A
 * non-finite instant builds no timestamp at all, so no caller can hand the
 * evaluator a NaN timestamp that is unequal to itself.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { Duration } from '../../../src/rules/simulator/wrappers/duration.js';
import { Timestamp } from '../../../src/rules/simulator/wrappers/timestamp.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

const TIMESTAMP_NOT_VALID =
  'Timestamp is not valid. Seconds must be in range [-62,135,596,800, +253,402,300,799]. Nanos must be in range [0, +999,999,999].';
const DURATION_NOT_VALID =
  'Duration is not valid. Seconds must be in range [-315,576,000,000, +315,576,000,000]. Nanos must be in range [-999,999,999, +999,999,999]. Nanos must have the same sign as seconds.';

const MAX_TIMESTAMP_MILLIS = 253402300799999;
const MIN_TIMESTAMP_SECONDS = -62135596800;

interface Verdict {
  decision: string;
  message?: string;
}

function firestore(condition: string): Verdict {
  const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} { allow get: if ${condition}; }
  }
}`;
  const res = new SimulateFirestoreRulesHandler().simulate(rules, [
    { description: 'case', method: 'get', path: 'c/1', requestTime: '2026-01-01T00:00:00Z' },
  ]);
  if (!res.success) throw new Error(res.error.message);
  const result = res.data.results[0]!;
  return { decision: result.decision, message: result.trace[0]?.message };
}

function storage(condition: string): boolean {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} { allow read: if ${condition}; }
  }
}`);
  return evaluateStorageRules(
    rules,
    { request: { auth: { uid: 'alice' }, method: 'read', path: 'b/pyric-default/o/docs/d1' }, resource: { size: 1 } },
    new Date('2026-01-01T00:00:00Z'),
  ).allowed;
}

const PAST_MAX = `timestamp.value(${MAX_TIMESTAMP_MILLIS}) + duration.value(1, 'ms')`;
const BEFORE_MIN = `timestamp.date(1, 1, 1) - duration.value(1, 'd')`;
const DURATION_PAST_BOUND = `duration.value(315576000001, 's')`;

describe('a timestamp past its range is an error value', () => {
  for (const [name, expr] of [['max plus 1 ms', PAST_MAX], ['min minus one day', BEFORE_MIN]] as const) {
    test(`Firestore: ${name} denies with production's message`, () => {
      const verdict = firestore(`${expr} > timestamp.value(0) || ${expr} <= timestamp.value(0)`);
      expect(verdict.decision).toBe('DENY');
      expect(verdict.message).toBe(TIMESTAMP_NOT_VALID);
    });

    test(`Firestore: ${name} is absorbed by || true`, () => {
      expect(firestore(`${expr} > timestamp.value(0) || true`).decision).toBe('ALLOW');
    });

    test(`Storage: ${name} denies both ways and is absorbed by || true`, () => {
      expect(storage(`${expr} > timestamp.value(0)`)).toBe(false);
      expect(storage(`!(${expr} > timestamp.value(0))`)).toBe(false);
      expect(storage(`${expr} > timestamp.value(0) || true`)).toBe(true);
    });
  }

  test('Firestore: epoch plus 315,576,000,000 s is not year 11970', () => {
    const verdict = firestore(`(timestamp.value(0) + duration.value(315576000000, 's')).year() == 11970`);
    expect(verdict.decision).toBe('DENY');
    expect(verdict.message).toBe(TIMESTAMP_NOT_VALID);
  });
});

describe('a duration past the protobuf bound is an error value', () => {
  test(`Firestore: duration.value() one second past the bound denies with production's message`, () => {
    const verdict = firestore(`${DURATION_PAST_BOUND} > duration.value(0, 's')`);
    expect(verdict.decision).toBe('DENY');
    expect(verdict.message).toBe(DURATION_NOT_VALID);
  });

  test('Firestore: the error is absorbed by || true', () => {
    expect(firestore(`${DURATION_PAST_BOUND} > duration.value(0, 's') || true`).decision).toBe('ALLOW');
  });

  test('Firestore: duration.value() at the bound evaluates', () => {
    expect(firestore(`duration.value(315576000000, 's') > duration.value(0, 's')`).decision).toBe('ALLOW');
  });

  test('Firestore: duration.time() past the bound is an error', () => {
    const verdict = firestore(`duration.time(87660001, 0, 0, 0) > duration.value(0, 's')`);
    expect(verdict.decision).toBe('DENY');
    expect(verdict.message).toBe(DURATION_NOT_VALID);
  });

  test('Firestore: duration arithmetic past the bound is an error', () => {
    const verdict = firestore(
      `duration.value(315576000000, 's') + duration.value(1, 's') > duration.value(0, 's')`,
    );
    expect(verdict.decision).toBe('DENY');
    expect(verdict.message).toBe(DURATION_NOT_VALID);
  });

  test('Storage: duration arithmetic past the bound denies both ways', () => {
    const sum = `duration.value(315576000000, 's') + duration.value(1, 's')`;
    expect(storage(`${sum} > duration.value(0, 's')`)).toBe(false);
    expect(storage(`!(${sum} > duration.value(0, 's'))`)).toBe(false);
    expect(storage(`${sum} > duration.value(0, 's') || true`)).toBe(true);
  });
});

describe('the wrappers refuse what production cannot hold', () => {
  test('Timestamp.fromMillis(NaN) throws', () => {
    expect(() => Timestamp.fromMillis(Number.NaN)).toThrow(TIMESTAMP_NOT_VALID);
  });

  test('Timestamp.fromMillis(Infinity) throws', () => {
    expect(() => Timestamp.fromMillis(Number.POSITIVE_INFINITY)).toThrow(TIMESTAMP_NOT_VALID);
  });

  test('Timestamp.fromIsoString of an unparseable string throws', () => {
    expect(() => Timestamp.fromIsoString('not a date')).toThrow(TIMESTAMP_NOT_VALID);
  });

  test('a timestamp one nanosecond before the minimum throws', () => {
    expect(() => new Timestamp(MIN_TIMESTAMP_SECONDS, -1)).toThrow(TIMESTAMP_NOT_VALID);
  });

  test('a duration one second past the bound throws', () => {
    expect(() => Duration.fromValue(315576000001, 's')).toThrow(DURATION_NOT_VALID);
    expect(() => new Duration(-315576000001, 0)).toThrow(DURATION_NOT_VALID);
  });
});

describe('in-range values are unchanged', () => {
  test('the range ends construct', () => {
    expect(new Timestamp(MIN_TIMESTAMP_SECONDS, 0).seconds).toBe(MIN_TIMESTAMP_SECONDS);
    expect(Timestamp.fromMillis(MAX_TIMESTAMP_MILLIS).toMillis()).toBe(MAX_TIMESTAMP_MILLIS);
    expect(new Timestamp(253402300799, 999_999_999).nanos).toBe(999_999_999);
    expect(new Duration(315576000000, 999_999_999).seconds).toBe(315576000000);
    expect(new Duration(-315576000000, -999_999_999).seconds).toBe(-315576000000);
  });

  test('timestamp and duration arithmetic inside the range', () => {
    expect(firestore(`timestamp.value(0) + duration.value(1, 'd') == timestamp.value(86400000)`).decision).toBe('ALLOW');
    expect(firestore(`request.time - duration.value(1, 'h') < request.time`).decision).toBe('ALLOW');
    expect(firestore(`timestamp.date(9999, 12, 31) - timestamp.date(1, 1, 1) > duration.value(0, 's')`).decision)
      .toBe('ALLOW');
    expect(storage(`request.time + duration.value(1, 'h') > request.time`)).toBe(true);
  });
});
