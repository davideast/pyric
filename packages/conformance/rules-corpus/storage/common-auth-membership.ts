/**
 * Common-library admission probe: the exact auth + membership function bodies
 * proposed for both Firestore and Storage. Plain v2 is intentional — the
 * production oracle proves function semantics; Pyric's separate resolver tests
 * prove that 2+modules lowers to this deployable shape.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-COMMON-STDLIB',
  rationale:
    'Exact auth/membership stdlib bodies under firebase.storage: auth null/uid, custom claims, explicit membership maps, and role equality.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isAuthenticated() {
      return request.auth != null;
    }
    function isOwner(userId) {
      return isAuthenticated() && request.auth.uid == userId;
    }
    function hasClaim(claim) {
      return request.auth != null && request.auth.token[claim] != null;
    }
    function hasClaimRole(claim, role) {
      return request.auth != null && request.auth.token[claim] == role;
    }
    function isMemberOf(membersMap) {
      return request.auth != null && request.auth.uid in membersMap;
    }
    function hasRole(membersMap, role) {
      return request.auth != null && membersMap[request.auth.uid] == role;
    }

    match /authenticated/{fileId} {
      allow create: if isAuthenticated();
    }
    match /owners/{ownerId} {
      allow create: if isOwner(ownerId);
    }
    match /claims/{fileId} {
      allow create: if hasClaim('plan');
    }
    match /claim-roles/{fileId} {
      allow create: if hasClaimRole('role', 'editor');
    }
    match /members/{fileId} {
      allow create: if isMemberOf(request.auth.token.members);
    }
    match /member-roles/{fileId} {
      allow create: if hasRole(request.auth.token.members, 'editor');
    }
  }
}`,
  cases: [
    { description: 'isAuthenticated: signed-in caller allowed', expectation: 'ALLOW', method: 'create', path: 'authenticated/a.txt', auth: { uid: 'alice' }, resource: { size: 1 } },
    { description: 'isAuthenticated: anonymous caller denied', expectation: 'DENY', method: 'create', path: 'authenticated/a.txt', auth: null, resource: { size: 1 } },
    { description: 'isOwner: uid matches path owner', expectation: 'ALLOW', method: 'create', path: 'owners/alice', auth: { uid: 'alice' }, resource: { size: 1 } },
    { description: 'isOwner: uid differs from path owner', expectation: 'DENY', method: 'create', path: 'owners/alice', auth: { uid: 'bob' }, resource: { size: 1 } },
    { description: 'hasClaim: non-null custom claim allowed', expectation: 'ALLOW', method: 'create', path: 'claims/a.txt', auth: { uid: 'alice', token: { plan: 'pro' } }, resource: { size: 1 } },
    { description: 'hasClaim: missing custom claim denied', expectation: 'DENY', method: 'create', path: 'claims/a.txt', auth: { uid: 'alice', token: {} }, resource: { size: 1 } },
    { description: 'hasClaimRole: exact role allowed', expectation: 'ALLOW', method: 'create', path: 'claim-roles/a.txt', auth: { uid: 'alice', token: { role: 'editor' } }, resource: { size: 1 } },
    { description: 'hasClaimRole: different role denied', expectation: 'DENY', method: 'create', path: 'claim-roles/a.txt', auth: { uid: 'alice', token: { role: 'viewer' } }, resource: { size: 1 } },
    { description: 'isMemberOf: uid key present in explicit map', expectation: 'ALLOW', method: 'create', path: 'members/a.txt', auth: { uid: 'alice', token: { members: { alice: 'viewer' } } }, resource: { size: 1 } },
    { description: 'isMemberOf: uid key absent from explicit map', expectation: 'DENY', method: 'create', path: 'members/a.txt', auth: { uid: 'bob', token: { members: { alice: 'viewer' } } }, resource: { size: 1 } },
    { description: 'hasRole: uid has exact map role', expectation: 'ALLOW', method: 'create', path: 'member-roles/a.txt', auth: { uid: 'alice', token: { members: { alice: 'editor' } } }, resource: { size: 1 } },
    { description: 'hasRole: uid has different map role', expectation: 'DENY', method: 'create', path: 'member-roles/a.txt', auth: { uid: 'alice', token: { members: { alice: 'viewer' } } }, resource: { size: 1 } },
  ],
};
