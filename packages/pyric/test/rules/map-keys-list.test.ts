/**
 * `Map.keys()` returns a List in Firestore and Storage rules, and `set` is a
 * type name `is` accepts. Production verdicts: corpus scenarios
 * `required-fields-and-mapdiff` (Firestore) and `upload-primitives-boundaries`
 * (Storage).
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import type { TestCase } from '../../src/rules/test/spec.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';

const SHAPES: ReadonlyArray<readonly [string, boolean]> = [
  ["{'a': 1, 'b': 2}.keys().toSet() == ['a', 'b'].toSet()", true],
  ["{'a': 1, 'b': 2}.keys().hasAll(['a', 'b'])", true],
  ["{'a': 1, 'b': 2}.keys().size() == 2", true],
  ["{'a': 1}.keys()[0] == 'a'", true],
  ["{'a': 1}.keys().join(',') == 'a'", true],
  ["{'a': 1, 'b': 2}.keys().hasAny(['a', 'z'])", true],
  ["{'a': 1, 'b': 2}.keys().hasOnly(['a', 'b', 'c'])", true],
  ["{'a': 1, 'b': 2}.keys() is list", true],
  ["{'a': 1, 'b': 2}.keys() is set", false],
  ["!({'a': 1, 'b': 2}.keys() is set)", true],
  ["{'a': 1, 'b': 2}.keys().toSet().size() == 2", true],
  ["{'a': 1}.keys().toSet() is set", true],
  ["!({'a': 1}.keys().toSet() is list)", true],
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

function storageAllows(condition: string): boolean {
  const rules = parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /x/{fileId} { allow read: if ${condition}; }
  }
}`);
  return evaluateStorageRules(rules, {
    request: { auth: { uid: 'a' }, method: 'get', path: '/b/b1/o/x/f' },
    resource: null,
  }).allowed;
}

describe('Map.keys() is a List', () => {
  test.each(SHAPES)('Firestore: %s → %p', (condition, allowed) => {
    expect(firestoreAllows(condition)).toBe(allowed);
  });

  test.each(SHAPES)('Storage: %s → %p', (condition, allowed) => {
    expect(storageAllows(condition)).toBe(allowed);
  });
});
