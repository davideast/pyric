import { describe, expect, test } from 'bun:test';
import { parseResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';
import { projectRuleSurface } from '../../../src/assurance-surface/usage.js';

describe('projectRuleSurface (Firestore, RTDB & Storage)', () => {
  test('projects Firestore ownerConditions, valueHints, multi-DB resourceIds, and overbroadAuthOnlyWrite', () => {
    const defaultRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  function signedIn() { return request.auth != null; }',
      '  match /databases/{database}/documents {',
      '    match /users/{uid} {',
      "      allow read: if signedIn();",
      "      allow write: if signedIn() && request.auth.uid == uid && request.resource.data.status == 'active';",
      '    }',
      '    match /items/{itemId} {',
      '      allow create, update: if signedIn();',
      '      allow delete: if signedIn() && resource.data.ownerId == request.auth.uid;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const analyticsRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{itemId} {',
      "      allow read: if request.auth != null && request.auth.token.role == 'analyst';",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({
      firestore: [
        { source: 'firestore.rules', text: defaultRules },
        { source: 'analytics.rules', text: analyticsRules, databaseId: 'analytics' },
      ],
    });

    const userWrites = surface.matching(
      parseResourcePattern('firestore', 'users/alice'),
      'setDoc',
    );
    expect(userWrites).toHaveLength(1);
    expect(userWrites[0]!.pattern).toEqual(parseResourcePattern('firestore', 'users/{uid}'));
    expect(userWrites[0]!.ops).toEqual(['create', 'update', 'delete']);
    expect(userWrites[0]!.overbroadAuthOnlyWrite).toBe(false);
    expect(userWrites[0]!.ownerConditions).toHaveLength(1);
    expect(userWrites[0]!.ownerConditions[0]).toMatchObject({
      service: 'firestore',
      kind: 'pathVar',
      field: '{uid}',
      varIndex: 1,
      required: true,
    });
    expect(userWrites[0]!.valueHints).toEqual([
      { service: 'firestore', path: 'users/{uid}', field: 'status', value: 'active' },
    ]);
    expect(userWrites[0]!.crossServiceReads).toEqual([]);
    expect(userWrites[0]!.source).toBe('firestore.rules:7');

    const itemCreates = surface.matching(
      parseResourcePattern('firestore', 'items/{id}'),
      'addDoc',
    );
    expect(itemCreates).toHaveLength(1);
    expect(itemCreates[0]!.overbroadAuthOnlyWrite).toBe(true);

    const itemDeletes = surface.matching(
      parseResourcePattern('firestore', 'items/{id}'),
      'deleteDoc',
    );
    expect(itemDeletes).toHaveLength(1);
    expect(itemDeletes[0]!.overbroadAuthOnlyWrite).toBe(false);
    expect(itemDeletes[0]!.ownerConditions[0]).toMatchObject({
      kind: 'storedField',
      field: 'ownerId',
    });

    // Multi-DB isolation: analytics queries never match (default) rules and vice versa.
    const analyticsReads = surface.matching(
      parseResourcePattern('firestore', 'items/{id}', 'analytics'),
      'query',
    );
    expect(analyticsReads).toHaveLength(1);
    expect(analyticsReads[0]!.pattern.resourceId).toBe('analytics');
    expect(analyticsReads[0]!.source).toBe('analytics.rules:5');
  });

  test('projects RTDB ownerConditions, valueHints, declaredIndexes, cascade semantics, and overbroadAuthOnlyWrite', () => {
    const rtdbRules = {
      rules: {
        orgs: {
          $orgId: {
            '.read': 'auth != null',
            members: {
              $uid: {
                '.write': 'auth != null && $uid === auth.uid',
                '.validate': "newData.child('role').val() === 'member'",
              },
            },
            items: {
              '.indexOn': ['createdAt', 'ownerId'],
              $itemId: {
                '.write': 'auth != null',
              },
            },
          },
        },
        leaderboard: {
          '.read': 'true',
          '.indexOn': '.value',
        },
      },
    };

    const secondaryRtdb = `{
      // JSON with comments supported
      "rules": {
        "orgs": {
          "$orgId": {
            ".write": "auth.uid != null && auth.token.admin === true"
          }
        }
      }
    }`;

    const surface = projectRuleSurface({
      rtdb: [
        { source: 'database.rules.json', json: rtdbRules },
        { source: 'secondary.rules.json', json: secondaryRtdb, instance: 'secondary-rtdb' },
      ],
    });

    // Parent .read on orgs/$orgId cascades down to orgs/$orgId/items
    const itemReads = surface.matching(
      parseResourcePattern('rtdb', 'orgs/$orgId/items'),
      'get',
    );
    expect(itemReads).toHaveLength(1);
    expect(itemReads[0]!.pattern).toEqual(parseResourcePattern('rtdb', 'orgs/$orgId'));
    expect(itemReads[0]!.ops).toEqual(['read']);

    // Unfiltered matching on orgs/$orgId/items surfaces both cascading .read and local .indexOn
    const itemAll = surface.matching(parseResourcePattern('rtdb', 'orgs/$orgId/items'));
    const indexEntry = itemAll.find((e) => e.declaredIndexes !== undefined);
    expect(indexEntry?.declaredIndexes).toEqual(['createdAt', 'ownerId']);

    // Single-string .indexOn: ".value" normalizes to ['.value'] on the leaderboard .read entry
    const leaderboardReads = surface.matching(
      parseResourcePattern('rtdb', 'leaderboard'),
      'read',
    );
    expect(leaderboardReads).toHaveLength(1);
    expect(leaderboardReads[0]!.declaredIndexes).toEqual(['.value']);

    // Narrowed $uid === auth.uid write is not overbroad and carries sibling .validate valueHints
    const memberWrites = surface.matching(
      parseResourcePattern('rtdb', 'orgs/$orgId/members/$uid'),
      'set',
    );
    expect(memberWrites).toHaveLength(1);
    expect(memberWrites[0]!.overbroadAuthOnlyWrite).toBe(false);
    expect(memberWrites[0]!.ownerConditions[0]).toMatchObject({
      service: 'rtdb',
      kind: 'pathVar',
      field: '$uid',
    });
    expect(memberWrites[0]!.valueHints).toEqual([
      { service: 'rtdb', path: 'orgs/$orgId/members/$uid', field: 'role', value: 'member' },
    ]);

    // Unscoped auth != null write on orgs/$orgId/items/$itemId is flagged overbroadAuthOnlyWrite
    const itemWrites = surface.matching(
      parseResourcePattern('rtdb', 'orgs/$orgId/items/$itemId'),
      'push',
    );
    expect(itemWrites).toHaveLength(1);
    expect(itemWrites[0]!.overbroadAuthOnlyWrite).toBe(true);

    // Custom-claim write on secondary-rtdb is NOT overbroad and stays isolated by instance
    const secondaryWrites = surface.matching(
      parseResourcePattern('rtdb', 'orgs/$orgId', 'secondary-rtdb'),
      'update',
    );
    expect(secondaryWrites).toHaveLength(1);
    expect(secondaryWrites[0]!.overbroadAuthOnlyWrite).toBe(false);
  });

  test('projects Cloud Storage rules across default and explicit buckets with overbroadAuthOnlyWrite and op matching', () => {
    const defaultStorageRules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /files/{uid}/{allPaths=**} {',
      '      allow read: if request.auth != null;',
      "      allow create: if request.auth.uid == uid && request.resource.contentType.matches('image/.*') && request.resource.size < 2048;",
      '      allow update, delete: if resource.metadata.owner == request.auth.uid;',
      '    }',
      '    match /shared/{allPaths=**} {',
      '      allow write: if request.auth != null;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const tenantStorageRules = [
      "rules_version = '2';",
      'service cloud.storage {',
      '  match /b/{bucket}/o {',
      '    match /orgs/{orgId}/{allPaths=**} {',
      '      allow write: if firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({
      storage: [
        { source: 'storage.rules', text: defaultStorageRules },
        { source: 'tenant.storage.rules', text: tenantStorageRules, bucket: 'tenant-assets' },
      ],
    });

    const uploadMatches = surface.matching(
      parseResourcePattern('storage', 'files/alice/photo.png'),
      'uploadBytes',
    );
    expect(uploadMatches).toHaveLength(1);
    expect(uploadMatches[0]!.overbroadAuthOnlyWrite).toBe(false);
    expect(uploadMatches[0]!.storageMetadata).toEqual({
      contentTypePattern: 'image/.*',
      maxSizeBytes: 2047,
    });
    expect(uploadMatches[0]!.ownerConditions[0]).toMatchObject({
      service: 'storage',
      kind: 'pathVar',
      field: '{uid}',
      varIndex: 1,
    });

    const metadataUpdates = surface.matching(
      parseResourcePattern('storage', 'files/alice/photo.png'),
      'updateMetadata',
    );
    expect(metadataUpdates).toHaveLength(1);
    expect(metadataUpdates[0]!.storageMetadata).toEqual({
      ownerMetadataKey: 'owner',
    });

    const sharedDeletes = surface.matching(
      parseResourcePattern('storage', 'shared/readme.txt'),
      'deleteObject',
    );
    expect(sharedDeletes).toHaveLength(1);
    expect(sharedDeletes[0]!.overbroadAuthOnlyWrite).toBe(true);

    const tenantWrites = surface.matching(
      parseResourcePattern('storage', 'orgs/acme/report.pdf', 'tenant-assets'),
      'uploadBytesResumable',
    );
    expect(tenantWrites).toHaveLength(1);
    expect(tenantWrites[0]!.pattern.resourceId).toBe('tenant-assets');
    expect(tenantWrites[0]!.overbroadAuthOnlyWrite).toBe(false);
    expect(tenantWrites[0]!.crossServiceReads).toEqual([
      {
        targetService: 'firestore',
        kind: 'exists',
        pattern: parseResourcePattern('firestore', 'orgs/{orgId}/members/{auth.uid}'),
      },
    ]);

    // Default bucket does not match tenant-assets rules.
    expect(
      surface.matching(parseResourcePattern('storage', 'orgs/acme/report.pdf'), 'uploadBytes'),
    ).toEqual([]);

    // Explicit bucket rules on tenant-assets keep default wildcardBucket rules strictly isolated.
    expect(
      surface.matching(
        parseResourcePattern('storage', 'files/alice/photo.png', 'tenant-assets'),
        'uploadBytes',
      ),
    ).toEqual([]);
  });

  test('matches unscoped wildcard /b/{bucket}/o Storage rules against named client buckets unless explicit bucket rules exist', () => {
    const unscopedRules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /files/{uid}/{fileId} {',
      "      allow create: if request.auth.uid == uid && request.resource.metadata.tier == 'pro';",
      '    }',
      '  }',
      '  match /b/media-prod/o {',
      '    match /avatars/{uid}/avatar.png {',
      '      allow write: if request.auth.uid == uid;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const surface = projectRuleSurface({ storage: unscopedRules });

    // Named client bucket without explicit rules matches unscoped wildcard /b/{bucket}/o rules.
    const appBucketMatches = surface.matching(
      parseResourcePattern('storage', 'files/alice/doc.pdf', 'my-app.firebasestorage.app'),
      'uploadBytes',
    );
    expect(appBucketMatches).toHaveLength(1);
    expect(appBucketMatches[0]!.wildcardBucket).toBe(true);
    expect(appBucketMatches[0]!.ownerConditions[0]?.wildcardBucket).toBe(true);
    expect(appBucketMatches[0]!.valueHints[0]?.wildcardBucket).toBe(true);

    // Concrete /b/media-prod/o rules are explicitly scoped, so wildcard /b/{bucket}/o rules do not bleed into media-prod.
    expect(
      surface.matching(
        parseResourcePattern('storage', 'files/alice/doc.pdf', 'media-prod'),
        'uploadBytes',
      ),
    ).toEqual([]);
    const mediaMatches = surface.matching(
      parseResourcePattern('storage', 'avatars/alice/avatar.png', 'media-prod'),
      'uploadBytes',
    );
    expect(mediaMatches).toHaveLength(1);
    expect(mediaMatches[0]!.wildcardBucket).toBeUndefined();
  });

  test('marks unconditionally false rules with alwaysDeny across Firestore, RTDB, and Storage', () => {
    const surface = projectRuleSurface({
      firestore: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            function denyAll() { return false; }
            match /items/{id} {
              allow read: if true;
              allow write: if denyAll();
            }
            match /{document=**} {
              allow read, write: if false;
            }
          }
        }
      `,
      rtdb: {
        rules: {
          '.read': false,
          '.write': 'false',
          items: {
            $id: {
              '.read': 'auth != null',
            },
          },
        },
      },
      storage: `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /{allPaths=**} {
              allow read, write: if !true;
            }
          }
        }
      `,
    });

    const fsRead = surface.matching(parseResourcePattern('firestore', 'items/1'), 'getDoc');
    expect(fsRead.map((e) => ({ source: e.source, alwaysDeny: e.alwaysDeny }))).toEqual([
      { source: 'firestore.rules:7', alwaysDeny: undefined },
      { source: 'firestore.rules:11', alwaysDeny: true },
    ]);

    const fsWrite = surface.matching(parseResourcePattern('firestore', 'items/1'), 'setDoc');
    expect(fsWrite.every((e) => e.alwaysDeny === true)).toBe(true);

    const rtdbRoot = surface.entries.filter(
      (e) => e.pattern.service === 'rtdb' && e.pattern.segments.length === 0,
    );
    expect(rtdbRoot.map((e) => ({ ops: e.ops, alwaysDeny: e.alwaysDeny }))).toEqual([
      { ops: ['read'], alwaysDeny: true },
      { ops: ['write'], alwaysDeny: true },
    ]);

    const rtdbItemRead = surface.entries.find(
      (e) => e.pattern.service === 'rtdb' && e.pattern.segments.length === 2,
    );
    expect(rtdbItemRead?.alwaysDeny).toBeUndefined();

    const stEntry = surface.entries.find((e) => e.pattern.service === 'storage');
    expect(stEntry?.alwaysDeny).toBe(true);
  });
});
