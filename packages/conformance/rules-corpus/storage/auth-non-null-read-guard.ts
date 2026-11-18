/**
 * Storage Rules conformance scenario for `storage-rules#98` and `storage-rules#99`:
 * `match /sessions/{id} { allow read: if request.auth != null; }` across signed-in
 * and anonymous `get` / `list` requests.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  pendingRowLink: true,
  fm: 'STORAGE-AUTH-NON-NULL-READ',
  rationale:
    'Pins that allow read: if request.auth != null under match /sessions/{id} grants signed-in get/list requests and denies anonymous get/list requests.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{id} {
      allow read: if request.auth != null;
    }
  }
}`,
  cases: [
    {
      description: 'signed-in get on /sessions/{id} allows',
      expectation: 'ALLOW',
      method: 'get',
      path: 'sessions/s1',
      auth: { uid: 'u1' },
    },
    {
      description: 'signed-in list on /sessions/{id} allows',
      expectation: 'ALLOW',
      method: 'list',
      path: 'sessions/s1',
      auth: { uid: 'u1' },
    },
    {
      description: 'anonymous get with explicit null auth denies',
      expectation: 'DENY',
      method: 'get',
      path: 'sessions/s1',
      auth: null,
    },
    {
      description: 'anonymous list with omitted auth denies',
      expectation: 'DENY',
      method: 'list',
      path: 'sessions/s1',
    },
    {
      description: 'signed-in get outside /sessions/{id} denies',
      expectation: 'DENY',
      method: 'get',
      path: 'items/i1',
      auth: { uid: 'u1' },
    },
  ],
};
