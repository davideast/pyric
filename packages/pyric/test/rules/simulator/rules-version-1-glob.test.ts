/**
 * Under `rules_version = '1'`, the default when a source declares none, a
 * recursive wildcard matches one or more segments; under `2` and
 * `2+modules` it matches zero or more (FS2-SIM-12). Capture
 * `rules-firestore-rules-version-1-recursive-glob` (row firestore-rules#200)
 * records production denying `get` on `cities/SF` under a version 1
 * `match /cities/{city}/{document=**}` and allowing `cities/SF/landmarks/x`.
 */
import { describe, expect, test } from 'bun:test';
import { SimulateFirestoreRulesHandler, type TestCase } from 'pyric/rules/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { collectRootMatches, rootGovernsEveryDocument } from '../../../src/rules/simulator/root-match.js';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
} from 'pyric/firestore';

type VersionLine = { label: string; header: string };

const VERSION_1: VersionLine[] = [
  { label: 'no rules_version', header: '' },
  { label: "rules_version = '1'", header: "rules_version = '1';\n" },
];

const VERSION_2: VersionLine[] = [
  { label: "rules_version = '2'", header: "rules_version = '2';\n" },
];

function rules(header: string, inner: string, root = '/databases/{database}/documents'): string {
  return `${header}service cloud.firestore {
  match ${root} {
    ${inner}
  }
}`;
}

const CITY_GLOB = 'match /cities/{city}/{document=**} { allow read: if true; }';

function decide(source: string, method: TestCase['method'], path: string) {
  const testCase = {
    description: `${method} ${path}`,
    expectation: 'ALLOW',
    method,
    path,
    resource: { a: 1 },
  } as TestCase;
  const result = new SimulateFirestoreRulesHandler().simulate(source, [testCase]);
  if (!result.success) throw new Error(result.error.message);
  return result.data.results[0]!;
}

function sandboxDb(source: string) {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, {
    'cities/SF': { a: 1 },
    'cities/SF/landmarks/x': { a: 1 },
    'cities/SF/landmarks/x/notes/n': { a: 1 },
  });
  setRules(sandbox, source);
  return getFirestore(sandbox);
}

const DENIED = { code: 'permission-denied' };

describe('version 1: a recursive wildcard needs one or more segments', () => {
  for (const { label, header } of VERSION_1) {
    describe(label, () => {
      const source = rules(header, CITY_GLOB);

      test('get cities/SF is denied, as production denies it', () => {
        expect(decide(source, 'get', 'cities/SF').decision).toBe('DENY');
      });

      test('get cities/SF/landmarks/x and a deeper document are allowed', () => {
        expect(decide(source, 'get', 'cities/SF/landmarks/x').decision).toBe('ALLOW');
        expect(decide(source, 'get', 'cities/SF/landmarks/x/notes/n').decision).toBe('ALLOW');
      });

      test('list agrees with get: cities is denied and cities/SF/landmarks is allowed', () => {
        expect(decide(source, 'list', 'cities').decision).toBe('DENY');
        expect(decide(source, 'list', 'cities/SF/landmarks').decision).toBe('ALLOW');
      });

      test('the in-page sandbox agrees: getDoc and getDocs', async () => {
        const db = sandboxDb(source);
        await expect(getDoc(doc(db, 'cities/SF'))).rejects.toMatchObject(DENIED);
        expect((await getDoc(doc(db, 'cities/SF/landmarks/x'))).data()).toEqual({ a: 1 });
        expect((await getDocs(collection(db, 'cities/SF/landmarks'))).size).toBe(1);
      });

      // The sandbox lists through the document-style path
      // `cities/__listPlaceholder__`, which the handler widens one segment
      // deeper when nothing matches it, so the glob still grants it (#1428).
      test.todo('the in-page sandbox denies getDocs on cities (#1428)');

      test('a nested block under a final recursive wildcard needs one segment in it', () => {
        const nested = rules(header, "match /cities/{rest=**} { match /tag/{id} { allow read: if true; } }");
        expect(decide(nested, 'get', 'cities/tag/1').decision).toBe('DENY');
        expect(decide(nested, 'get', 'cities/SF/tag/1').decision).toBe('ALLOW');
      });

      test('a root ending in a recursive wildcard leaves at least one segment in it', () => {
        const recursiveRoot = rules(header, 'match /c/{id} { allow read: if true; }', '/databases/{db}/documents/{rest=**}');
        expect(decide(recursiveRoot, 'get', 'c/1').decision).toBe('DENY');
        expect(decide(recursiveRoot, 'get', 'z/1/c/1').decision).toBe('ALLOW');
      });

      test('a document under a whole-database glob is still allowed', () => {
        const everything = rules(header, 'match /{document=**} { allow read: if true; }');
        expect(decide(everything, 'get', 'cities/SF').decision).toBe('ALLOW');
      });

      // Firestore's docs say collection group queries need version 2, and no
      // capture shows what production does with one under version 1 (#1440).
      test.todo('a collection-group query under a version 1 whole-database glob (#1440)');

      test('a root ending in a recursive wildcard after documents does not govern every document', async () => {
        const recursiveRoot = rules(header, 'match /{document=**} { allow read: if true; }', '/databases/{db}/documents/{rest=**}');
        expect(rootGovernsEveryDocument(parseToAST(recursiveRoot)!)).toBe(false);
        await expect(getDocs(collectionGroup(sandboxDb(recursiveRoot), 'landmarks'))).rejects.toMatchObject(DENIED);
      });

      test('a root whose recursive wildcard holds documents still governs every document', () => {
        const wideRoot = rules(header, 'match /documents/{document=**} { allow read: if true; }', '/databases/{db}/{rest=**}');
        expect(rootGovernsEveryDocument(parseToAST(wideRoot)!)).toBe(true);
      });
    });
  }
});

