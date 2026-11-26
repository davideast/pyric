/**
 * Unknown methods on RulesValue wrappers (RulesFloat, Timestamp, Duration,
 * Bytes, LatLng, Path, Reference, Vector) throw an absorbable EvalError with
 * production's `Function not found error: Name: [<method>].` text, matching
 * Storage rules (`rules-method-calls.ts`) and enabling CEL short-circuit
 * `&&`/`||` and lazy `let`/parameter error absorption.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../src/simulator/handler.js';
import { functionNotFoundMessage } from '../../src/simulator/eval-error.js';
import { Bytes } from '../../src/simulator/wrappers/bytes.js';
import { Duration } from '../../src/simulator/wrappers/duration.js';
import { RulesFloat } from '../../src/simulator/wrappers/float.js';
import { LatLng } from '../../src/simulator/wrappers/latlng.js';
import { Path } from '../../src/simulator/wrappers/path.js';
import { Reference } from '../../src/simulator/wrappers/reference.js';
import { Timestamp } from '../../src/simulator/wrappers/timestamp.js';
import { Vector } from '../../src/simulator/wrappers/vector.js';
import type { TestCase, TestResult } from '../../src/test/spec.js';

const sim = new SimulateFirestoreRulesHandler();

const WRAPPER_RESOURCE: Record<string, unknown> = {
  flt: new RulesFloat(1.5),
  ts: Timestamp.fromMillis(1_700_000_000_000),
  dur: new Duration(3600, 0),
  bin: Bytes.fromUtf8('abc'),
  geo: new LatLng(37.7749, -122.4194),
  pth: new Path(['databases', '(default)', 'documents', 'items', 'i1']),
  ref: new Reference('items/i1'),
  vec: new Vector([0.1, 0.2, 0.3]),
};

function rules(body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${body}
  }
}`;
}

function runOne(ruleset: string, expectation: TestCase['expectation'] = 'DENY'): TestResult {
  const result = sim.simulate(ruleset, [
    {
      description: 'case',
      expectation,
      method: 'get',
      path: 'docs/d1',
      resource: WRAPPER_RESOURCE,
    },
  ]);
  if (!result.success) {
    throw new Error(`Simulation failed: ${result.error.message}`);
  }
  const first = result.data.results[0];
  if (!first) {
    throw new Error('Missing simulation result');
  }
  return first;
}

describe('RulesValue unknown method calls raise absorbable EvalError', () => {
  const wrapperCases: ReadonlyArray<{ label: string; expr: string; method: string }> = [
    { label: 'RulesFloat literal.matches', expr: "float(1.5).matches('.*')", method: 'matches' },
    { label: 'RulesFloat resource.lower', expr: 'resource.data.flt.lower()', method: 'lower' },
    { label: 'Timestamp.matches', expr: "resource.data.ts.matches('.*')", method: 'matches' },
    { label: 'Timestamp.lower', expr: 'timestamp.value(0).lower()', method: 'lower' },
    { label: 'Duration.matches', expr: "resource.data.dur.matches('.*')", method: 'matches' },
    { label: 'Duration.lower', expr: "duration.value(1, 'h').lower()", method: 'lower' },
    { label: 'Bytes.matches', expr: "resource.data.bin.matches('.*')", method: 'matches' },
    { label: 'Bytes.lower', expr: "b'abc'.lower()", method: 'lower' },
    { label: 'LatLng.matches', expr: "resource.data.geo.matches('.*')", method: 'matches' },
    { label: 'LatLng.lower', expr: 'latlng.value(0, 0).lower()', method: 'lower' },
    { label: 'Path.matches', expr: "resource.data.pth.matches('.*')", method: 'matches' },
    { label: 'Path.lower', expr: "path('/databases/(default)/documents/a/1').lower()", method: 'lower' },
    { label: 'Reference.matches', expr: "resource.data.ref.matches('.*')", method: 'matches' },
    { label: 'Reference.lower', expr: 'resource.data.ref.lower()', method: 'lower' },
    { label: 'Vector.matches', expr: "resource.data.vec.matches('.*')", method: 'matches' },
    { label: 'Vector.lower', expr: 'resource.data.vec.lower()', method: 'lower' },
  ];

  test('standalone unknown method denies with ERROR verdict (never UNSUPPORTED)', () => {
    for (const item of wrapperCases) {
      const res = runOne(rules(`match /docs/{id} { allow get: if ${item.expr} == 'x'; }`), 'DENY');
      expect(res.decision, item.label).toBe('DENY');
      expect(res.state, item.label).toBe('PASSED');
      expect(res.trace[0]?.verdict, item.label).toBe('ERROR');
      expect(res.trace[0]?.message, item.label).toBe(functionNotFoundMessage(item.method));
    }
  });

  test('short-circuit || true absorbs unknown method EvalError cleanly to ALLOW', () => {
    for (const item of wrapperCases) {
      const leftErr = runOne(rules(`match /docs/{id} { allow get: if (${item.expr} == 'x') || true; }`), 'ALLOW');
      expect(leftErr.decision, `${item.label} || true`).toBe('ALLOW');
      expect(leftErr.trace[0]?.verdict, `${item.label} || true`).toBe('ALLOW');

      const rightErr = runOne(rules(`match /docs/{id} { allow get: if true || (${item.expr} == 'x'); }`), 'ALLOW');
      expect(rightErr.decision, `true || ${item.label}`).toBe('ALLOW');
    }
  });

  test('short-circuit && false and false || err deny cleanly without UNSUPPORTED', () => {
    for (const item of wrapperCases) {
      const andFalse = runOne(rules(`match /docs/{id} { allow get: if (${item.expr} == 'x') && false; }`), 'DENY');
      expect(andFalse.decision, `${item.label} && false`).toBe('DENY');
      expect(andFalse.trace[0]?.verdict, `${item.label} && false`).toBe('DENY');

      const falseOr = runOne(rules(`match /docs/{id} { allow get: if false || (${item.expr} == 'x'); }`), 'DENY');
      expect(falseOr.decision, `false || ${item.label}`).toBe('DENY');
      expect(falseOr.trace[0]?.verdict, `false || ${item.label}`).toBe('ERROR');
    }
  });

  test('lazy parameter and let bindings absorb unread unknown-method EvalError', () => {
    for (const item of wrapperCases) {
      const argRules = rules(`
        function ignoreArg(x) { return true; }
        match /docs/{id} { allow get: if ignoreArg(${item.expr}); }
      `);
      expect(runOne(argRules, 'ALLOW').decision, `arg ${item.label}`).toBe('ALLOW');

      const letRules = rules(`
        function unusedLet() {
          let bad = ${item.expr};
          return true;
        }
        match /docs/{id} { allow get: if unusedLet(); }
      `);
      expect(runOne(letRules, 'ALLOW').decision, `let ${item.label}`).toBe('ALLOW');

      const readLetRules = rules(`
        function readLet() {
          let bad = ${item.expr};
          return bad == 'x';
        }
        match /docs/{id} { allow get: if readLet(); }
      `);
      const readRes = runOne(readLetRules, 'DENY');
      expect(readRes.decision, `readLet ${item.label}`).toBe('DENY');
      expect(readRes.trace[0]?.verdict, `readLet ${item.label}`).toBe('ERROR');
    }
  });

  test('valid RulesValue methods continue to succeed and unknown namespaces stay UNSUPPORTED', () => {
    const valid = runOne(
      rules(`match /docs/{id} {
        allow get: if resource.data.ts.year() == 2023
          && resource.data.dur.seconds() == 3600
          && resource.data.bin.size() == 3
          && resource.data.geo.latitude() > 37.0
          && resource.data.pth == resource.data.ref;
      }`),
      'ALLOW',
    );
    expect(valid.decision).toBe('ALLOW');

    const unknownNs = runOne(
      rules('match /docs/{id} { allow get: if unknownNamespace.helper(); }'),
      'ALLOW',
    );
    expect(unknownNs.decision).toBe('UNSUPPORTED');
    expect(unknownNs.state).toBe('UNSUPPORTED');
  });
});
