/**
 * The `math` namespace in the Firestore simulator and the Storage evaluator.
 *
 * Both evaluators call one module (src/rules/simulator/math-builtins.ts).
 * The cases come from packages/conformance/src/rules-math-cases.ts, which the
 * Firestore scenario `time-math-and-casts` and the Storage scenario
 * `math-namespace` send to the Rules Test API; production evaluated every
 * condition the same way in both services.
 */
import { describe, expect, test } from 'bun:test';
import { MATH_CASES } from '../../../../conformance/src/rules-math-cases.ts';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';

const handler = new SimulateFirestoreRulesHandler();

function firestore(condition: string) {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{id} { allow get: if ${condition}; }
  }
}`;
  const result = handler.simulate(source, [{
    description: 'math', expectation: 'ALLOW', method: 'get', path: 't/x', auth: { uid: 'u' }, resource: { a: 1 },
  }]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!;
}

function storage(condition: string) {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /t/{file} { allow read: if ${condition}; }
  }
}`);
  return evaluateStorageRules(rules, {
    request: { auth: { uid: 'u' }, method: 'read', path: '/b/pyric-default/o/t/x' },
    resource: { size: 1 },
  });
}

describe('math namespace, cases production evaluated', () => {
  for (const { key, condition, expectation } of MATH_CASES) {
    test(`${key}: Firestore ${expectation}`, () => {
      expect(firestore(condition).decision).toBe(expectation);
    });
    test(`${key}: Storage ${expectation}`, () => {
      expect(storage(condition).allowed ? 'ALLOW' : 'DENY').toBe(expectation);
    });
  }
});

describe("math namespace errors carry production's messages", () => {
  const messages: [string, string][] = [
    ["math.abs('a') == 1", 'Unsupported operation error. Received: math.abs(string). Expected: math.abs(int), math.abs(float).'],
    ['math.abs(null) == 1', 'Unsupported operation error. Received: math.abs(null). Expected: math.abs(int), math.abs(float).'],
    ["math.pow(2, 'a') == 1", 'Unsupported operation error. Received: math.pow(int, string). Expected: math.pow(float, float).'],
    ["math.isNaN('a')", 'Unsupported operation error. Received: math.isNaN(string). Expected: math.isNaN(float).'],
    ['math.abs(1, 2) == 1', 'Incorrect number of arguments. Received: 2. Expected: math.abs(int), math.abs(float).'],
    ['math.sqrt() == 1', 'Incorrect number of arguments. Received: 0. Expected: math.sqrt(float).'],
    ['math.isInfinite(1.0)', 'Function not found error: Name: [math.isInfinite].'],
  ];
  for (const [condition, message] of messages) {
    test(condition, () => {
      expect(firestore(condition).trace[0]!.message).toBe(message);
      expect(storage(condition).reasons.join(' ')).toContain(message);
    });
  }
});

describe('math namespace cost', () => {
  test('a math call costs the same in both evaluators', () => {
    const condition = 'math.abs(-1) == 1 && math.pow(2, 3) == 8.0';
    expect(storage(condition).evaluatedExpressions).toBe(firestore(condition).evaluatedExpressions!);
  });
});
