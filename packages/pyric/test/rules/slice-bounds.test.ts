/**
 * Range slice bounds, shared by the Firestore simulator and the Storage
 * evaluator. Production checks, in order, that `start` is an index, that
 * `end - 1` is an index, and that `start` does not exceed `end`. So `[0:0]`,
 * `[n:n]` and any slice of an empty value are errors, and `[i:i]` for
 * 0 < i < n is empty.
 *
 * Production verdicts and error text: corpus scenarios
 * `range-slice-list-and-string` (Firestore) and `list-map-literals-and-slice`
 * (Storage), which report the same verdict and text for every shape.
 */
import { describe, expect, test } from 'bun:test';
import { sliceBoundsError } from '../../src/rules/simulator/slice-bounds.js';
import { SimulateFirestoreRulesHandler } from '../../src/rules/simulator/handler.js';
import type { TestCase } from '../../src/rules/test/spec.js';
import { parseStorageRules } from '../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../src/storage/sandbox/rules-evaluator.js';

const SHAPES: ReadonlyArray<readonly [string, boolean]> = [
  ["['a', 'b', 'c', 'd'][0:0].size() == 0", false],
  ["['a', 'b', 'c', 'd'][4:4].size() == 0", false],
  ["['a', 'b', 'c', 'd'][3:3].size() == 0", true],
  ["['a', 'b', 'c', 'd'][3:4] == ['d']", true],
  ["['a', 'b', 'c', 'd'][1:0].size() == 0", false],
  ["['a', 'b', 'c', 'd'][3:1].size() == 0", false],
  ["['a', 'b', 'c', 'd'][0:5].size() == 5", false],
  ['[][0:0] == []', false],
  ["'hello'[0:0] == ''", false],
  ["'hello'[1:1] == ''", true],
  ["'hello'[4:4] == ''", true],
  ["'hello'[5:5] == ''", false],
  ["'hello'[2:1] == ''", false],
  ["'hello'[1:4] == 'ell'", true],
  ["''[0:0] == ''", false],
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

describe('slice bounds', () => {
  test.each(SHAPES)('Firestore: %s → %p', (condition, allowed) => {
    expect(firestoreAllows(condition)).toBe(allowed);
  });

  test.each(SHAPES)('Storage: %s → %p', (condition, allowed) => {
    expect(storageAllows(condition)).toBe(allowed);
  });

  test.each([
    [0, 0, 4, 'Index out of bound error. Index: [-1] , size: [4].'],
    [4, 4, 4, 'Index out of bound error. Index: [4] , size: [4].'],
    [1, 0, 4, 'Index out of bound error. Index: [-1] , size: [4].'],
    [3, 1, 4, 'Illegal range error. From index: [3] , To index: [1].'],
    [0, 0, 0, 'Index out of bound error. Index: [0] , size: [0].'],
    [0, 9, 3, 'Index out of bound error. Index: [8] , size: [3].'],
    [5, 5, 5, 'Index out of bound error. Index: [5] , size: [5].'],
    [2, 1, 5, 'Illegal range error. From index: [2] , To index: [1].'],
    [3, 3, 4, null],
    [3, 4, 4, null],
    [1, 4, 5, null],
  ] as const)('[%i:%i] of size %i', (start, end, size, message) => {
    expect(sliceBoundsError(start, end, size)).toBe(message);
  });
});
