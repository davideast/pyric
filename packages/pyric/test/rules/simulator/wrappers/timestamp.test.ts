/**
 * Timestamp wrapper contract tests (Item 1.3) — equals + serialization +
 * coercion + 12-method dispatch + cross-type arithmetic with Duration +
 * `request.time` flip integration via the handler.
 */
import { describe, test, expect } from 'bun:test';
import { Timestamp } from '../../../../src/rules/simulator/wrappers/timestamp.js';
import { Duration } from '../../../../src/rules/simulator/wrappers/duration.js';
import { SimulateFirestoreRulesHandler } from '../../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../../../src/rules/firestore/test/spec.js';

// ─── Wrapper-level tests ───────────────────────────────────────────────────

describe('Timestamp — normalization (canonical form)', () => {
  test('overflow nanos roll into seconds', () => {
    const t = new Timestamp(0, 1_500_000_000); // 1.5s past epoch
    expect(t.seconds).toBe(1);
    expect(t.nanos).toBe(500_000_000);
  });

  test('negative nanos borrow a second (always non-negative)', () => {
    const t = new Timestamp(0, -1);
    expect(t.seconds).toBe(-1);
    expect(t.nanos).toBe(999_999_999);
  });
});

describe('Timestamp — equals (0.B contract)', () => {
  test('two instances with same fields are value-equal', () => {
    const a = Timestamp.fromMillis(1_700_000_000_000);
    const b = Timestamp.fromMillis(1_700_000_000_000);
    expect(a === b).toBe(false);
    expect(a.equals(b)).toBe(true);
  });

  test('different construction paths converge to same Timestamp', () => {
    const a = Timestamp.fromYMD(2030, 1, 1);
    const b = Timestamp.fromMillis(Date.UTC(2030, 0, 1));
    expect(a.equals(b)).toBe(true);
  });

  test('not equal to non-Timestamp values', () => {
    const t = Timestamp.fromMillis(0);
    expect(t.equals(null)).toBe(false);
    expect(t.equals(0)).toBe(false);
    expect(t.equals('1970-01-01T00:00:00.000Z')).toBe(false);
    expect(t.equals({ seconds: 0, nanos: 0 })).toBe(false);
  });
});

describe('Timestamp — serialization (0.B contract)', () => {
  test('toJSON shape', () => {
    const t = new Timestamp(1_700_000_000, 123_456_789);
    expect(JSON.parse(JSON.stringify(t))).toEqual({
      __type: 'timestamp',
      seconds: 1_700_000_000,
      nanos: 123_456_789,
    });
  });

  test('toString — ISO-8601 UTC with 9-digit nanos', () => {
    expect(String(new Timestamp(0, 0))).toBe('1970-01-01T00:00:00.000000000Z');
    expect(String(new Timestamp(0, 500_000_000))).toBe('1970-01-01T00:00:00.500000000Z');
    expect(String(new Timestamp(0, 1))).toBe('1970-01-01T00:00:00.000000001Z');
  });
});

describe('Timestamp — coercion (0.B contract)', () => {
  test('valueOf returns toMillis (ms since epoch)', () => {
    const t = Timestamp.fromMillis(1_700_000_123);
    expect(t.valueOf()).toBe(1_700_000_123);
    expect(Number(t)).toBe(1_700_000_123);
  });
});

