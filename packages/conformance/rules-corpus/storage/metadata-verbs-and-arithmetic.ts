/**
 * ─── Scenario: metadata-verbs-and-arithmetic ─────────────────────────────────
 * The everyday Storage upload-guard surface: request.resource.size bounded by
 * arithmetic (+, -, *, /, >=, <=), content-type and custom-metadata checks
 * (request.resource.metadata, resource.contentType, resource.size),
 * request.method / request.path, a custom-claim OR branch
 * (request.auth.token), the granular `allow list` verb, and a recursive
 * `{allPaths=**}` public read tree. An owner-scoped `uploads` area with a
 * size-bounded create and an immutable-content-type update.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'Coverage: metadata, granular verbs, arithmetic operators',
  rationale:
    'Production must accept request.resource.size arithmetic (+/-/*/÷, >=, <=), request/resource content-type + metadata, request.method/path, request.auth.token OR-branch, allow list, and a recursive {allPaths=**} read tree.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{userId}/{fileName} {
      allow create: if request.auth != null
        && request.auth.uid == userId
        && request.method == 'create'
        && request.resource.size < 5 * 1024 * 1024
        && request.resource.size >= 1024
        && request.resource.size <= 10 * 1024 * 1024
        && request.resource.contentType.matches('image/.*')
        && request.resource.metadata.owner == request.auth.uid
        && (request.auth.token.admin == true || request.auth.uid == userId)
        && request.path != null;
      allow update: if request.auth != null
        && resource.size + 0 <= request.resource.size
        && request.resource.size - resource.size >= 0
        && request.resource.size / 1024 >= 1
        && resource.contentType == request.resource.contentType;
      allow list: if request.auth != null;
    }
    match /public/{allPaths=**} {
      allow read: if true;
    }
  }
}`,
  cases: [
    {
      description: 'owner uploads a valid image ALLOW',
      expectation: 'ALLOW',
      method: 'create',
      path: 'uploads/alice/photo.png',
      auth: { uid: 'alice' },
      resource: { size: 2048, contentType: 'image/png', metadata: { owner: 'alice' } },
    },
    {
      description: 'non-owner upload DENY',
      expectation: 'DENY',
      method: 'create',
      path: 'uploads/alice/photo.png',
      auth: { uid: 'bob' },
      resource: { size: 2048, contentType: 'image/png', metadata: { owner: 'bob' } },
    },
    {
      description: 'oversize upload DENY (size < 5MiB)',
      expectation: 'DENY',
      method: 'create',
      path: 'uploads/alice/big.png',
      auth: { uid: 'alice' },
      resource: { size: 6 * 1024 * 1024, contentType: 'image/png', metadata: { owner: 'alice' } },
    },
    {
      description: 'wrong content type DENY (matches image/.*)',
      expectation: 'DENY',
      method: 'create',
      path: 'uploads/alice/doc.pdf',
      auth: { uid: 'alice' },
      resource: { size: 2048, contentType: 'application/pdf', metadata: { owner: 'alice' } },
    },
    {
      description: 'update growing the object keeping content type ALLOW',
      expectation: 'ALLOW',
      method: 'update',
      path: 'uploads/alice/photo.png',
      auth: { uid: 'alice' },
      resource: { size: 4096, contentType: 'image/png', metadata: { owner: 'alice' } },
      existingResource: { size: 2048, contentType: 'image/png' },
    },
    {
      description: 'update changing content type DENY (immutable)',
      expectation: 'DENY',
      method: 'update',
      path: 'uploads/alice/photo.png',
      auth: { uid: 'alice' },
      resource: { size: 4096, contentType: 'image/jpeg', metadata: { owner: 'alice' } },
      existingResource: { size: 2048, contentType: 'image/png' },
    },
    {
      description: 'signed-in list ALLOW',
      expectation: 'ALLOW',
      method: 'list',
      path: 'uploads/alice/photo.png',
      auth: { uid: 'alice' },
    },
    {
      description: 'public recursive read ALLOW',
      expectation: 'ALLOW',
      method: 'get',
      path: 'public/a/b/c.txt',
      auth: null,
      existingResource: { size: 10, contentType: 'text/plain' },
    },
  ],
};
