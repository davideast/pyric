import type { ScenarioRecord } from './types.ts';

export const scenario: ScenarioRecord = {
  group: 'fix-class',
  fm: 'FIRESTORE-COMMON-STDLIB',
  rationale:
    'Exact auth/membership stdlib bodies under cloud.firestore: auth null/uid, custom claims, explicit membership maps, and role equality.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
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
    { description: 'isAuthenticated: signed-in caller allowed', expectation: 'ALLOW', method: 'create', path: 'authenticated/a', auth: { uid: 'alice' }, data: {} },
    { description: 'isAuthenticated: anonymous caller denied', expectation: 'DENY', method: 'create', path: 'authenticated/a', auth: null, data: {} },
    { description: 'isOwner: uid matches path owner', expectation: 'ALLOW', method: 'create', path: 'owners/alice', auth: { uid: 'alice' }, data: {} },
    { description: 'isOwner: uid differs from path owner', expectation: 'DENY', method: 'create', path: 'owners/alice', auth: { uid: 'bob' }, data: {} },
    { description: 'hasClaim: non-null custom claim allowed', expectation: 'ALLOW', method: 'create', path: 'claims/a', auth: { uid: 'alice', token: { plan: 'pro' } }, data: {} },
    { description: 'hasClaim: missing custom claim denied', expectation: 'DENY', method: 'create', path: 'claims/a', auth: { uid: 'alice', token: {} }, data: {} },
    { description: 'hasClaimRole: exact role allowed', expectation: 'ALLOW', method: 'create', path: 'claim-roles/a', auth: { uid: 'alice', token: { role: 'editor' } }, data: {} },
    { description: 'hasClaimRole: different role denied', expectation: 'DENY', method: 'create', path: 'claim-roles/a', auth: { uid: 'alice', token: { role: 'viewer' } }, data: {} },
    { description: 'isMemberOf: uid key present in explicit map', expectation: 'ALLOW', method: 'create', path: 'members/a', auth: { uid: 'alice', token: { members: { alice: 'viewer' } } }, data: {} },
    { description: 'isMemberOf: uid key absent from explicit map', expectation: 'DENY', method: 'create', path: 'members/a', auth: { uid: 'bob', token: { members: { alice: 'viewer' } } }, data: {} },
    { description: 'hasRole: uid has exact map role', expectation: 'ALLOW', method: 'create', path: 'member-roles/a', auth: { uid: 'alice', token: { members: { alice: 'editor' } } }, data: {} },
    { description: 'hasRole: uid has different map role', expectation: 'DENY', method: 'create', path: 'member-roles/a', auth: { uid: 'alice', token: { members: { alice: 'viewer' } } }, data: {} },
  ],
};
