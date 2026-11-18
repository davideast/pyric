/**
 * Storage Rules Test API compile-check probe for a `storage.rules` source
 * declaring an unknown service name (`service foo.bar`) when evaluated against
 * a Storage object request (`storage-rules#95`).
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  pendingRowLink: true,
  allowCompileError: true,
  fm: 'STORAGE-SERVICE-DECLARATION',
  rationale:
    'Records whether projects.test compiles or rejects a storage.rules source declaring an unknown service name (service foo.bar) and captures any compile diagnostics alongside the Storage get verdict.',
  rules: `rules_version = '2';
service foo.bar {
  match /items/{id} {
    allow read: if true;
  }
}`,
  cases: [
    {
      description: 'storage get request against an unknown service foo.bar ruleset',
      expectation: 'DENY',
      method: 'get',
      path: 'items/d1',
    },
  ],
};
