/**
 * An allow condition must evaluate to a bool.
 *
 * The Firestore Rules Test API compiles `allow update: if 'ab';` and every
 * other non-boolean condition below, then denies the request with
 * "Type error. Received: [string] Expected: [bool]." (with the value's type
 * name). No non-boolean value grants access. Production verdicts: corpus
 * scenario `strict-boolean-control-flow`.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../src/rules/test/spec.js';

const handler = new SimulateFirestoreRulesHandler();

function run(condition: string) {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} {
      allow update: if ${condition};
      allow update: if false;
    }
  }
}`;
  const tc = {
    description: condition,
    expectation: 'ALLOW',
    method: 'update',
    path: 'c/1',
    auth: { uid: 'u' },
    resource: {},
    data: { str: 'ab', n: 1, list: [], map: { a: 1 } },
  } as TestCase;
  const res = handler.simulate(source, [tc]);
  if (!res.success) throw new Error('simulate failed');
  return res.data.results[0]!;
}

describe('allow condition typing', () => {
  test.each([
    ["'ab'", 'string'],
    ['1', 'int'],
    ['0', 'int'],
    ['1.0', 'float'],
    ['null', 'null'],
    ['[]', 'list'],
    ['request.resource.data', 'map'],
    ['request.resource.data.str', 'string'],
    ['request.resource.data.n', 'int'],
    ['request.resource.data.list', 'list'],
    ['request.resource.data.map', 'map'],
  ])('%s is a type error that denies', (condition, typeName) => {
    const result = run(condition);
    expect(result.decision).toBe('DENY');
    expect(result.trace[0]!.verdict).toBe('ERROR');
    expect(result.trace[0]!.message).toBe(`Type error. Received: [${typeName}] Expected: [bool].`);
    // The error is confined to its own allow rule; the next rule still runs.
    expect(result.trace[1]!.verdict).toBe('DENY');
  });

  test('true allows and false denies without an error', () => {
    expect(run('true').decision).toBe('ALLOW');
    const denied = run('false');
    expect(denied.decision).toBe('DENY');
    expect(denied.trace[0]!.verdict).toBe('DENY');
  });
});
