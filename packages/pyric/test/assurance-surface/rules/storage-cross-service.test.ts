import { describe, expect, test } from 'bun:test';
import { parseResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';
import { projectRuleSurface } from '../../../src/assurance-surface/usage.js';

describe('CrossServiceLookup extraction for Cloud Storage rules', () => {
  test('extracts crossServiceReads for firestore.get and firestore.exists across multi-bucket rules without sentinel leakage', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  function canWriteOrg(orgId) {',
      '    let member = firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));',
      "    return member != null && member.data.role == 'editor';",
      '  }',
      '  function shadowedFirestore(firestore, orgId) {',
      '    return firestore.exists(/databases/(default)/documents/orgs/$(orgId));',
      '  }',
      '  match /b/media-prod/o {',
      '    match /orgs/{orgId}/assets/{assetId} {',
      '      allow create: if request.auth != null && canWriteOrg(orgId) && !firestore.exists(/databases/(default)/documents/bans/$(request.auth.uid));',
      '      allow read: if request.auth != null && firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.members.hasAny([request.auth.uid]);',
      '    }',
      '  }',
      '  match /b/exports-prod/o {',
      '    match /reports/{reportId} {',
      '      allow get: if request.auth != null && firestore.exists(/databases/analytics/documents/acl/$(request.auth.uid)) && !shadowedFirestore({}, reportId);',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({ storage: rules });

    const mediaWrite = surface.matching(
      parseResourcePattern('storage', 'orgs/acme/assets/logo.png', 'media-prod'),
      'uploadBytes',
    )[0]!;
    expect(mediaWrite.overbroadAuthOnlyWrite).toBe(false);
    expect(mediaWrite.crossServiceReads).toEqual([
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: parseResourcePattern('firestore', 'orgs/{orgId}/members/{auth.uid}'),
        field: 'role',
        expectedValue: 'editor',
      },
    ]);

    const mediaRead = surface.matching(
      parseResourcePattern('storage', 'orgs/acme/assets/logo.png', 'media-prod'),
      'getBytes',
    )[0]!;
    expect(mediaRead.crossServiceReads).toEqual([
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: parseResourcePattern('firestore', 'orgs/{orgId}'),
        field: 'members',
        expectedAuth: 'uid-list',
      },
    ]);

    const exportRead = surface.matching(
      parseResourcePattern('storage', 'reports/q4.csv', 'exports-prod'),
      'getDownloadURL',
    )[0]!;
    expect(exportRead.crossServiceReads).toEqual([]);
  });

  test('captures expectedAuth hints for == request.auth.uid, in .data.members, and in scalar list literals', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /orgs/{orgId}/docs/{docId} {',
      '      allow write: if firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.ownerId == request.auth.uid',
      '        && request.auth.uid in firestore.get(/databases/(default)/documents/orgs/$(orgId)/roster/active).data.uids',
      "        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role in ['editor', 'owner'];",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({ storage: rules });
    expect(surface.entries[0]!.crossServiceReads).toEqual([
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: parseResourcePattern('firestore', 'orgs/{orgId}'),
        field: 'ownerId',
        expectedAuth: 'uid',
      },
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: parseResourcePattern('firestore', 'orgs/{orgId}/roster/active'),
        field: 'uids',
        expectedAuth: 'uid-list',
      },
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: parseResourcePattern('firestore', 'orgs/{orgId}/members/{auth.uid}'),
        field: 'role',
        expectedValue: 'editor',
      },
    ]);
  });

  test('synthesizes satisfying expectedValue and uid-not-in-list hints for negated and boolean-false firestore.get() checks', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /orgs/{orgId}/files/{fileId} {',
      '      allow write: if firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.status != \'revoked\'',
      '        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.disabled == false',
      '        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.locked != true',
      '        && !firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.suspended',
      '        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.quota != 0',
      '        && !(request.auth.uid in firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.bannedUids);',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({ storage: rules });
    const memberPattern = parseResourcePattern('firestore', 'orgs/{orgId}/members/{auth.uid}');
    const orgPattern = parseResourcePattern('firestore', 'orgs/{orgId}');
    expect(surface.entries[0]!.crossServiceReads).toEqual([
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: memberPattern,
        field: 'status',
        expectedValue: 'active',
      },
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: memberPattern,
        field: 'disabled',
        expectedValue: false,
      },
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: memberPattern,
        field: 'locked',
        expectedValue: false,
      },
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: memberPattern,
        field: 'suspended',
        expectedValue: false,
      },
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: memberPattern,
        field: 'quota',
        expectedValue: 1,
      },
      {
        targetService: 'firestore',
        kind: 'get',
        pattern: orgPattern,
        field: 'bannedUids',
        expectedAuth: 'uid-not-in-list',
      },
    ]);
  });
});
