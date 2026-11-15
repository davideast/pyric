import { describe, expect, test } from 'bun:test';
import {
  RulesCompileError,
  firestoreRules,
  lint,
  storageRules,
} from '../../src/index.js';
import { parseStorageRules } from '../../src/storage/rules.js';

describe('non-module rules reject export function declarations', () => {
  test('rejects global export function in rules_version = 2 across lint(), firestoreRules(), and storageRules()', () => {
    const fsSource = [
      "rules_version = '2';",
      'export function allowAll() { return true; }',
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow read: if allowAll();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const stSource = [
      "rules_version = '2';",
      'export function allowAll() { return true; }',
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      allow read: if allowAll();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const fsErrors = lint(fsSource).filter((issue) => issue.severity === 'error');
    expect(fsErrors.length).toBeGreaterThan(0);
    expect(fsErrors.some((issue) => issue.code === 'UNRESOLVED_MODULES' && issue.line === 2)).toBe(true);

    const stErrors = lint(stSource).filter((issue) => issue.severity === 'error');
    expect(stErrors.length).toBeGreaterThan(0);
    expect(stErrors.some((issue) => issue.code === 'UNRESOLVED_MODULES' && issue.line === 2)).toBe(true);

    expect(() => firestoreRules(fsSource)).toThrow(RulesCompileError);
    expect(() => storageRules(stSource, { bucket: 'demo.appspot.com' })).toThrow(RulesCompileError);
  });

  test('rejects service-scope and match-scope export functions in rules_version = 2 and rules_version = 1', () => {
    const fsNested = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  export function svcCheck() { return true; }',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      export function matchCheck() { return svcCheck(); }',
      '      allow read: if matchCheck();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const fsNestedErrors = lint(fsNested).filter((issue) => issue.code === 'UNRESOLVED_MODULES');
    expect(fsNestedErrors.map((issue) => issue.line)).toEqual([3, 6]);
    expect(() => firestoreRules(fsNested)).toThrow(RulesCompileError);

    const stNested = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      '      export function matchCheck() { return true; }',
      '      allow read: if matchCheck();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const stNestedErrors = lint(stNested).filter((issue) => issue.code === 'UNRESOLVED_MODULES');
    expect(stNestedErrors.map((issue) => issue.line)).toEqual([5]);
    expect(() => storageRules(stNested, { bucket: 'demo.appspot.com' })).toThrow(RulesCompileError);

    const v1Source = [
      "rules_version = '1';",
      'export function allowAll() { return true; }',
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow read: if allowAll();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(lint(v1Source).some((issue) => issue.code === 'UNRESOLVED_MODULES' && issue.severity === 'error')).toBe(true);
    expect(() => firestoreRules(v1Source)).toThrow(RulesCompileError);
  });

  test('continues to accept export function in rules_version = 2+modules during lint()', () => {
    const modularSource = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      'service cloud.firestore {',
      '  export function allowSignedIn() { return isAuthenticated(); }',
      '  match /databases/{database}/documents {',
      '    match /items/{id} {',
      '      allow read: if allowSignedIn();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const errors = lint(modularSource).filter((issue) => issue.severity === 'error');
    expect(errors).toEqual([]);
  });

  test('rejects export function in secondary service blocks of multi-service rules_version = 2 files and direct parseStorageRules()', () => {
    const fsThenSt = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} { allow get: if false; }',
      '  }',
      '}',
      'service firebase.storage {',
      '  export function badStorage() { return true; }',
      '  match /b/{bucket}/o {',
      '    match /items/{id} { allow get: if badStorage(); }',
      '  }',
      '}',
    ].join('\n');

    const stThenFs = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} { allow get: if false; }',
      '  }',
      '}',
      'service cloud.firestore {',
      '  export function badFirestore() { return true; }',
      '  match /databases/{database}/documents {',
      '    match /items/{id} { allow get: if badFirestore(); }',
      '  }',
      '}',
    ].join('\n');

    const globalMulti = [
      "rules_version = '2';",
      'export function sharedBad() { return true; }',
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} { allow get: if sharedBad(); }',
      '  }',
      '}',
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} { allow get: if sharedBad(); }',
      '  }',
      '}',
    ].join('\n');

    const fsThenStErrors = lint(fsThenSt).filter((issue) => issue.code === 'UNRESOLVED_MODULES');
    expect(fsThenStErrors.map((issue) => issue.line)).toEqual([8]);

    const stThenFsErrors = lint(stThenFs).filter((issue) => issue.code === 'UNRESOLVED_MODULES');
    expect(stThenFsErrors.map((issue) => issue.line)).toEqual([8]);

    const globalMultiErrors = lint(globalMulti).filter((issue) => issue.code === 'UNRESOLVED_MODULES');
    expect(globalMultiErrors.map((issue) => issue.line)).toEqual([2]);

    expect(() => storageRules(fsThenSt, { bucket: 'demo.appspot.com' })).toThrow(RulesCompileError);
    expect(() => firestoreRules(stThenFs)).toThrow(RulesCompileError);
    expect(() => parseStorageRules(fsThenSt)).toThrow(SyntaxError);
  });
});

describe('lint() preserves authored line numbers when mixing stdlib and relative imports', () => {
  test('reports GLOB_MATCH_COUNT at exact authored line for mixed stdlib and relative imports', () => {
    const mixedSource = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      "import { customCheck } from './local';",
      '',
      '// comment line 5',
      '// comment line 6',
      '// comment line 7',
      '// comment line 8',
      '// comment line 9',
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{a=**}/items/{b=**} {',
      '      allow read: if isAuthenticated() && customCheck();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const glob = lint(mixedSource).find((issue) => issue.code === 'GLOB_MATCH_COUNT');
    expect(glob).toBeDefined();
    expect(glob?.line).toBe(12);
  });

  test('preserves authored line numbers with multiline relative imports, double quotes, and importsFirst ordering', () => {
    const multilineMixed = [
      'import {',
      '  customCheck,',
      '  extraHelper,',
      '} from "./local";',
      "import { isAuthenticated } from 'auth';",
      "rules_version = '2+modules';",
      '',
      '/* block',
      '   comment */',
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /{a=**}/docs/{b=**} {',
      '      allow read: if isAuthenticated() && customCheck() && extraHelper();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const glob = lint(multilineMixed).find((issue) => issue.code === 'GLOB_MATCH_COUNT');
    expect(glob).toBeDefined();
    expect(glob?.line).toBe(12);
  });

  test('preserves authored line numbers for Storage rules mixing stdlib and relative imports', () => {
    const mixedStorage = [
      "rules_version = '2+modules';",
      "import { isAuthenticated } from 'auth';",
      "import { customUploadCheck } from './uploads';",
      '',
      '// spacing comment',
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /{a=**}/files/{b=**} {',
      '      allow read: if isAuthenticated() && customUploadCheck();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const glob = lint(mixedStorage).find((issue) => issue.code === 'GLOB_MATCH_COUNT');
    expect(glob).toBeDefined();
    expect(glob?.line).toBe(8);
  });
});
