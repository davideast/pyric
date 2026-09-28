/**
 * The `in` operator, shared by the Firestore simulator and the Storage
 * evaluator. `x in list` and `x in set` test elements, and `x in map` tests the
 * map's own keys. A right operand that is not a list, set or map, and a map
 * key that is not a string, is an evaluation error, never false, so the
 * negation of each such test denies.
 *
 * Production verdicts and error text: corpus scenarios `prototype-chain-keys`
 * (Firestore) and `in-membership-and-proto-keys` (Storage), which report the
 * same verdict and text for every shape.
 */
import { describe, expect, test } from 'bun:test';
import { MembershipFailure, membership } from '../../src/rules/simulator/membership.js';
import { rulesValuesEqual } from '../../src/rules/simulator/value-equality.js';
import { FirestoreSet } from '../../src/rules/simulator/firestore-set.js';
import { RulesFloat } from '../../src/rules/simulator/wrappers/float.js';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import type { TestCase } from '../../src/rules/test/spec.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';

const NULL_VALUE = 'Null value error.';
const NOT_FOUND = 'Function not found error: Name: [in].';
const INT_KEY = 'Unsupported operation error. Received: map.in(int). Expected: map.in(string).';

/** Condition, whether production allows it, and the error text when it denies on an error. */
const SHAPES: ReadonlyArray<readonly [string, boolean, string | null]> = [
  ["!('a' in null)", false, NULL_VALUE],
  ["!('a' in 'abc')", false, NOT_FOUND],
  ["!('a' in 5)", false, NOT_FOUND],
  ["!('a' in 1.5)", false, NOT_FOUND],
  ["!('a' in true)", false, NOT_FOUND],
  ["!(1 in {'a': 1})", false, INT_KEY],
  ["!('a' in request.time)", false, NOT_FOUND],
  ["!('a' in request.path)", false, NOT_FOUND],
  ["!('a' in {'a': 1}.diff({}))", false, NOT_FOUND],
  ["'a' in null", false, NULL_VALUE],
  ["('a' in 'abc') || true", true, null],
  ["'a' in ['a', 'b'].toSet()", true, null],
  ["!('items' in ['a', 'b'].toSet())", true, null],
  ["'a' in {'a': 1}", true, null],
  ["!('toString' in {'a': 1})", true, null],
  ["'a' in ['a']", true, null],
  ["!(1 in ['a'])", true, null],
];

const firestore = new SimulateFirestoreRulesHandler();

function firestoreAllows(condition: string): boolean {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} { allow create: if ${condition}; }
  }
}`;
  const tc = {
    description: condition, expectation: 'ALLOW', method: 'create', path: 'c/1', auth: { uid: 'u' }, data: {},
  } as TestCase;
  const res = firestore.simulate(source, [tc]);
  if (!res.success) throw new Error(res.error.message);
  return res.data.results[0]!.decision === 'ALLOW';
}

function storageDecision(condition: string): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} { allow read: if ${condition}; }
  }
}`);
  const result = evaluateStorageRules(rules, {
    request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/f' },
    resource: null,
  });
  return { allowed: result.allowed, reasons: result.reasons };
}

describe('in membership', () => {
  test.each(SHAPES)('Firestore: %s → %p', (condition, allowed) => {
    expect(firestoreAllows(condition)).toBe(allowed);
  });

  test.each(SHAPES)('Storage: %s → %p', (condition, allowed, message) => {
    const decision = storageDecision(condition);
    expect(decision.allowed).toBe(allowed);
    if (message) expect(decision.reasons.join('\n')).toContain(message);
  });

  test.each([
    ['a', null, NULL_VALUE],
    ['a', undefined, NULL_VALUE],
    ['a', 'abc', NOT_FOUND],
    ['a', 5, NOT_FOUND],
    ['a', new RulesFloat(1.5), NOT_FOUND],
    ['a', true, NOT_FOUND],
    [1, { a: 1 }, INT_KEY],
    [new RulesFloat(1), { a: 1 }, 'Unsupported operation error. Received: map.in(float). Expected: map.in(string).'],
  ] as const)('%p in %p is an error', (element, collection, message) => {
    const result = membership(element, collection, rulesValuesEqual);
    expect(result).toBeInstanceOf(MembershipFailure);
    expect((result as MembershipFailure).message).toBe(message);
  });

  test('tests list and set elements and own map keys', () => {
    expect(membership('a', ['a'], rulesValuesEqual)).toBe(true);
    expect(membership('b', ['a'], rulesValuesEqual)).toBe(false);
    expect(membership('a', new FirestoreSet(['a']), rulesValuesEqual)).toBe(true);
    expect(membership('items', new FirestoreSet(['a']), rulesValuesEqual)).toBe(false);
    expect(membership('a', { a: 1 }, rulesValuesEqual)).toBe(true);
    expect(membership('toString', { a: 1 }, rulesValuesEqual)).toBe(false);
  });
});
