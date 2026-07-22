import { describe, expect, test } from 'bun:test';
import { resolveModules } from '../../../src/rules/modules/resolver.js';

const makeSource = (imports: string) => `${imports}
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

describe('service-aware module receiver results', () => {
  test('enforces receiver types on Storage firestore lookup results', () => {
    for (const expression of [
      "firestore.get(/databases/(default)/documents/users/a).data.matches('x')",
      'firestore.exists(/databases/(default)/documents/users/a).keys().hasAll([])',
      "firestore.get(/databases/(default)/documents/users/a).data.split('x').size() > 0",
    ]) {
      const result = resolveModules(
        makeStorageSource("import { broken } from './policy';", 'broken()'),
        { modules: { './policy': `export function broken() { return ${expression}; }` } },
      );

      expect(result.success, expression).toBe(false);
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
      const result = resolveModules(makeSource("import { broken } from './policy';"), {
        modules: { './policy': source },
      });
      expect(result.success, source).toBe(false);
    }
  });

  test('admits accepted path.bind and rejects production-rejected namespaces', () => {
    const bind = resolveModules(
      makeSource("import { bindPath } from './policy';"),
      { modules: { './policy': 'export function bindPath(path) { return path.bind({}); }' } },
    );
    const rejected = resolveModules(
      makeSource("import { invalidMath } from './policy';"),
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