describe('version 2: a recursive wildcard matches zero or more segments', () => {
  for (const { label, header } of VERSION_2) {
    describe(label, () => {
      const source = rules(header, CITY_GLOB);

      test('get cities/SF and cities/SF/landmarks/x are allowed', () => {
        expect(decide(source, 'get', 'cities/SF').decision).toBe('ALLOW');
        expect(decide(source, 'get', 'cities/SF/landmarks/x').decision).toBe('ALLOW');
      });

      test('list cities is allowed, as get cities/SF is', () => {
        expect(decide(source, 'list', 'cities').decision).toBe('ALLOW');
      });

      test('the in-page sandbox agrees', async () => {
        const db = sandboxDb(source);
        expect((await getDoc(doc(db, 'cities/SF'))).data()).toEqual({ a: 1 });
        expect((await getDocs(collection(db, 'cities'))).size).toBe(1);
      });

      test('zero segments match before trailing segments, below a final glob, and in a recursive root', () => {
        const group = rules(header, 'match /{path=**}/landmarks/{id} { allow read: if true; }');
        expect(decide(group, 'get', 'landmarks/x').decision).toBe('ALLOW');
        const nested = rules(header, "match /cities/{rest=**} { match /tag/{id} { allow read: if true; } }");
        expect(decide(nested, 'get', 'cities/tag/1').decision).toBe('ALLOW');
        const recursiveRoot = rules(header, 'match /c/{id} { allow read: if true; }', '/databases/{db}/documents/{rest=**}');
        expect(decide(recursiveRoot, 'get', 'c/1').decision).toBe('ALLOW');
        expect(rootGovernsEveryDocument(parseToAST(recursiveRoot)!)).toBe(true);
      });
    });
  }
});

describe("rules_version = '2+modules' resolves recursive wildcards as version 2", () => {
  // A `2+modules` source is resolved to plain version 2 before it compiles,
  // so only the match resolver sees the raw version; it reads it as 2.
  const blocks = (version: string, path: string) => {
    const ast = parseToAST(rules(`rules_version = '${version}';\n`, CITY_GLOB))!;
    return collectRootMatches(ast, path, []).map((match) => match.pathVariables);
  };

  test('cities/SF matches with an empty document binding', () => {
    expect(blocks('2+modules', 'cities/SF')).toEqual([{ database: '(default)', city: 'SF', document: '' }]);
  });

  test('version 1 resolves no block for the same AST shape', () => {
    expect(blocks('1', 'cities/SF')).toEqual([]);
    expect(blocks('1', 'cities/SF/landmarks/x')).toEqual([
      { database: '(default)', city: 'SF', document: 'landmarks/x' },
    ]);
  });
});
