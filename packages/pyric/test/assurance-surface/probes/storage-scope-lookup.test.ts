import { describe, expect, test } from 'bun:test';
import {
  dedupeLookups,
  discoverScopeMembershipLookups,
  peerHasLiveMembershipAtPath,
} from '../../../src/assurance-surface/probes/storage-scope-lookup.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import { parseResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';

describe('storage-scope-lookup', () => {
  test('discovers positive caller-identity lookups without treating negated ban-list checks as membership grants', () => {
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/assets/{assetId} {
      allow create: if !(request.auth.uid in firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.bannedUids);
    }
  }
}`;
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/members/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;
    const surface = projectRuleSurface({
      firestore: firestoreRules,
      storage: storageRules,
    });
    const site = {
      service: 'storage' as const,
      op: 'uploadBytes',
      path: 'orgs/{orgId}/assets/{assetId}',
      pathVariables: [{ name: 'orgId' }, { name: 'assetId' }],
      source: 'src/upload.ts:10',
      resolution: 'resolved' as const,
    };
    const sitePattern = parseResourcePattern('storage', site.path);
    const matching = surface.matching(sitePattern, site.op);
    const allPath = surface.matching(sitePattern);
    const owner = { role: 'owner' as const, uid: 'u-alice', email: 'a@example.test', displayName: 'Alice', token: {} };
    const peer = { role: 'peer' as const, uid: 'u-bob', email: 'b@example.test', displayName: 'Bob', token: {} };

    const discovered = discoverScopeMembershipLookups(
      site,
      sitePattern,
      matching,
      allPath,
      surface,
      [],
      undefined,
      owner,
    );
    expect(discovered.directLookups).toHaveLength(1);
    expect(discovered.directLookups[0]!.expectedAuth).toBe('uid-not-in-list');
    // Only the Firestore orgs/{orgId}/members/{auth.uid} subcollection is treated as positive membership!
    expect(discovered.membershipLookups).toHaveLength(1);
    expect(discovered.membershipLookups[0]!.kind).toBe('exists');
    expect(dedupeLookups([...discovered.membershipLookups, ...discovered.membershipLookups])).toHaveLength(1);

    expect(
      peerHasLiveMembershipAtPath(
        site.path,
        discovered.primaryRulePattern,
        'orgs/shared-org/assets/item-1',
        discovered.membershipLookups,
        peer,
        { firestore: { 'orgs/shared-org/members/u-bob': { role: 'editor' } } },
      ),
    ).toBe(true);
    expect(
      peerHasLiveMembershipAtPath(
        site.path,
        discovered.primaryRulePattern,
        'orgs/alice-only-org/assets/item-1',
        discovered.membershipLookups,
        peer,
        { firestore: { 'orgs/shared-org/members/u-bob': { role: 'editor' } } },
      ),
    ).toBe(false);
  });
});
