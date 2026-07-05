/**
 * Duration wrapper contract tests (Item 1.2) — equals + serialization +
 * coercion + method dispatch + namespace constructors (value/time/abs)
 * + arithmetic and comparison through the evaluator + Risk 2 EvalError
 * for cross-type arithmetic.
 */
import { describe, test, expect } from 'bun:test';
import { Duration } from '../../../../src/rules/simulator/wrappers/duration.js';
import { SimulateFirestoreRulesHandler } from '../../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../../../src/rules/firestore/test/spec.js';

// ─── Wrapper-level tests ───────────────────────────────────────────────────

describe('Duration — normalization (canonical form)', () => {
  test('overflow nanos roll into seconds', () => {
    const d = new Duration(0, 1_500_000_000); // 1.5s
    expect(d.seconds).toBe(1);
    expect(d.nanos).toBe(500_000_000);
  });

  test('positive seconds + negative nanos canonicalize', () => {
    const d = new Duration(1, -500_000_000); // 0.5s
    expect(d.seconds).toBe(0);
    expect(d.nanos).toBe(500_000_000);
  });

  test('negative seconds + positive nanos canonicalize', () => {
    const d = new Duration(-1, 500_000_000); // -0.5s
    expect(d.seconds).toBe(0);
    expect(d.nanos).toBe(-500_000_000);
  });

  test('canonical form has same sign for both fields', () => {
    const d = new Duration(-1, -500_000_000); // already canonical
    expect(d.seconds).toBe(-1);
    expect(d.nanos).toBe(-500_000_000);
  });
});

describe('Duration — equals (0.B contract)', () => {
  test('two instances with same fields are value-equal', () => {
    const a = new Duration(60, 0);
    const b = new Duration(60, 0);
    expect(a === b).toBe(false);
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
  });

  test('values produced via different construction paths are equal', () => {
    // 1 hour = 3600s, in two equivalent constructions
    const a = Duration.fromValue(1, 'h');
    const b = Duration.fromValue(3600, 's');
    const c = Duration.fromTime(1, 0, 0, 0);
    expect(a.equals(b)).toBe(true);
    expect(b.equals(c)).toBe(true);
  });

  test('not equal to non-Duration values', () => {
    expect(new Duration(0, 0).equals(null)).toBe(false);
    expect(new Duration(0, 0).equals(0)).toBe(false);
    expect(new Duration(0, 0).equals({ seconds: 0, nanos: 0 })).toBe(false);
  });
});

describe('Duration — serialization (0.B contract)', () => {
  test('toJSON shape', () => {
    const d = Duration.fromValue(1500, 'ms'); // 1.5s
    expect(JSON.parse(JSON.stringify(d))).toEqual({
      __type: 'duration',
      seconds: 1,
      nanos: 500_000_000,
    });
  });

  test('toJSON round-trips through plain construction', () => {
    const d = new Duration(42, 123_456_789);
    const json = JSON.parse(JSON.stringify(d)) as { seconds: number; nanos: number };
    expect(new Duration(json.seconds, json.nanos).equals(d)).toBe(true);
  });
});

describe('Duration — coercion (0.B contract)', () => {
  test('toString format ${seconds}.${nanos}s zero-padded', () => {
    expect(String(new Duration(1, 500_000_000))).toBe('1.500000000s');
    expect(String(new Duration(5, 0))).toBe('5.000000000s');
    expect(String(new Duration(0, 1))).toBe('0.000000001s');
  });

  test('toString carries sign on integer part for negative durations', () => {
    expect(String(new Duration(-1, -500_000_000))).toBe('-1.500000000s');
    expect(String(new Duration(0, -500_000_000))).toBe('-0.500000000s');
  });

  test('valueOf returns approximate millis (legacy fallback)', () => {
    expect(Duration.fromValue(1500, 'ms').valueOf()).toBe(1500);
    expect(Duration.fromValue(1, 'h').valueOf()).toBe(3_600_000);
  });
});

describe('Duration — fromValue (namespace constructor)', () => {
  const cases: Array<[number, string, number, number]> = [
    [1, 'w', 7 * 24 * 60 * 60, 0],
    [1, 'd', 24 * 60 * 60, 0],
    [1, 'h', 3600, 0],
    [1, 'm', 60, 0],
    [60, 's', 60, 0],
    [1500, 'ms', 1, 500_000_000],
    [2500, 'ns', 0, 2500],
  ];
  for (const [mag, unit, sec, nanos] of cases) {
    test(`duration.value(${mag}, '${unit}') → {${sec}, ${nanos}}`, () => {
      const d = Duration.fromValue(mag, unit);
      expect(d.seconds).toBe(sec);
      expect(d.nanos).toBe(nanos);
    });
  }

  test('unknown unit throws', () => {
    expect(() => Duration.fromValue(1, 'years')).toThrow();
  });
});

describe('Duration — fromTime', () => {
  test('1h 30m 45s', () => {
    const d = Duration.fromTime(1, 30, 45, 0);
    expect(d.seconds).toBe(3600 + 30 * 60 + 45);
    expect(d.nanos).toBe(0);
  });

  test('nanos roll into seconds via normalization', () => {
    const d = Duration.fromTime(0, 0, 0, 1_500_000_000);
    expect(d.seconds).toBe(1);
    expect(d.nanos).toBe(500_000_000);
  });
});

