/**
 * Storage Rules Test API compile-check probe for a `storage.rules` source
 * declaring only `service cloud.firestore` when evaluated against a Storage
 * object request (`storage-rules#95`).
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  allowCompileError: true,
  fm: 'STORAGE-SERVICE-DECLARATION',
  rationale:
    'Records whether projects.test compiles or rejects a storage.rules source whose sole service block is service cloud.firestore when evaluated against a Storage get request.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if true;
    }
  }
}`,
  cases: [
    {
      description: 'storage get request against a sole service cloud.firestore ruleset',
      expectation: 'DENY',
      method: 'get',
      path: 'items/d1',
    },
  ],
};
