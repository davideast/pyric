/**
 * `x in y` where `y` is not a collection, or where `y` is a map and `x` is
 * not a string, is an evaluation error in production, never false. So the
 * negation of each such membership test denies.
 *
 * Production verdicts and error text: corpus scenario `prototype-chain-keys`
 * (Firestore Rules Test API).
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import { evaluate, type SimulationContext } from '../../../src/rules/simulator/evaluator.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { EvalError } from '../../../src/rules/simulator/eval-error.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const handler = new SimulateFirestoreRulesHandler();
const data = { n: null, s: 'abc', i: 5, b: true, m: { a: 1 }, l: ['a'] };

function decide(condition: string): string {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow create: if ${condition};
    }
  }
}`;
  const tc = {
    description: condition,
    expectation: 'ALLOW',
    method: 'create',
    path: 'c/1',
    auth: { uid: 'u' },
    data,
  } as TestCase;
  const res = handler.simulate(source, [tc]);
  if (!res.success) throw new Error(`simulate failed: ${res.error.message}`);
  return res.data.results[0]!.decision;
}

function thrownBy(expression: string): string {
  const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} { allow read: if ${expression}; }
  }
}`);
  if (!ast) throw new Error('parse failed');
  const condition = ast.service.match.children[0]!.allows[0]!.condition;
  try {
    evaluate(condition, {} as SimulationContext);
  } catch (error) {
    if (error instanceof EvalError) return error.message;
    throw error;
  }
  return 'no error';
}

describe('in over a value that is not a collection', () => {
  test.each([
    ["!('a' in request.resource.data.n)", 'DENY'],
    ["!('a' in request.resource.data.s)", 'DENY'],
    ["!('a' in request.resource.data.i)", 'DENY'],
    ["!('a' in request.resource.data.b)", 'DENY'],
    ['!(1 in request.resource.data.m)', 'DENY'],
    ["'a' in request.resource.data.n", 'DENY'],
    ["'a' in request.resource.data.m", 'ALLOW'],
    ["!('z' in request.resource.data.m)", 'ALLOW'],
    ["'a' in request.resource.data.l", 'ALLOW'],
    ["!(1 in request.resource.data.l)", 'ALLOW'],
    ["('a' in request.resource.data.s) || true", 'ALLOW'],
  ])('%s → %s', (condition, expected) => {
    expect(decide(condition)).toBe(expected);
  });

  test.each([
    ["'a' in null", 'Null value error.'],
    ["'a' in 'abc'", 'Function not found error: Name: [in].'],
    ["'a' in 5", 'Function not found error: Name: [in].'],
    ["'a' in 1.5", 'Function not found error: Name: [in].'],
    ["'a' in true", 'Function not found error: Name: [in].'],
    ["1 in {'a': 1}", 'Unsupported operation error. Received: map.in(int). Expected: map.in(string).'],
  ])('%s raises production error text', (expression, message) => {
    expect(thrownBy(expression)).toBe(message);
  });
});
