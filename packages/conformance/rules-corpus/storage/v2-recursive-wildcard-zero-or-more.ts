/**
 * Storage Rules conformance scenario for `storage-rules#102`:
 * under `rules_version = '2'`, `{allPaths=**}` matches zero or more remaining segments.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-V2-RECURSIVE-WILDCARD-ZERO-OR-MORE',
  rationale:
    'Pins that rules_version 2 recursive wildcard {allPaths=**} matches zero, one, and multiple remaining path segments.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /trees/{allPaths=**} {
      allow read: if true;
    }
    match /scoped/{prefix}/{allPaths=**} {
      allow read: if true;
    }
  }
}`,
  cases: [
    {
      description: 'v2 glob under /trees/{allPaths=**} matches zero remaining segments',
      expectation: 'ALLOW',
      method: 'get',
      path: 'trees',
    },
    {
      description: 'v2 glob under /trees/{allPaths=**} matches one remaining segment',
      expectation: 'ALLOW',
      method: 'get',
      path: 'trees/leaf.txt',
    },
    {
      description: 'v2 glob under /trees/{allPaths=**} matches three remaining segments',
      expectation: 'ALLOW',
      method: 'get',
      path: 'trees/a/b/leaf.txt',
    },
    {
      description: 'v2 glob after single-segment wildcard matches zero remaining segments',
      expectation: 'ALLOW',
      method: 'get',
      path: 'scoped/item.txt',
    },
    {
      description: 'v2 glob after single-segment wildcard matches nested remaining segments',
      expectation: 'ALLOW',
      method: 'get',
      path: 'scoped/sub/item.txt',
    },
    {
      description: 'unmatched prefix outside glob tree denies',
      expectation: 'DENY',
      method: 'get',
      path: 'other/item.txt',
    },
  ],
};
