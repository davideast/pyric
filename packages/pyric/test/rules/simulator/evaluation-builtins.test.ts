import { describe, expect, test } from 'bun:test';
import { evaluateFunctionCall } from '../../../src/rules/simulator/evaluation-builtins.js';
import type { SimulationContext } from '../../../src/rules/simulator/evaluation-context.js';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';

describe('evaluation built-ins', () => {
  test('converts a strict numeric string with int()', () => {
    const literal = { type: 'literal' as const, value: '42', raw: "'42'" };
    expect(evaluateFunctionCall('int', [literal], {} as SimulationContext, {})).toBe(42);
  });
});

describe('07-firestore-math-namespace-type-and-nan-guards', () => {
  const handler = new SimulateFirestoreRulesHandler();

  test('math.* builtins reject non-numeric arguments and non-finite int conversions while preserving RulesFloat types', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create: if !math.isNaN(request.resource.data.lat) && math.abs(request.resource.data.delta) <= 10;
      allow update: if math.ceil(request.resource.data.score) <= 100;
      allow delete: if math.abs(-1.5) is float && math.abs(-2) is int && math.sqrt(2.0) is float;
    }
  }
}`;

    const sim = handler.simulate(rules, [
      {
        description: 'non-numeric string passed to math.isNaN must error and deny',
        expectation: 'DENY',
        method: 'create',
        path: 'items/1',
        auth: { uid: 'u1' },
        data: { lat: 'not-a-number', delta: 5 },
      },
      {
        description: 'null passed to math.abs must error and deny instead of coercing null to 0',
        expectation: 'DENY',
        method: 'create',
        path: 'items/2',
        auth: { uid: 'u1' },
        data: { lat: 37.7, delta: null },
      },
      {
        description: 'NaN (0.0 / 0.0) passed to integer-returning math.ceil must error and deny',
        expectation: 'DENY',
        method: 'update',
        path: 'items/3',
        auth: { uid: 'u1' },
        data: { score: 0.0 / 0.0 },
      },
      {
        description: 'float-typed math.abs(-1.5) and math.sqrt(2.0) preserve RulesFloat under is float',
        expectation: 'ALLOW',
        method: 'delete',
        path: 'items/4',
        auth: { uid: 'u1' },
      },
    ]);

    expect(sim.success).toBe(true);
    if (sim.success) {
      for (const res of sim.data.results) {
        expect(res.state).toBe('PASSED');
      }
    }
  });
});

