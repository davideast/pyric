import { describe, expect, test } from 'bun:test';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { methodReturnType } from '../../../src/rules/modules/receiver-types.js';
import { resolveModules } from '../../../src/rules/modules/resolver.js';

function expression(source: string): Expression {
  const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{doc=**} {
    allow read: if ${source};
  }
}`);
  return ast.service.match.allows[0]!.condition;
}

describe('rules method return types', () => {
  test.each([
    ["'A'.lower()", 'string'],
    ["'a,b'.split(',')", 'list'],
    ["{'owner': true}.keys()", 'set'],
    ["{'owner': true}.diff({})", 'mapdiff'],
    ["'A'.matches('A')", 'boolean'],
    ["'A'.size()", 'number'],
    ["hashing.sha256('A'.toUtf8())", 'bytes'],
    ["duration.value(1, 's')", 'duration'],
    ['latlng.value(1, 2)', 'latlng'],
    ['timestamp.date(2026, 1, 1)', 'timestamp'],
  ] as const)('%s returns %s', (source, expected) => {
    expect(methodReturnType(expression(source))).toBe(expected);
  });

  test('Map.get remains value-dependent', () => {
    expect(methodReturnType(expression("{'owner': true}.get('owner')"))).toBeNull();
  });
});

const makeFirestoreSource = (imports: string) => `${imports}
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`;

const makeStorageSource = (imports: string, condition: string) => `rules_version = '2+modules';
${imports}
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if ${condition}; }
  }
}`;

describe('rules receiver types through module resolution', () => {
  test('enforces receiver types on Storage firestore lookup results', () => {
    for (const source of [
      "firestore.get(/databases/(default)/documents/users/a).data.matches('x')",
      'firestore.exists(/databases/(default)/documents/users/a).keys().hasAll([])',
      "firestore.get(/databases/(default)/documents/users/a).data.split('x').size() > 0",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", 'broken()'),
        { modules: { './policy': `export function broken() { return ${source}; }` } },
      );
      expect(result.success, source).toBe(false);
    }
  });

  test('enforces receiver types on direct Firestore lookup results and propagated values', () => {
    const modules = [
      `export function broken() { return get(/databases/$(database)/documents/users/a).data.matches('x'); }`,
      `export function broken() { return exists(/databases/$(database)/documents/users/a).keys().hasAll([]); }`,
      `export function broken() { return getAfter(/databases/$(database)/documents/users/a).data.split('x').size() > 0; }`,
      `function loaded() { return get(/databases/$(database)/documents/users/a); }
       export function broken() { let document = loaded(); return document.data.matches('x'); }`,
      `function misuse(value) { return value.keys().hasAll([]); }
       export function broken() { return misuse(exists(/databases/$(database)/documents/users/a)); }`,
    ];
    for (const source of modules) {
      const result = resolveModules(makeFirestoreSource("import { broken } from './policy';"), {
        modules: { './policy': source },
      });
      expect(result.success, source).toBe(false);
    }
  });

  test('admits accepted path.bind and rejects production-rejected namespaces', () => {
    const bind = resolveModules(
      makeFirestoreSource("import { bindPath } from './policy';"),
      { modules: { './policy': 'export function bindPath(path) { return path.bind({}); }' } },
    );
    const rejected = resolveModules(
      makeFirestoreSource("import { invalidMath } from './policy';"),
      { modules: { './policy': `
        export function invalidMath() {
          return math.isInfinite(1.0) || cast.bool(1);
        }
      ` } },
    );

    expect(bind.success).toBe(true);
    expect(rejected.success).toBe(false);
  });
});
