/**
 * Storage Rules conformance scenario for `storage-rules#94`:
 * compound `service firebase.storage` ruleset exercising nested `match` blocks,
 * `allow read` / `allow write`, `request.method == 'delete'` short-circuiting,
 * `request.resource.size` arithmetic bounds, and `request.resource.contentType`
 * equality across read, create, and delete requests.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  pendingRowLink: true,
  fm: 'STORAGE-PARSE-COMPOUND-RULESET',
  rationale:
    'Pins that projects.test compiles a compound service firebase.storage ruleset combining nested match blocks, allow read/write guards, request.method short-circuiting, arithmetic size bounds, and contentType equality, and evaluates read/create/delete requests as expected.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{itemId} {
      allow write: if request.auth != null
                   && (request.method == 'delete'
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`,
  cases: [
    {
      description: 'signed-in get on /items/{itemId} allows',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/item-1',
      auth: { uid: 'u1' },
    },
    {
      description: 'anonymous get on /items/{itemId} denies',
      expectation: 'DENY',
      method: 'get',
      path: 'items/item-1',
      auth: null,
    },
    {
      description: 'signed-in create under 10 MiB json allows',
      expectation: 'ALLOW',
      method: 'create',
      path: 'items/item-1',
      auth: { uid: 'u1' },
      resource: { size: 1024, contentType: 'application/json' },
    },
    {
      description: 'signed-in create at 10 MiB boundary denies',
      expectation: 'DENY',
      method: 'create',
      path: 'items/item-1',
      auth: { uid: 'u1' },
      resource: { size: 10 * 1024 * 1024, contentType: 'application/json' },
    },
    {
      description: 'signed-in create with non-json contentType denies',
      expectation: 'DENY',
      method: 'create',
      path: 'items/item-1',
      auth: { uid: 'u1' },
      resource: { size: 1024, contentType: 'text/plain' },
    },
    {
      description: 'signed-in delete without request.resource allows',
      expectation: 'ALLOW',
      method: 'delete',
      path: 'items/item-1',
      auth: { uid: 'u1' },
    },
  ],
};
