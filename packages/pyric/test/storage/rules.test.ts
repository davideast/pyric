import { expect, test } from 'bun:test';
import { evaluateStorageRules, parseStorageRules } from '../../src/storage/rules.ts';
import { compileStorageRules } from '../../src/storage/rules-resolution.js';

test('public Storage Rules family exposes parser and evaluator through one facade', () => {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o { match /{path=**} { allow read: if true; } }
  }`);
  expect(evaluateStorageRules(rules, {
    request: { auth: null, method: 'get', path: '/b/bucket/o/file.txt' },
    resource: { size: 1 },
  }).allowed).toBe(true);
});

test('public parseStorageRules refuses invalid matches() regexes, refuses duplicate services, and evaluates the Storage block of multi-service files (#1334, #2441)', () => {
  expect(() => parseStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o { match /{path=**} { allow read: if 'a'.matches('('); } }
}`)).toThrow('Storage rules do not compile: Invalid regular expression pattern. Pattern: (.');

  expect(() => compileStorageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o { match /a/{id} { allow read: if true; } }
}
service firebase.storage {
  match /b/{bucket}/o { match /b/{id} { allow read: if true; } }
}`)).toThrow('Storage rules do not compile: Duplicate service name declaration.');

  const multi = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} { allow read: if false; }
  }
}
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} { allow get: if id == 'ok.txt'; }
  }
}`;
  const parsed = parseStorageRules(multi);
  expect(evaluateStorageRules(parsed, {
    request: { auth: null, method: 'get', path: '/b/bucket/o/files/ok.txt' },
    resource: { size: 1 },
  }).allowed).toBe(true);
  expect(evaluateStorageRules(parsed, {
    request: { auth: null, method: 'get', path: '/b/bucket/o/files/no.txt' },
    resource: { size: 1 },
  }).allowed).toBe(false);
  expect(compileStorageRules(multi).resolution.targetService).toBe('firebase.storage');

  const modularMulti = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} { allow read: if false; }
  }
}
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{id} { allow get: if isAuthenticated(); }
  }
}`;
  const compiledModular = compileStorageRules(modularMulti);
  expect(evaluateStorageRules(compiledModular.rules, {
    request: { auth: { uid: 'u1' }, method: 'get', path: '/b/bucket/o/files/ok.txt' },
    resource: { size: 1 },
  }).allowed).toBe(true);
});
