/**
 * Storage Rules conformance scenario for `storage-rules#103`:
 * path-parameter binding (`{sessionId}`) accessible inside the `if` condition.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  pendingRowLink: true,
  fm: 'STORAGE-PATH-PARAM-IN-CONDITION',
  rationale:
    'Pins single and nested path-parameter bindings ({sessionId}, {userId}/{sessionId}) read directly inside allow condition expressions.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{sessionId} {
      allow read: if request.auth != null && request.auth.uid == sessionId;
    }
    match /users/{userId}/sessions/{sessionId} {
      allow create: if request.auth != null
        && request.auth.uid == userId
        && request.resource.metadata.sessionId == sessionId;
    }
  }
}`,
  cases: [
    {
      description: 'single path parameter {sessionId} matching request.auth.uid allows',
      expectation: 'ALLOW',
      method: 'get',
      path: 'sessions/u1',
      auth: { uid: 'u1' },
    },
    {
      description: 'single path parameter {sessionId} differing from request.auth.uid denies',
      expectation: 'DENY',
      method: 'get',
      path: 'sessions/u1',
      auth: { uid: 'u2' },
    },
    {
      description: 'single path parameter {sessionId} with anonymous caller denies',
      expectation: 'DENY',
      method: 'get',
      path: 'sessions/u1',
      auth: null,
    },
    {
      description: 'nested path parameters {userId} and {sessionId} both matching allow',
      expectation: 'ALLOW',
      method: 'create',
      path: 'users/u1/sessions/s9',
      auth: { uid: 'u1' },
      resource: { size: 8, metadata: { sessionId: 's9' } },
    },
    {
      description: 'nested path parameter {sessionId} mismatching metadata denies',
      expectation: 'DENY',
      method: 'create',
      path: 'users/u1/sessions/s9',
      auth: { uid: 'u1' },
      resource: { size: 8, metadata: { sessionId: 's0' } },
    },
  ],
};