describe('Timestamp — instance methods (12 total)', () => {
  // 2030-01-15T13:45:30.500000000Z — picked to exercise every component.
  const t = new Timestamp(Math.floor(Date.UTC(2030, 0, 15, 13, 45, 30) / 1000), 500_000_000);

  test('seconds() — epoch-seconds', () => {
    expect(t.callMethod('seconds', [])).toBe(Math.floor(Date.UTC(2030, 0, 15, 13, 45, 30) / 1000));
  });

  test('nanos() — sub-second nanos', () => {
    expect(t.callMethod('nanos', [])).toBe(500_000_000);
  });

  test('toMillis() — epoch-ms', () => {
    expect(t.callMethod('toMillis', [])).toBe(Date.UTC(2030, 0, 15, 13, 45, 30) + 500);
  });

  test('year() / month() / day() — UTC date components, month 1-based', () => {
    expect(t.callMethod('year', [])).toBe(2030);
    expect(t.callMethod('month', [])).toBe(1);
    expect(t.callMethod('day', [])).toBe(15);
  });

  test('hours() / minutes() — UTC time-of-day components', () => {
    expect(t.callMethod('hours', [])).toBe(13);
    expect(t.callMethod('minutes', [])).toBe(45);
  });

  test('dayOfWeek() — ISO 8601: Mon=1 .. Sun=7', () => {
    // 2030-01-15 is a Tuesday → 2
    expect(t.callMethod('dayOfWeek', [])).toBe(2);
    // Sunday: 2030-01-13
    expect(Timestamp.fromYMD(2030, 1, 13).callMethod('dayOfWeek', [])).toBe(7);
    // Monday: 2030-01-14
    expect(Timestamp.fromYMD(2030, 1, 14).callMethod('dayOfWeek', [])).toBe(1);
  });

  test('dayOfYear() — Jan 15 is day 15', () => {
    expect(t.callMethod('dayOfYear', [])).toBe(15);
    expect(Timestamp.fromYMD(2030, 1, 1).callMethod('dayOfYear', [])).toBe(1);
    // Leap year sanity: 2024-12-31 → 366
    expect(Timestamp.fromYMD(2024, 12, 31).callMethod('dayOfYear', [])).toBe(366);
  });

  test('date() — returns midnight-UTC Timestamp of same day', () => {
    const d = t.callMethod('date', []) as Timestamp;
    expect(d).toBeInstanceOf(Timestamp);
    expect(d.equals(Timestamp.fromYMD(2030, 1, 15))).toBe(true);
  });

  test('time() — returns Duration of time-of-day, preserves sub-second nanos', () => {
    const d = t.callMethod('time', []) as Duration;
    expect(d).toBeInstanceOf(Duration);
    // 13h 45m 30s + 500_000_000 nanos = (13*3600 + 45*60 + 30) sec + 500_000_000 ns
    const expected = Duration.fromTime(13, 45, 30, 500_000_000);
    expect(d.equals(expected)).toBe(true);
  });

  test('unknown method returns NO_OP', () => {
    expect(t.callMethod('toIsoString', [])).toBe(
      Symbol.for('pyric.RulesValue.NO_OP'),
    );
  });
});

describe('Timestamp — binaryOp cross-type', () => {
  const t1 = Timestamp.fromMillis(1_000_000); // 1000s after epoch
  const t2 = Timestamp.fromMillis(1_500_000); // 1500s after epoch
  const oneSecond = Duration.fromValue(1, 's');

  test('Timestamp - Timestamp → Duration', () => {
    const d = t2.binaryOp('-', t1) as Duration;
    expect(d).toBeInstanceOf(Duration);
    expect(d.equals(Duration.fromValue(500, 's'))).toBe(true);
  });

  test('Timestamp + Duration → Timestamp', () => {
    const t = t1.binaryOp('+', oneSecond) as Timestamp;
    expect(t).toBeInstanceOf(Timestamp);
    expect(t.equals(Timestamp.fromMillis(1_001_000))).toBe(true);
  });

  test('Timestamp - Duration → Timestamp', () => {
    const t = t1.binaryOp('-', oneSecond) as Timestamp;
    expect(t).toBeInstanceOf(Timestamp);
    expect(t.equals(Timestamp.fromMillis(999_000))).toBe(true);
  });

  test('comparison: < <= > >=', () => {
    expect(t1.binaryOp('<', t2)).toBe(true);
    expect(t2.binaryOp('>', t1)).toBe(true);
    expect(t1.binaryOp('<=', t1)).toBe(true);
    expect(t2.binaryOp('>=', t1)).toBe(true);
  });

  test('Timestamp + Timestamp returns NO_OP (no defined op)', () => {
    expect(t1.binaryOp('+', t2)).toBe(
      Symbol.for('pyric.RulesValue.NO_OP'),
    );
  });
});

// ─── Integration tests through the evaluator ───────────────────────────────

const sim = new SimulateFirestoreRulesHandler();

