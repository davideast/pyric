/**
 * LatLng wrapper contract tests (Item 1.1) — equals + serialization +
 * coercion + method dispatch + namespace constructor + integration with
 * the evaluator's binaryOp / isExpr / inExpr hooks.
 */
import { describe, test, expect } from 'bun:test';
import { LatLng } from '../../../../src/rules/simulator/wrappers/latlng.js';
import { SimulateFirestoreRulesHandler } from '../../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../../../src/rules/firestore/test/spec.js';

// ─── Wrapper-level tests ───────────────────────────────────────────────────

describe('LatLng — equals (0.B contract)', () => {
  test('two instances with same coords are value-equal', () => {
    const a = new LatLng(37.7749, -122.4194);
    const b = new LatLng(37.7749, -122.4194);
    expect(a === b).toBe(false);    // distinct instances
    expect(a.equals(b)).toBe(true); // value-equal
    expect(b.equals(a)).toBe(true); // symmetric
  });

  test('different coords are not equal', () => {
    expect(new LatLng(0, 0).equals(new LatLng(0, 1))).toBe(false);
    expect(new LatLng(0, 0).equals(new LatLng(1, 0))).toBe(false);
  });

  test('not equal to non-LatLng values', () => {
    expect(new LatLng(0, 0).equals(null)).toBe(false);
    expect(new LatLng(0, 0).equals({ lat: 0, lng: 0 })).toBe(false);
    expect(new LatLng(0, 0).equals('0,0')).toBe(false);
  });
});

describe('LatLng — serialization (0.B contract)', () => {
  test('toJSON round-trips through plain construction', () => {
    const ll = new LatLng(37.7749, -122.4194);
    const json = JSON.parse(JSON.stringify(ll)) as {
      __type: string;
      lat: number;
      lng: number;
    };
    expect(json).toEqual({ __type: 'latlng', lat: 37.7749, lng: -122.4194 });
    const restored = new LatLng(json.lat, json.lng);
    expect(restored.equals(ll)).toBe(true);
  });
});

describe('LatLng — coercion (0.B contract)', () => {
  test('String() returns "lat,lng"', () => {
    expect(String(new LatLng(37.7749, -122.4194))).toBe('37.7749,-122.4194');
  });

  test('Number() returns NaN — no meaningful numeric coercion', () => {
    expect(Number(new LatLng(37.7749, -122.4194))).toBeNaN();
    expect(new LatLng(37.7749, -122.4194).valueOf()).toBeNaN();
  });
});

describe('LatLng — method dispatch', () => {
  test('latitude() and longitude() return field values', () => {
    const ll = new LatLng(37.7749, -122.4194);
    expect(ll.callMethod('latitude', [])).toBe(37.7749);
    expect(ll.callMethod('longitude', [])).toBe(-122.4194);
  });

  test('distance() to same point is 0', () => {
    const ll = new LatLng(37.7749, -122.4194);
    expect(ll.callMethod('distance', [ll])).toBe(0);
  });

  test('distance() between SF and LA is ~559km (haversine)', () => {
    // SF: 37.7749, -122.4194  |  LA: 34.0522, -118.2437
    const sf = new LatLng(37.7749, -122.4194);
    const la = new LatLng(34.0522, -118.2437);
    const meters = sf.callMethod('distance', [la]) as number;
    // Haversine on these coords: ~559,121 m. Allow ±1km tolerance.
    expect(meters).toBeGreaterThan(558_000);
    expect(meters).toBeLessThan(560_000);
  });

  test('distance() with non-LatLng arg throws TypeError, not NO_OP', () => {
    expect(() => new LatLng(0, 0).callMethod('distance', ['not-a-latlng'])).toThrow(TypeError);
  });

  test('unknown method returns NO_OP — caller throws UnsupportedError', () => {
    const ll = new LatLng(0, 0);
    expect(ll.callMethod('elevation', [])).toBe(Symbol.for('pyric.RulesValue.NO_OP'));
  });
});

// ─── Integration tests through the evaluator ───────────────────────────────

const sim = new SimulateFirestoreRulesHandler();

function rules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /points/{pid} {
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
    path: 'points/p1',
    auth: { uid: 'u1' },
    data: {},
  };
}

describe('LatLng — through evaluator', () => {
  test('latlng.value().latitude() returns the lat', () => {
    const r = sim.simulate(
      rules('latlng.value(37.7, -122.4).latitude() == 37.7'),
      [tc('latitude returns lat', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('latlng.value() == latlng.value() with same coords', () => {
    const r = sim.simulate(
      rules('latlng.value(37.7, -122.4) == latlng.value(37.7, -122.4)'),
      [tc('equality across two namespace calls', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('latlng.value() != latlng.value() with different coords', () => {
    const r = sim.simulate(
      rules('latlng.value(37.7, -122.4) != latlng.value(40.0, -122.4)'),
      [tc('inequality on different lat', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('distance() near zero for identical points', () => {
    const r = sim.simulate(
      rules(
        'latlng.value(37.7, -122.4).distance(latlng.value(37.7, -122.4)) == 0',
      ),
      [tc('zero distance', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('latlng.value() is latlng → true', () => {
    const r = sim.simulate(
      rules('latlng.value(0, 0) is latlng'),
      [tc('is latlng', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('latlng.value() is not map / number / string', () => {
    const r = sim.simulate(
      rules('!(latlng.value(0, 0) is map) && !(latlng.value(0, 0) is number)'),
      [tc('latlng excluded from map/number', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('latlng membership in a list uses value-equality', () => {
    const r = sim.simulate(
      rules(
        'latlng.value(1, 2) in [latlng.value(0, 0), latlng.value(1, 2), latlng.value(3, 4)]',
      ),
      [tc('latlng in list', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('arithmetic on latlng denies with EvalError (Risk 2)', () => {
    // REBUILD_PLAN Item 1.2 Risk 2: NaN-from-RulesValue must NOT silently
    // propagate. evaluateBinaryOp throws EvalError before falling into the
    // numeric switch — handler.ts catches and surfaces DENY-with-error.
    // This is a real type error in the rule, not a sim gap.
    const r = sim.simulate(
      rules('latlng.value(0, 0) + 1 > 0'),
      [tc('arithmetic on latlng denies', 'DENY')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('unknown method on latlng → UNSUPPORTED state (not silent DENY)', () => {
    // Item 0.A: gaps in wrapper coverage surface as UNSUPPORTED so the
    // benchmark divergence accountant can distinguish "sim hasn't
    // implemented this" from "rule is wrong."
    const r = sim.simulate(
      rules('latlng.value(0, 0).elevation() == 0'),
      [tc('unknown latlng method', 'ALLOW')],
    );
    expect(r.success && r.data.unsupported).toBe(1);
  });
});
