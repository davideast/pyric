import { describe, expect, test } from 'bun:test';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/index.js';
import {
  extractSdkUsage,
  storageOwnerConditions,
} from '../../../src/assurance-surface/usage.js';

describe('storageOwnerConditions', () => {
  test('extracts path-owner and metadata-owner conditions across firebase.storage and cloud.storage', () => {
    const firebaseStorageRules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  function isSignedIn() {',
      '    return request.auth != null;',
      '  }',
      '  function isPathOwner(targetUid) {',
      '    let caller = request.auth.uid;',
      '    return isSignedIn() && caller == targetUid;',
      '  }',
      '  match /b/{bucket}/o {',
      '    match /files/{uid}/{allPaths=**} {',
      '      allow read: if isSignedIn();',
      '      allow write: if isPathOwner(uid);',
      '    }',
      '    match /items/{itemId} {',
      '      allow create: if isSignedIn() && request.resource.metadata.owner == request.auth.uid;',
      "      allow update, delete: if isSignedIn() && resource.metadata['owner'] == request.auth.uid;",
      '    }',
      '  }',
      '}',
    ].join('\n');

    const conditions = storageOwnerConditions(firebaseStorageRules, 'storage.rules');
    expect(conditions).toEqual([
      {
        service: 'storage',
        path: 'files/{uid}/{allPaths=**}',
        ops: ['create', 'update', 'delete'],
        kind: 'pathVar',
        field: '{uid}',
        varIndex: 1,
        relation: 'equals',
        required: true,
        source: 'storage.rules:13',
        expression: 'caller == targetUid',
        wildcardBucket: true,
      },
      {
        service: 'storage',
        path: 'items/{itemId}',
        ops: ['create'],
        kind: 'incomingField',
        field: 'owner',
        location: 'items/{itemId}#owner',
        relation: 'equals',
        required: true,
        source: 'storage.rules:16',
        expression: 'request.resource.metadata.owner == request.auth.uid',
        wildcardBucket: true,
      },
      {
        service: 'storage',
        path: 'items/{itemId}',
        ops: ['update', 'delete'],
        kind: 'storedField',
        field: 'owner',
        location: 'items/{itemId}#owner',
        relation: 'equals',
        required: true,
        source: 'storage.rules:17',
        expression: "resource.metadata['owner'] == request.auth.uid",
        wildcardBucket: true,
      },
    ]);

    const cloudStorageRules = [
      "rules_version = '2';",
      'service cloud.storage {',
      '  match /b/media-prod/o {',
      '    match /orgs/{orgId}/users/{uid}/avatar.png {',
      '      allow write: if uid == request.auth.uid;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(storageOwnerConditions(cloudStorageRules, 'cloud.rules')).toEqual([
      {
        service: 'storage',
        path: '/b/media-prod/o/orgs/{orgId}/users/{uid}/avatar.png',
        ops: ['create', 'update', 'delete'],
        kind: 'pathVar',
        field: '{uid}',
        varIndex: 3,
        relation: 'equals',
        required: true,
        source: 'cloud.rules:5',
        expression: 'uid == request.auth.uid',
      },
    ]);
  });

  test('guards against recursive helper cycles, shadowed parameters, and bucket-header wildcards', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  function loop(x) {',
      '    return loop(x);',
      '  }',
      '  function shadowed(request, resource, uid) {',
      '    return uid == request.auth.uid && resource.metadata.owner == request.auth.uid;',
      '  }',
      '  match /b/{bucket}/o {',
      '    match /files/{uid} {',
      "      allow write: if loop(uid) || shadowed({ auth: { uid: 'sys' } }, { metadata: { owner: 'sys' } }, 'other') || bucket == request.auth.uid;",
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(storageOwnerConditions(rules, 'storage.rules')).toEqual([]);
  });

  test('cross-checks storageOwnerConditions with extractSdkUsage sites for default and named buckets', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /files/{uid}/{allPaths=**} {',
      '      allow write: if request.auth.uid == uid;',
      '    }',
      '    match /items/{itemId} {',
      '      allow create: if request.resource.metadata.owner == request.auth.uid;',
      '    }',
      '  }',
      '  match /b/media-prod/o {',
      '    match /avatars/{uid}/avatar.png {',
      '      allow write: if request.auth.uid == uid;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const usage = extractSdkUsage({
      root: 'app',
      files: {
        'src/uploads.ts': [
          "import { getAuth } from 'firebase/auth';",
          "import { getStorage, ref, uploadBytes } from 'firebase/storage';",
          'export async function saveFiles(bytes: Uint8Array, itemId: string) {',
          '  const user = getAuth().currentUser!;',
          '  const defaultStorage = getStorage();',
          '  await uploadBytes(ref(defaultStorage, `files/${user.uid}/doc.pdf`), bytes);',
          '  await uploadBytes(ref(defaultStorage, `items/${itemId}`), bytes, {',
          '    customMetadata: { owner: user.uid },',
          '  });',
          "  const mediaStorage = getStorage(undefined, 'gs://media-prod');",
          '  await uploadBytes(ref(mediaStorage, `avatars/${user.uid}/avatar.png`), bytes);',
          '}',
        ].join('\n'),
      },
    });

    const conditions = storageOwnerConditions(rules, 'storage.rules');
    const bindings = inferOwnerBindings(conditions, [...usage.operations]);

    expect(
      bindings.map((b) => ({
        path: b.path,
        kind: b.kind,
        field: b.field,
        strength: b.strength,
        evidence: b.evidence,
      })),
    ).toEqual([
      {
        path: '/b/media-prod/o/avatars/{uid}/avatar.png',
        kind: 'pathVar',
        field: '{uid}',
        strength: 'strong',
        evidence: 'rules+code',
      },
      {
        path: 'files/{uid}/{allPaths=**}',
        kind: 'pathVar',
        field: '{uid}',
        strength: 'strong',
        evidence: 'rules+code',
      },
      {
        path: 'items/{itemId}',
        kind: 'incomingField',
        field: 'owner',
        strength: 'strong',
        evidence: 'rules+code',
      },
    ]);
  });

  test('matches unscoped wildcard /b/{bucket}/o conditions to named client buckets while preserving explicit bucket isolation', () => {
    const rules = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /files/{uid}/{fileId} {',
      '      allow write: if request.auth.uid == uid;',
      '    }',
      '    match /items/{itemId} {',
      '      allow create: if request.resource.metadata.owner == request.auth.uid;',
      '    }',
      '  }',
      '  match /b/media-prod/o {',
      '    match /avatars/{uid}/avatar.png {',
      '      allow write: if request.auth.uid == uid;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const usage = extractSdkUsage({
      root: 'app',
      files: {
        'src/uploads.ts': [
          "import { getAuth } from 'firebase/auth';",
          "import { getStorage, ref, uploadBytes } from 'firebase/storage';",
          'export async function saveNamedBucketFiles(bytes: Uint8Array, itemId: string) {',
          '  const user = getAuth().currentUser!;',
          "  const appStorage = getStorage(undefined, 'gs://my-app.firebasestorage.app');",
          '  await uploadBytes(ref(appStorage, `files/${user.uid}/doc.pdf`), bytes);',
          '  await uploadBytes(ref(appStorage, `items/${itemId}`), bytes, {',
          '    customMetadata: { owner: user.uid },',
          '  });',
          "  const mediaStorage = getStorage(undefined, 'gs://media-prod');",
          '  await uploadBytes(ref(mediaStorage, `files/${user.uid}/leak.pdf`), bytes);',
          '}',
        ].join('\n'),
      },
    });

    const conditions = storageOwnerConditions(rules, 'storage.rules');
    const bindings = inferOwnerBindings(conditions, [...usage.operations]);

    const fileBinding = bindings.find((b) => b.path === 'files/{uid}/{fileId}');
    expect(fileBinding).toMatchObject({
      strength: 'strong',
      evidence: 'rules+code',
      wildcardBucket: true,
    });
    const itemBinding = bindings.find((b) => b.path === 'items/{itemId}');
    expect(itemBinding).toMatchObject({
      strength: 'strong',
      evidence: 'rules+code',
      wildcardBucket: true,
    });
    // The write to media-prod/o/files/{uid}/leak.pdf stays code-only because media-prod has explicit concrete rules.
    const mediaLeakBinding = bindings.find(
      (b) => b.path === '/b/media-prod/o/files/{uid}/leak.pdf',
    );
    expect(mediaLeakBinding?.evidence).toBe('code-only');
  });
});