function rules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /events/{eid} {
      allow create: if ${condition};
    }
  }
}`;
}

function tc(condition: string, expectation: 'ALLOW' | 'DENY', extras: Partial<TestCase> = {}): TestCase {
  return {
    description: condition,
    expectation,
    method: 'create',
    path: 'events/e1',
    auth: { uid: 'u1' },
    data: {},
    ...extras,
  };
}

describe('Timestamp — through evaluator', () => {
  test('timestamp.value() returns a Timestamp (is timestamp)', () => {
    const r = sim.simulate(
      rules('timestamp.value(0) is timestamp'),
      [tc('is timestamp', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('timestamp is not number / map (Item 1.0 dispatch hooks)', () => {
    const r = sim.simulate(
      rules('!(timestamp.value(0) is number) && !(timestamp.value(0) is map)'),
      [tc('timestamp excluded from number/map', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('timestamp.date() and timestamp.value() converge on equality', () => {
    const r = sim.simulate(
      rules(`timestamp.date(2030, 1, 1) == timestamp.value(${Date.UTC(2030, 0, 1)})`),
      [tc('equality across construction paths', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('comparison: timestamp.date(2099,..) > timestamp.date(2025,..)', () => {
    const r = sim.simulate(
      rules('timestamp.date(2099, 1, 1) > timestamp.date(2025, 1, 1)'),
      [tc('comparison', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('Timestamp + Duration → Timestamp (cross-type)', () => {
    const r = sim.simulate(
      rules(
        `timestamp.value(0) + duration.value(60, 's') == timestamp.value(60000)`,
      ),
      [tc('Timestamp + Duration', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('Timestamp - Timestamp → Duration', () => {
    const r = sim.simulate(
      rules(
        `timestamp.value(60000) - timestamp.value(0) == duration.value(60, 's')`,
      ),
      [tc('Timestamp - Timestamp', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('Duration + Timestamp via right-side commutative dispatch', () => {
    const r = sim.simulate(
      rules(
        `duration.value(60, 's') + timestamp.value(0) == timestamp.value(60000)`,
      ),
      [tc('Duration + Timestamp commutes', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('instance methods through evaluator', () => {
    const r = sim.simulate(
      rules(
        `timestamp.date(2030, 1, 15).year() == 2030 && ` +
          `timestamp.date(2030, 1, 15).month() == 1 && ` +
          `timestamp.date(2030, 1, 15).day() == 15 && ` +
          `timestamp.date(2030, 1, 15).dayOfWeek() == 2`,
      ),
      [tc('date components', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('toMillis() returns the epoch-ms', () => {
    const r = sim.simulate(
      rules(`timestamp.value(123456).toMillis() == 123456`),
      [tc('toMillis', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('Risk 2: timestamp + int → DENY (no silent type loss)', () => {
    const r = sim.simulate(
      rules('timestamp.value(0) + 1 > 0'),
      [tc('timestamp + int denies', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('unknown method on timestamp → UNSUPPORTED', () => {
    const r = sim.simulate(
      rules('timestamp.value(0).millennium() == 2000'),
      [tc('unknown method', 'ALLOW')],
    );
    expect(r.success && r.data.unsupported).toBe(1);
  });
});

describe('Timestamp — request.time flip (Risk 1)', () => {
  test('request.time is a Timestamp (is timestamp)', () => {
    const r = sim.simulate(
      rules('request.time is timestamp'),
      [tc('request.time type', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('request.time matches pinned tc.requestTime via timestamp.value', () => {
    // 2030-01-01T00:00:00.000Z = 1893456000000 ms
    const r = sim.simulate(
      rules('request.time == timestamp.value(1893456000000)'),
      [
        tc('pinned time matches', 'ALLOW', {
          requestTime: '2030-01-01T00:00:00.000Z',
        }),
      ],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('serverTimestamp sentinel resolves to the same Timestamp as request.time', () => {
    const r = sim.simulate(
      rules('request.resource.data.createdAt == request.time'),
      [
        {
          description: 'sentinel == request.time',
          expectation: 'ALLOW',
          method: 'create',
          path: 'events/e1',
          auth: { uid: 'u1' },
          data: { createdAt: { __type: 'serverTimestamp' } },
          requestTime: '2030-01-01T00:00:00.000Z',
        },
      ],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('multiple sentinel fields all equate to request.time', () => {
    const r = sim.simulate(
      rules(
        'request.resource.data.createdAt == request.time && ' +
          'request.resource.data.updatedAt == request.time',
      ),
      [
        {
          description: 'two sentinel fields',
          expectation: 'ALLOW',
          method: 'create',
          path: 'events/e1',
          auth: { uid: 'u1' },
          data: {
            createdAt: { __type: 'serverTimestamp' },
            updatedAt: { __type: 'serverTimestamp' },
          },
          requestTime: '2030-01-01T00:00:00.000Z',
        },
      ],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('request.time arithmetic with Duration works', () => {
    // request.time + 60s > request.time (always ALLOW for any wallclock)
    const r = sim.simulate(
      rules("request.time + duration.value(60, 's') > request.time"),
      [tc('request.time + duration', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});
