/**
 * ─── Pack 6: firestore-lookup ───────────────────────────────────────────────
 * Cross-service firestore.get()/exists() with $(expr) path interpolation
 * (path param and request.auth.uid). Mocks use the QUALIFIED firestore.get /
 * firestore.exists names; exists() mock is a bool.
 */
import type { StoragePackRecord } from './types.ts';

export const pack: StoragePackRecord = {
  fm: 'STORAGE-XSVC',
  rationale:
    'firestore.get()/exists() cross-service lookups with $(expr) interpolation, qualified function-mock names, and bool exists() results.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /profiles/{userId}/{fileId} {
      allow get: if firestore.get(/databases/(default)/documents/users/$(userId)).data.uid == request.auth.uid;
      allow create: if firestore.exists(/databases/(default)/documents/members/$(request.auth.uid));
    }
  }
}`,
  cases: [
    {
      description: 'firestore.get(): profile uid matches caller → allow',
      expectation: 'ALLOW', method: 'get', path: 'profiles/alice/avatar.png', auth: { uid: 'alice' }, existingResource: { size: 100 },
      functionMocks: [{ function: 'get', path: 'users/alice', result: { uid: 'alice' } }],
    },
    {
      description: 'firestore.get(): profile uid mismatch → deny',
      expectation: 'DENY', method: 'get', path: 'profiles/alice/avatar.png', auth: { uid: 'bob' }, existingResource: { size: 100 },
      functionMocks: [{ function: 'get', path: 'users/alice', result: { uid: 'alice' } }],
    },
    {
      description: 'firestore.exists(): membership present → allow create',
      expectation: 'ALLOW', method: 'create', path: 'profiles/alice/avatar.png', auth: { uid: 'alice' }, resource: { size: 100, contentType: 'image/png' },
      functionMocks: [{ function: 'exists', path: 'members/alice', result: true }],
    },
    {
      description: 'firestore.exists(): membership absent → deny create',
      expectation: 'DENY', method: 'create', path: 'profiles/bob/avatar.png', auth: { uid: 'bob' }, resource: { size: 100, contentType: 'image/png' },
      functionMocks: [{ function: 'exists', path: 'members/bob', result: false }],
    },
  ],
};
