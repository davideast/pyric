/**
 * The service's root `match` path is compared with the request (FS2-ENF-1).
 *
 * Production matches the root against the request's full resource name,
 * `/databases/(default)/documents/<path>`, so a root that names another
 * database, another subtree, a misspelled `documents` or a Storage path grants
 * nothing, whatever its inner blocks say. Capture
 * `rules-firestore-service-root-match-path` (row firestore-rules#201) records
 * production denying `get` and `create` of `c/1` under the root
 * `/databases/{database}/documents/z` and allowing `z/1`.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler, type TestCase } from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
} from 'pyric/firestore';

function rulesUnder(root: string, inner = 'match /{document=**} { allow read, write: if true; }'): string {
  return `rules_version = '2';
service cloud.firestore {
  match ${root} {
    ${inner}
  }
}`;
}

const WRONG_ROOTS = [
  '/databases/other/documents',
  '/databases/{db}/documents/z',
  '/databases/{db}/documentz',
  '/b/{bucket}/o',
];

type Method = TestCase['method'];

function decide(rules: string, method: Method, path: string) {
  const testCase = {
    description: `${method} ${path}`,
    expectation: 'ALLOW',
    method,
    path,
    auth: { uid: 'u1' },
    ...(method === 'create' ? { data: { a: 1 } } : { resource: { a: 1 } }),
  } as TestCase;
  const result = new SimulateFirestoreRulesHandler().simulate(rules, [testCase]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!;
}

function sandboxDb(rules: string) {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, { 'c/1': { a: 1 }, 'z/1': { a: 1 }, 'z/1/c/2': { a: 1 } });
  setRules(sandbox, rules);
  return getFirestore(sandbox.withAuth({ uid: 'u1' }));
}

const DENIED = { code: 'permission-denied' };

describe('a root match that does not apply grants nothing through simulate()', () => {
  for (const root of WRONG_ROOTS) {
    describe(root, () => {
      const rules = rulesUnder(root);
      for (const method of ['get', 'create', 'list'] as const) {
        test(`${method} ${method === 'list' ? 'c' : 'c/1'} is denied`, () => {
          const result = decide(rules, method, method === 'list' ? 'c' : 'c/1');
          expect(result.decision).toBe('DENY');
        });
      }
    });
  }

  test('the denial names the root and the request path', () => {
    const result = decide(rulesUnder('/databases/other/documents'), 'get', 'c/1');
    expect(result.notes).toContain(
      "The root match '/databases/other/documents' does not match '/databases/(default)/documents/c/1', so no match block applies and the request is denied.",
    );
  });
});

describe('a root match that does not apply grants nothing in the in-page sandbox', () => {
  for (const root of WRONG_ROOTS) {
    describe(root, () => {
      const rules = rulesUnder(root);
      test('getDoc c/1 is denied', async () => {
        await expect(getDoc(doc(sandboxDb(rules), 'c/1'))).rejects.toMatchObject(DENIED);
      });
      test('setDoc c/1 is denied', async () => {
        await expect(setDoc(doc(sandboxDb(rules), 'c/1'), { a: 2 })).rejects.toMatchObject(DENIED);
      });
      test('getDocs on collection c is denied', async () => {
        await expect(getDocs(collection(sandboxDb(rules), 'c'))).rejects.toMatchObject(DENIED);
      });
      test('getDocs on collectionGroup c is denied', async () => {
        await expect(getDocs(collectionGroup(sandboxDb(rules), 'c'))).rejects.toMatchObject(DENIED);
      });
    });
  }
});

describe('controls that keep granting', () => {
  for (const name of ['database', 'db', 'dbId']) {
    test(`the standard root with {${name}} grants c/1 and binds (default)`, async () => {
      const rules = rulesUnder(
        `/databases/{${name}}/documents`,
        `match /c/{id} { allow read, write: if ${name} == '(default)'; }`,
      );
      expect(decide(rules, 'get', 'c/1').decision).toBe('ALLOW');
      expect(decide(rules, 'create', 'c/1').decision).toBe('ALLOW');
      expect(decide(rules, 'list', 'c').decision).toBe('ALLOW');
      const db = sandboxDb(rules);
      expect((await getDoc(doc(db, 'c/1'))).data()).toEqual({ a: 1 });
      await setDoc(doc(db, 'c/1'), { a: 2 });
      expect((await getDocs(collection(db, 'c'))).size).toBe(1);
    });
  }

  test('the standard root grants a collection-group query', async () => {
    const rules = rulesUnder('/databases/{database}/documents');
    expect((await getDocs(collectionGroup(sandboxDb(rules), 'c'))).size).toBe(2);
  });

  test('a root ending in a collection grants the documents under it', async () => {
    const rules = rulesUnder('/databases/{db}/documents/z');
    expect(decide(rules, 'get', 'z/1').decision).toBe('ALLOW');
    expect(decide(rules, 'create', 'z/1').decision).toBe('ALLOW');
    expect(decide(rules, 'list', 'z').decision).toBe('ALLOW');
    expect((await getDoc(doc(sandboxDb(rules), 'z/1'))).data()).toEqual({ a: 1 });
  });

  test('a root ending in a collection binds only what follows it', () => {
    const rules = rulesUnder('/databases/{db}/documents/z', "match /{id} { allow read: if id == '1'; }");
    expect(decide(rules, 'get', 'z/1').decision).toBe('ALLOW');
    expect(decide(rules, 'get', 'z/2').decision).toBe('DENY');
  });

  test('a root ending in a recursive wildcard grants its children at any depth', () => {
    const rules = rulesUnder('/databases/{db}/documents/{rest=**}', "match /c/{id} { allow read: if id == '1'; }");
    expect(decide(rules, 'get', 'c/1').decision).toBe('ALLOW');
    expect(decide(rules, 'get', 'z/1/c/1').decision).toBe('ALLOW');
    expect(decide(rules, 'get', 'c/2').decision).toBe('DENY');
  });

  test('a root binding is visible to an exists() path in a nested rule', async () => {
    const rules = rulesUnder(
      '/databases/{dbId}/documents',
      'match /c/{id} { allow read: if exists(/databases/$(dbId)/documents/z/$(id)); }',
    );
    expect((await getDoc(doc(sandboxDb(rules), 'c/1'))).data()).toEqual({ a: 1 });
  });
});
