import { expect, test } from 'bun:test';
import { evaluateStorageRules, parseStorageRules } from '../../src/storage/rules.ts';

test('public Storage Rules family exposes parser and evaluator through one facade', () => {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o { match /{path=**} { allow read: if true; } }
  }`);
  expect(evaluateStorageRules(rules, {
    request: { auth: null, method: 'get', path: '/b/bucket/o/file.txt' },
    resource: { size: 1 },
  }).allowed).toBe(true);
});
