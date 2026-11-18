/**
 * Storage Rules Test API compile-check probe for a `storage.rules` source
 * containing an unterminated single-quoted string literal (`storage-rules#97`).
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  allowCompileError: true,
  fm: 'STORAGE-SYNTAX-UNTERMINATED-STRING',
  rationale:
    'Records how projects.test rejects a storage.rules source containing an unterminated single-quoted string literal at compile time (COMPILE_ERROR with ERROR sourcePosition diagnostics).',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow read: if 'unterminated;
    }
  }
}`,
  cases: [
    {
      description: 'storage get request against ruleset with unterminated string literal',
      expectation: 'DENY',
      method: 'get',
      path: 'items/d1',
    },
  ],
};