describe('Duration — abs', () => {
  test('positive duration is unchanged', () => {
    const d = Duration.fromValue(60, 's');
    expect(Duration.abs(d).equals(d)).toBe(true);
  });

  test('negative duration becomes positive', () => {
    const d = new Duration(-60, 0);
    const a = Duration.abs(d);
    expect(a.seconds).toBe(60);
    expect(a.nanos).toBe(0);
  });

  test('mixed-magnitude negative duration', () => {
    const d = new Duration(-1, -500_000_000);
    const a = Duration.abs(d);
    expect(a.seconds).toBe(1);
    expect(a.nanos).toBe(500_000_000);
  });
});

describe('Duration — method dispatch', () => {
  test('seconds() / nanos() return signed fields', () => {
    const d = Duration.fromValue(1500, 'ms'); // {1, 500_000_000}
    expect(d.callMethod('seconds', [])).toBe(1);
    expect(d.callMethod('nanos', [])).toBe(500_000_000);
  });

  test('seconds() / nanos() are negative for negative durations', () => {
    const d = new Duration(-1, -500_000_000);
    expect(d.callMethod('seconds', [])).toBe(-1);
    expect(d.callMethod('nanos', [])).toBe(-500_000_000);
  });

  test('unknown method returns NO_OP', () => {
    expect(new Duration(0, 0).callMethod('millis', [])).toBe(
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
    match /timers/{tid} {
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
    path: 'timers/t1',
    auth: { uid: 'u1' },
    data: {},
  };
}

describe('Duration — through evaluator', () => {
  test('duration.value() returns a Duration (is duration)', () => {
    const r = sim.simulate(
      rules("duration.value(60, 's') is duration"),
      [tc('is duration', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('duration is not number / map (Item 1.0 dispatch hook)', () => {
    const r = sim.simulate(
      rules(
        "!(duration.value(60, 's') is number) && !(duration.value(60, 's') is map)",
      ),
      [tc('duration excluded from number/map', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('seconds() / nanos() instance methods', () => {
    const r = sim.simulate(
      rules(
        "duration.value(1500, 'ms').seconds() == 1 && duration.value(1500, 'ms').nanos() == 500000000",
      ),
      [tc('seconds and nanos', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('equality across two namespace calls', () => {
    const r = sim.simulate(
      rules("duration.value(1, 'h') == duration.value(3600, 's')"),
      [tc('equality across construction paths', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('inequality on different values', () => {
    const r = sim.simulate(
      rules("duration.value(1, 'h') != duration.value(2, 'h')"),
      [tc('inequality', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('comparison: > < >= <= work on Durations', () => {
    const r = sim.simulate(
      rules(
        "duration.value(2, 'h') > duration.value(1, 'h') && " +
          "duration.value(1, 'h') < duration.value(2, 'h') && " +
          "duration.value(60, 's') >= duration.value(60, 's') && " +
          "duration.value(30, 's') <= duration.value(60, 's')",
      ),
      [tc('comparison ops', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('Duration + Duration → Duration (still comparable)', () => {
    const r = sim.simulate(
      rules(
        "duration.value(1, 'h') + duration.value(30, 'm') == duration.value(90, 'm')",
      ),
      [tc('addition', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('Duration - Duration → Duration', () => {
    const r = sim.simulate(
      rules(
        "duration.value(1, 'h') - duration.value(30, 'm') == duration.value(30, 'm')",
      ),
      [tc('subtraction', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('duration.abs() of negative result', () => {
    const r = sim.simulate(
      rules(
        "duration.abs(duration.value(30, 'm') - duration.value(1, 'h')) == duration.value(30, 'm')",
      ),
      [tc('abs of negative', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('membership: duration in [duration list]', () => {
    const r = sim.simulate(
      rules(
        "duration.value(1, 'h') in [duration.value(30, 'm'), duration.value(60, 'm'), duration.value(90, 'm')]",
      ),
      [tc('duration in list', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('Risk 2: duration + int → DENY (no silent type loss)', () => {
    // Without the Risk 2 guard, the wrapper would fall through to
    // `(lv as number) + (rv as number)` which silently coerces via
    // valueOf() → millis. The rule "appears to work" but type info is
    // lost. The guard throws EvalError → handler maps to DENY.
    const r = sim.simulate(
      rules("duration.value(1, 'h') + 1 > 0"),
      [tc('duration + int denies', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('unknown method on duration → UNSUPPORTED (sim-gap signal)', () => {
    const r = sim.simulate(
      rules("duration.value(1, 'h').millis() == 3600000"),
      [tc('unknown method', 'ALLOW')],
    );
    expect(r.success && r.data.unsupported).toBe(1);
  });

  test('unknown duration namespace method → UNSUPPORTED', () => {
    const r = sim.simulate(
      rules('duration.parse("PT1H") is duration'),
      [tc('unknown namespace method', 'ALLOW')],
    );
    expect(r.success && r.data.unsupported).toBe(1);
  });
});
