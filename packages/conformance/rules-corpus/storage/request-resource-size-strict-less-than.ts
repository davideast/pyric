/**
 * Storage Rules conformance scenario for `storage-rules#100`:
 * `request.resource.size < 10 * 1024 * 1024` strict arithmetic upper bound.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-REQUEST-RESOURCE-SIZE-LT',
  rationale:
    'Pins strict less-than boundary evaluation for request.resource.size < 10 * 1024 * 1024 across zero, N - 1, exact N, N + 1, update, and delete.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{id} {
      allow write: if request.resource.size < 10 * 1024 * 1024;
    }
  }
}`,
  cases: [
    {
      description: 'create with zero-byte payload allows',
      expectation: 'ALLOW',
      method: 'create',
      path: 'uploads/f1',
      resource: { size: 0 },
    },
    {
      description: 'create one byte below 10 * 1024 * 1024 allows',
      expectation: 'ALLOW',
      method: 'create',
      path: 'uploads/f1',
      resource: { size: 10 * 1024 * 1024 - 1 },
    },
    {
      description: 'create at exact 10 * 1024 * 1024 boundary denies',
      expectation: 'DENY',
      method: 'create',
      path: 'uploads/f1',
      resource: { size: 10 * 1024 * 1024 },
    },
    {
      description: 'create one byte above 10 * 1024 * 1024 denies',
      expectation: 'DENY',
      method: 'create',
      path: 'uploads/f1',
      resource: { size: 10 * 1024 * 1024 + 1 },
    },
    {
      description: 'update below 10 * 1024 * 1024 allows',
      expectation: 'ALLOW',
      method: 'update',
      path: 'uploads/f1',
      resource: { size: 4096 },
      existingResource: { size: 1024 },
    },
    {
      description: 'delete with no incoming request.resource denies',
      expectation: 'DENY',
      method: 'delete',
      path: 'uploads/f1',
      existingResource: { size: 1024 },
    },
  ],
};
