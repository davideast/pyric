import { describe, expect, test } from 'bun:test';
import { firestoreRules, storageRules, type FirestoreCase } from '../../src/index.js';

function firestoreDecision(
  rulesBody: string,
  resourceData?: Record<string, unknown>,
): 'ALLOW' | 'DENY' | 'UNSUPPORTED' {
  const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${rulesBody}
  }
}`;
  const request: FirestoreCase = {
    description: 'nan equality case',
    expectation: 'DENY',
    method: 'get',
    path: 'items/d1',
  };
  if (resourceData !== undefined) {
    request.resource = resourceData;
  }
  return firestoreRules(source).explain(request).decision;
}

function storageDecision(rulesBody: string): 'ALLOW' | 'DENY' | 'UNSUPPORTED' {
  const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${rulesBody}
  }
}`;
  return storageRules(source, { bucket: 'demo-nan.appspot.com' }).explain({
    description: 'nan equality case',
    expectation: 'DENY',
    method: 'get',
    path: 'items/d1',
    resource: { size: 1 },
  }).decision;
}

describe('NaN equality and inequality across shared references', () => {
  test.each([
    [
      'shared scalar NaN == is false',
      `    function check() { let x = 0.0 / 0.0; return x == x; }
    match /items/{id} { allow get: if check(); }`,
      'DENY',
    ],
    [
      'shared scalar NaN != is true',
      `    function check() { let x = 0.0 / 0.0; return x != x; }
    match /items/{id} { allow get: if check(); }`,
      'ALLOW',
    ],
    [
      'shared list containing NaN == is false',
      `    function check() { let a = [0.0 / 0.0]; return a == a; }
    match /items/{id} { allow get: if check(); }`,
      'DENY',
    ],
    [
      'shared list containing NaN != is true',
      `    function check() { let a = [0.0 / 0.0]; return a != a; }
    match /items/{id} { allow get: if check(); }`,
      'ALLOW',
    ],
    [
      'shared map containing NaN == is false',
      `    function check() { let m = {'k': 0.0 / 0.0}; return m == m; }
    match /items/{id} { allow get: if check(); }`,
      'DENY',
    ],
    [
      'shared map containing NaN != is true',
      `    function check() { let m = {'k': 0.0 / 0.0}; return m != m; }
    match /items/{id} { allow get: if check(); }`,
      'ALLOW',
    ],
    [
      'shared nested structure containing NaN == is false',
      `    function check() { let m = {'a': [{'b': 0.0 / 0.0}]}; return m == m; }
    match /items/{id} { allow get: if check(); }`,
      'DENY',
    ],
    [
      'shared nested structure containing NaN != is true',
      `    function check() { let m = {'a': [{'b': 0.0 / 0.0}]}; return m != m; }
    match /items/{id} { allow get: if check(); }`,
      'ALLOW',
    ],
    [
      'distinct NaN expressions == is false (control)',
      `    match /items/{id} { allow get: if (0.0 / 0.0) == (0.0 / 0.0); }`,
      'DENY',
    ],
    [
      'shared finite float, list, and map == is true (control)',
      `    function check() {
      let x = 1.5;
      let a = [1, 2.0];
      let m = {'k': 3.5};
      return x == x && a == a && m == m;
    }
    match /items/{id} { allow get: if check(); }`,
      'ALLOW',
    ],
    [
      'set containing NaN equals itself per set semantics (control)',
      `    function check() { let s = [0.0 / 0.0].toSet(); return s == s; }
    match /items/{id} { allow get: if check(); }`,
      'ALLOW',
    ],
  ] as const)('Firestore and Storage: %s', (_label, body, expected) => {
    expect(firestoreDecision(body)).toBe(expected);
    expect(storageDecision(body)).toBe(expected);
  });

  test('stored document field holding NaN does not equal itself on repeated reads', () => {
    const eqBody = `    match /items/{id} { allow get: if resource.data.n == resource.data.n; }`;
    const neqBody = `    match /items/{id} { allow get: if resource.data.n != resource.data.n; }`;
    const listEqBody = `    match /items/{id} { allow get: if resource.data.arr == resource.data.arr; }`;
    const mapEqBody = `    match /items/{id} { allow get: if resource.data == resource.data; }`;
    const mapNeqBody = `    match /items/{id} { allow get: if resource.data != resource.data; }`;

    expect(firestoreDecision(eqBody, { n: Number.NaN })).toBe('DENY');
    expect(firestoreDecision(neqBody, { n: Number.NaN })).toBe('ALLOW');
    expect(firestoreDecision(listEqBody, { arr: [Number.NaN] })).toBe('DENY');
    expect(firestoreDecision(mapEqBody, { n: Number.NaN })).toBe('DENY');
    expect(firestoreDecision(mapNeqBody, { n: Number.NaN })).toBe('ALLOW');
  });
});
