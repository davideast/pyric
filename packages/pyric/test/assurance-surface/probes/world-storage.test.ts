import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';
import { ProbeWorld } from '../../../src/assurance-surface/probes/world.js';
import { normalizeStorageBucketKey } from '../../../src/assurance-surface/probes/world-storage.js';

const ACTORS: ProbeActor[] = [
  { role: 'owner', uid: 'u-alice', email: 'alice@probe.local', displayName: 'Alice', token: {} },
  { role: 'peer', uid: 'u-bob', email: 'bob@probe.local', displayName: 'Bob', token: {} },
];

const STORAGE_FULL_VERBS_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{fileId} {
      allow get: if request.auth != null && request.auth.uid == uid;
      allow list: if request.auth != null && request.auth.uid == uid;
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.size < 1024
        && request.resource.contentType.matches('image/.*')
        && request.resource.metadata.ownerId == request.auth.uid;
      allow update: if request.auth != null
        && request.auth.uid == uid
        && resource.size < 1024
        && resource.contentType.matches('image/.*')
        && request.resource.metadata.ownerId == resource.metadata.ownerId;
      allow delete: if request.auth != null
        && request.auth.uid == uid
        && resource.metadata.ownerId == request.auth.uid;
    }
    match /folders/{uid} {
      allow list: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

describe('world-storage', () => {
  test('normalizes default and gs:// bucket identifiers consistently', () => {
    expect(normalizeStorageBucketKey(undefined)).toBeUndefined();
    expect(normalizeStorageBucketKey('')).toBeUndefined();
    expect(normalizeStorageBucketKey('(default)')).toBeUndefined();
    expect(normalizeStorageBucketKey('pyric-default')).toBeUndefined();
    expect(normalizeStorageBucketKey('media-bucket')).toBe('media-bucket');
    expect(normalizeStorageBucketKey('gs://media-bucket')).toBe('media-bucket');
    expect(normalizeStorageBucketKey('gs://media-bucket/')).toBe('media-bucket');
  });

  test('executes uploadBytes (with sizeBytes), getBytes/getDownloadURL, listAll, updateMetadata, and deleteObject', async () => {
    const world = new ProbeWorld({ storage: STORAGE_FULL_VERBS_RULES }, ACTORS);
    try {
      const oversizeUpload = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'create',
        path: 'files/u-alice/avatar.png',
        sizeBytes: 2048,
        contentType: 'image/png',
        customMetadata: { ownerId: 'u-alice', tag: 'initial' },
      });
      expect(oversizeUpload.decision).toBe('deny');

      const validUpload = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'create',
        path: 'files/u-alice/avatar.png',
        sizeBytes: 128,
        contentType: 'image/png',
        customMetadata: { ownerId: 'u-alice', tag: 'initial' },
      });
      expect(validUpload.decision).toBe('allow');

      const ownerGet = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'get',
        path: 'files/u-alice/avatar.png',
      });
      const peerGet = await world.run({
        actor: 'peer',
        service: 'storage',
        method: 'get',
        path: 'files/u-alice/avatar.png',
      });
      expect(ownerGet.decision).toBe('allow');
      expect(peerGet.decision).toBe('deny');

      const seedFolderItem = await world.run({
        actor: 'admin',
        service: 'storage',
        method: 'set',
        path: 'folders/u-alice/item-1.png',
        data: 'bytes',
        contentType: 'image/png',
      });
      expect(seedFolderItem.decision).toBe('allow');

      const ownerList = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'list',
        path: 'folders/u-alice',
      });
      const peerList = await world.run({
        actor: 'peer',
        service: 'storage',
        method: 'list',
        path: 'folders/u-alice',
      });
      expect(ownerList.decision).toBe('allow');
      expect(peerList.decision).toBe('deny');

      // Merge metadata update keeps existing ownerId and preserves image/png + 128-byte size.
      const ownerMergeUpdate = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'update',
        path: 'files/u-alice/avatar.png',
        merge: true,
        customMetadata: { tag: 'updated' },
      });
      expect(ownerMergeUpdate.decision).toBe('allow');

      // Replacing customMetadata with forged ownerId is denied by request.resource.metadata.ownerId == resource.metadata.ownerId.
      const ownerSpoofUpdate = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'update',
        path: 'files/u-alice/avatar.png',
        customMetadata: { ownerId: 'u-bob', tag: 'spoofed' },
      });
      expect(ownerSpoofUpdate.decision).toBe('deny');

      const peerDelete = await world.run({
        actor: 'peer',
        service: 'storage',
        method: 'delete',
        path: 'files/u-alice/avatar.png',
      });
      const ownerDelete = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'delete',
        path: 'files/u-alice/avatar.png',
      });
      expect(peerDelete.decision).toBe('deny');
      expect(ownerDelete.decision).toBe('allow');
    } finally {
      world.dispose();
    }
  });

  test('isolates non-default Storage buckets via resourceId and per-bucket WorldRules.storage', async () => {
    const defaultRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{uid}/{name} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;
    const mediaRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /clips/{uid}/{name} {
      allow read: if request.auth != null
        && request.auth.uid == uid
        && bucket == 'media-bucket'
        && resource.contentType.matches('video/.*');
      allow write: if request.auth != null
        && request.auth.uid == uid
        && bucket == 'media-bucket'
        && (request.resource == null || request.resource.contentType.matches('video/.*'));
    }
  }
}`;
    const world = new ProbeWorld(
      {
        storage: {
          '(default)': defaultRules,
          'gs://media-bucket': mediaRules,
        },
      },
      ACTORS,
    );
    try {
      const uploadMedia = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'create',
        resourceId: 'media-bucket',
        path: 'clips/u-alice/intro.mp4',
        data: 'video-data',
        contentType: 'video/mp4',
      });
      expect(uploadMedia.decision).toBe('allow');

      // Reading via gs://media-bucket hits the same scoped bucket store.
      const readMediaViaGsUrl = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'get',
        resourceId: 'gs://media-bucket',
        path: 'clips/u-alice/intro.mp4',
      });
      expect(readMediaViaGsUrl.decision).toBe('allow');

      // Default bucket does not match /clips and does not hold media-bucket's object.
      const readOnDefault = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'get',
        path: 'clips/u-alice/intro.mp4',
      });
      expect(readOnDefault.decision).toBe('deny');

      // Undeployed third bucket fails closed when per-bucket rules are deployed.
      const uploadUndeployed = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'create',
        resourceId: 'archive-bucket',
        path: 'clips/u-alice/intro.mp4',
        data: 'video-data',
        contentType: 'video/mp4',
      });
      expect(uploadUndeployed.decision).toBe('deny');
    } finally {
      world.dispose();
    }
  });

  test('evaluates cross-service firestore.get() and firestore.exists() inside Storage rules against ProbeWorld Firestore state', async () => {
    const crossServiceStorageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/assets/{fileName} {
      allow read: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow write: if request.auth != null
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor';
    }
  }
}`;
    const world = new ProbeWorld({ storage: crossServiceStorageRules }, ACTORS);
    try {
      const seedEditor = await world.run({
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/acme/members/u-alice',
        data: { role: 'editor' },
      });
      expect(seedEditor.decision).toBe('allow');

      const aliceUpload = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'create',
        path: 'orgs/acme/assets/deck.pdf',
        data: 'pdf-bytes',
        contentType: 'application/pdf',
      });
      const bobUpload = await world.run({
        actor: 'peer',
        service: 'storage',
        method: 'create',
        path: 'orgs/acme/assets/deck.pdf',
        data: 'forged-bytes',
        contentType: 'application/pdf',
      });
      const aliceRead = await world.run({
        actor: 'owner',
        service: 'storage',
        method: 'get',
        path: 'orgs/acme/assets/deck.pdf',
      });
      const bobRead = await world.run({
        actor: 'peer',
        service: 'storage',
        method: 'get',
        path: 'orgs/acme/assets/deck.pdf',
      });

      expect(aliceUpload.decision).toBe('allow');
      expect(bobUpload.decision).toBe('deny');
      expect(aliceRead.decision).toBe('allow');
      expect(bobRead.decision).toBe('deny');
    } finally {
      world.dispose();
    }
  });
});
