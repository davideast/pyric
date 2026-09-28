/**
 * Index access `value[index]` on a Map or a List, shared by the Firestore
 * simulator and the Storage evaluator. A key the map does not own is an
 * error, not null; a key present with a null value reads null. A list index
 * must be an int within `[0, size)`, and a string key on a list is an
 * unsupported operation.
 *
 * Production verdicts and error text: corpus scenarios
 * `undefined-field-access` (Firestore), `metadata-access` and
 * `list-map-literals-and-slice` (Storage).
 */
import { describe, expect, test } from 'bun:test';
import {
  IndexAccessFailure,
  indexList,
  indexMap,
} from '../../src/rules/simulator/index-access.js';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import type { TestCase } from '../../src/rules/test/spec.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';

const SHAPES: ReadonlyArray<readonly [string, boolean]> = [
  ["{'a': 1}['a'] == 1", true],
  ["{'a': 1}['b'] == null", false],
  ["{'a': 1}['b'] != true", false],
  ["!({'a': 1}['b'] == true)", false],
  ["{'a': 1}['b'] == true || true", true],
  ["!({'a': 1}['b'] == true && false)", true],
  ["{'a': 1}['b'] is string", false],
  ["!({'a': 1}['b'] is string)", false],
  ["{'a': 1}['b'] in ['x']", false],
  ["{'a': 1}['constructor'] == null", false],
  ["{'a': null}['a'] == null", true],
  ["{'m': {'a': 1}}['m']['b'] == null", false],
  ["{'a': 1}['' + 'b'] == null", false],
  ["['a', 'b'][1] == 'b'", true],
  ["['a', 'b'][2] == null", false],
  ["['a', 'b'][-1] == 'b'", false],
  ["['a', 'b']['length'] == 2", false],
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

describe('index access', () => {
  test.each(SHAPES)('Firestore: %s → %p', (condition, allowed) => {
    expect(firestoreAllows(condition)).toBe(allowed);
  });

  test.each(SHAPES)('Storage: %s → %p', (condition, allowed) => {
    expect(storageAllows(condition)).toBe(allowed);
  });

  test("a map read reports production's text for a key the map does not own", () => {
    expect(indexMap({ a: 1, n: null }, 'a')).toBe(1);
    expect(indexMap({ a: 1, n: null }, 'n')).toBe(null);
    expect(indexMap({ a: 1 }, 'b')).toEqual(new IndexAccessFailure('Property b is undefined on object.'));
    expect(indexMap({ a: 1 }, 'toString')).toEqual(new IndexAccessFailure('Property toString is undefined on object.'));
  });

  test("a list read reports production's text for an index out of bounds or of another type", () => {
    expect(indexList([1, 2], 0)).toBe(1);
    expect(indexList([1, 2], 2)).toEqual(new IndexAccessFailure('Index out of bound error. Index: [2] , size: [2].'));
    expect(indexList([1, 2], -1)).toEqual(new IndexAccessFailure('Index out of bound error. Index: [-1] , size: [2].'));
    expect(indexList([1, 2], 'length')).toEqual(
      new IndexAccessFailure('Unsupported operation error. Received: list[string]. Expected: list[int].'),
    );
  });
});
