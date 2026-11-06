/**
 * The service's root `match` block is a match block like any other: its own
 * `allow` statements apply when its path matches the request's full resource
 * name (FS3-ROOT-1, #1894).
 *
 * Production captures from the 2026-11-03 Firestore rules hunt:
 * - `c4a-root-recursive-with-own-allow`: under `match /{path=**} { allow
 *   read: if true; }`, get `c/1` and list `c` ALLOW.
 * - `c5e-root-recursive-own-allow-write`: `allow write: if request.auth !=
 *   null` on the root ALLOWS a signed-in create of `c/1` and DENIES a
 *   signed-out one.
 * - `c4b-root-documents-own-allow`: `allow read: if true` on the root
 *   `/databases/{database}/documents` DENIES get `c/1`, because that root
 *   does not match the document's full name, only its children do.
 *
 * Capture `c4c-root-recursive-path-value` (production ALLOWS get `c/1` under
 * `allow get: if path == path('databases/(default)/documents/c/1')` on the
 * root) is not replayed here: the root block now applies, but pyric binds a
 * recursive wildcard as a string, not a path, so the comparison is false.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler, type TestCase } from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { collection, doc, getDoc, getDocs, getFirestore, setDoc } from 'pyric/firestore';

function rootRules(root: string, body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match ${root} {
    ${body}
  }
}`;
}

const RECURSIVE_READ = rootRules('/{path=**}', 'allow read: if true;');
const RECURSIVE_WRITE = rootRules('/{path=**}', 'allow write: if request.auth != null;');
const DOCUMENTS_READ = rootRules('/databases/{database}/documents', 'allow read: if true;');

type Method = TestCase['method'];

function decide(rules: string, method: Method, path: string, auth: TestCase['auth'] = null) {
  const testCase = {
    description: `${method} ${path}`,
    expectation: 'ALLOW',
    method,
    path,
    auth,
    ...(method === 'create' ? { data: { a: 1 } } : {}),
  } as TestCase;
  const result = new SimulateFirestoreRulesHandler().simulate(rules, [testCase]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!;
}

function sandboxDb(rules: string, auth?: { uid: string }) {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, { 'c/1': { a: 1 } });
  setRules(sandbox, rules);
  return getFirestore(auth ? sandbox.withAuth(auth) : sandbox);
}

const DENIED = { code: 'permission-denied' };

describe('a root /{path=**} block grants through its own allow statements in simulate()', () => {
  test('c4a: get c/1 is allowed', () => {
    expect(decide(RECURSIVE_READ, 'get', 'c/1').decision).toBe('ALLOW');
  });

  test('c4a: list c is allowed', () => {
    expect(decide(RECURSIVE_READ, 'list', 'c').decision).toBe('ALLOW');
  });

  test('c5e: a signed-in create of c/1 is allowed and a signed-out one denied', () => {
    expect(decide(RECURSIVE_WRITE, 'create', 'c/1', { uid: 'u' }).decision).toBe('ALLOW');
    expect(decide(RECURSIVE_WRITE, 'create', 'c/1').decision).toBe('DENY');
  });

  test('the grant names the root block', () => {
    expect(decide(RECURSIVE_READ, 'get', 'c/1').notes).toContain("Allowed by match block '/{path=**}'");
  });

  test('c4b: a root that stops at documents grants no document through its own allow', () => {
    expect(decide(DOCUMENTS_READ, 'get', 'c/1').decision).toBe('DENY');
  });
});

describe('a root /{path=**} block grants through its own allow statements in the in-page sandbox', () => {
  test('c4a: getDoc c/1 reads the document', async () => {
    expect((await getDoc(doc(sandboxDb(RECURSIVE_READ), 'c/1'))).data()).toEqual({ a: 1 });
  });

  test('c4a: getDocs on collection c lists the document', async () => {
    expect((await getDocs(collection(sandboxDb(RECURSIVE_READ), 'c'))).size).toBe(1);
  });

  test('c5e: a signed-in setDoc of c/2 is allowed and a signed-out one denied', async () => {
    await setDoc(doc(sandboxDb(RECURSIVE_WRITE, { uid: 'u' }), 'c/2'), { a: 1 });
    await expect(setDoc(doc(sandboxDb(RECURSIVE_WRITE), 'c/2'), { a: 1 })).rejects.toMatchObject(DENIED);
  });

  test('c4b: getDoc c/1 is denied under a root that stops at documents', async () => {
    await expect(getDoc(doc(sandboxDb(DOCUMENTS_READ), 'c/1'))).rejects.toMatchObject(DENIED);
  });
});
