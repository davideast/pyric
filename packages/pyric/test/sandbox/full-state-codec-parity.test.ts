/**
 * Cross-codec parity, dirty-target wipe, and bidirectional non-aliasing tests
 * across `FullSandboxState` and `SandboxSnapshot`.
 */
import { describe, expect, it } from 'bun:test';

import { getAuth } from '../../src/auth/instances.js';
import { signInWithEmailAndPassword } from '../../src/auth/index.js';
import { sandbox as authDriver } from '../../src/auth/sandbox/driver.js';
import { getOrCreateBackend } from '../../src/database/sandbox/backend-for.js';
import { getClock } from '../../src/sandbox/clock.js';
import { applyFullState, captureFullState } from '../../src/sandbox/full-state.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';
import { getBytes, ref as storageRef, uploadBytes } from '../../src/storage/index.js';
import { getAdminStorageSandbox } from '../../src/storage/internal.js';
import { authAccountsFor } from 'pyric/sandbox/internal';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const DATABASE_RULES = { rules: { '.read': true, '.write': true } };

let nextStorageDb = 1;

describe('2-codec parity, dirty-target wipe, and bidirectional non-aliasing', () => {
  const CUSTOM_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /items/{id} { allow read: if true; allow write: if request.auth != null; }
  }
}`;

  const CUSTOM_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read: if true; allow write: if request.auth != null; }
  }
}`;

  const CUSTOM_BUCKET_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /assets/{file} { allow read: if true; }
  }
}`;

  const DEFAULT_RTDB_RULES = {
    rules: {
      tree: { '.read': true, '.write': 'auth != null' },
    },
  };

  const SECONDARY_RTDB_RULES = {
    rules: {
      shards: { '.read': 'auth != null', '.write': 'auth != null' },
    },
  };

  async function populatedAllCapabilities() {
    const {
      Bytes: RulesBytes,
      LatLng: RulesLatLng,
      Reference: RulesReference,
      Timestamp: RulesTimestamp,
      Vector: RulesVector,
    } = await import('../../src/rules/internal/index.js');
    const { databaseInstanceNamed } = await import('../../src/sandbox/internal/instances.js');
    const { getDatabase, goOnline, onDisconnect, ref: dbRef } = await import('../../src/database/index.js');
    const {
      deployStorageBucketRules,
      getStorageSandbox,
    } = await import('../../src/storage/internal.js').then(async (internal) => {
      const pub = await import('../../src/storage/index.js');
      return { ...internal, getStorageSandbox: pub.getStorageSandbox };
    });

    const sandbox = initializeSandbox();
    getClock(sandbox).set(1_730_000_000_000);

    getStorageSandbox(sandbox, {
      dbName: `pyric-all-cap:${nextStorageDb++}`,
      rules: CUSTOM_STORAGE_RULES,
      crossServiceIam: 'denied',
    });
    deployStorageBucketRules(sandbox, 'assets-bucket', CUSTOM_BUCKET_RULES);

    const env = getInternalEnv(sandbox);
    env.deployRules(CUSTOM_FIRESTORE_RULES);
    env.adminSetDocument('items/wrappers', {
      ts: new RulesTimestamp(1_730_000_000, 123_000_000),
      rawBytes: new RulesBytes(new Uint8Array([9, 8, 7])),
      coords: new RulesLatLng(37.7749, -122.4194),
      pointer: new RulesReference('items/envelope'),
      namedPointer: new RulesReference('orgs/o1', 'tenant-db'),
      embedding: new RulesVector([0.25, -0.5, 1.0]),
      nestedEnvelope: { type: 'pyric/map/1.0', fields: { nestedKey: 'val' } },
      nested: { tags: ['alpha', 'beta'], meta: { count: 2 } },
    });
    env.adminSetDocument('items/envelope', {
      type: 'pyric/map/1.0',
      fields: { a: 1 },
      sibling: 'kept',
    });
    env.adminSetDocument('items/exact-envelope', {
      type: 'pyric/map/1.0',
      fields: { a: 1 },
    });

    const defaultRtdb = getOrCreateBackend(sandbox);
    defaultRtdb.setRules(DEFAULT_RTDB_RULES);
    defaultRtdb.adminSetWithPriority('tree/group', { leaf: { label: 'one' } }, 100);
    defaultRtdb.adminSetPriority('tree/group/leaf', 'leaf-prio');

    const secondaryRtdb = getOrCreateBackend(sandbox, databaseInstanceNamed('secondary-shard'));
    secondaryRtdb.setRules(SECONDARY_RTDB_RULES);
    secondaryRtdb.adminSetWithPriority('shards/s1', { active: true, list: ['x'] }, 7);

    const auth = getAuth(sandbox);
    authDriver.restoreProviderConfig(auth, {
      password: true,
      anonymous: true,
      'google.com': true,
      'oidc.corp': false,
    });
    authDriver.seedUsers(auth, [
      {
        uid: 'pw-user',
        email: 'pw@example.com',
        password: 'pw-secret',
        emailVerified: true,
        displayName: 'Password User',
        customClaims: { roles: ['editor'], flags: { beta: true } },
      },
      {
        uid: 'oauth-user',
        email: 'oauth@example.com',
        providerId: 'google.com',
        providerUserInfo: [{ providerId: 'google.com', rawId: 'g-123', email: 'oauth@example.com' }],
      },
      {
        uid: 'anon-user',
        providerId: 'anonymous',
      },
      {
        uid: 'claims-no-email',
        phoneNumber: '+15555550199',
        providerId: 'phone',
        providerUserInfo: [{ providerId: 'phone', rawId: '+15555550199', phoneNumber: '+15555550199' }],
        customClaims: { scopes: ['read:items'] },
      },
      {
        uid: 'disabled-user',
        email: 'disabled@example.com',
        password: 'disabled-secret',
        disabled: true,
      },
    ]);
    await signInWithEmailAndPassword(auth, 'pw@example.com', 'pw-secret');

    const clientDb = getDatabase(sandbox);
    goOnline(clientDb);
    await onDisconnect(dbRef(clientDb, 'tree/disconnected')).set('armed-on-source');

    getClock(sandbox).advance(2000);
    authAccountsFor(sandbox)?.revokeRefreshTokens('pw-user');

    const defaultStorage = getAdminStorageSandbox(sandbox);
    await uploadBytes(storageRef(defaultStorage, 'docs/spec.bin'), new Uint8Array([10, 20, 30]), {
      contentType: 'application/octet-stream',
      customMetadata: { team: 'core', stage: 'v1' },
    });
    const customBucketStorage = getAdminStorageSandbox(sandbox, { bucket: 'assets-bucket' });
    await uploadBytes(storageRef(customBucketStorage, 'assets/logo.svg'), new Uint8Array([60, 115, 118, 103, 62]), {
      contentType: 'image/svg+xml',
      customMetadata: { variant: 'dark' },
    });

    return sandbox;
  }

  async function populatedDirtyTarget() {
    const { databaseInstanceNamed } = await import('../../src/sandbox/internal/instances.js');
    const { getDatabase, goOnline, onDisconnect, ref: dbRef } = await import('../../src/database/index.js');
    const { deployStorageBucketRules } = await import('../../src/storage/internal.js');
    const { getStorageSandbox } = await import('../../src/storage/index.js');

    const dirty = initializeSandbox();
    getClock(dirty).set(1_600_000_000_000);
    getStorageSandbox(dirty, {
      dbName: `pyric-dirty-cap:${nextStorageDb++}`,
      rules: FIRESTORE_RULES.replace('cloud.firestore', 'firebase.storage').replace(
        '/databases/{db}/documents',
        '/b/{bucket}/o',
      ),
      crossServiceIam: 'granted',
    });
    deployStorageBucketRules(dirty, 'dirty-bucket', CUSTOM_BUCKET_RULES);

    const env = getInternalEnv(dirty);
    env.deployRules(FIRESTORE_RULES);
    env.adminSetDocument('stale/doc', { polluted: true });

    const defaultRtdb = getOrCreateBackend(dirty);
    defaultRtdb.setRules(DATABASE_RULES);
    defaultRtdb.adminSet('stale/node', { bad: 1 });
    const dirtyClientDb = getDatabase(dirty);
    goOnline(dirtyClientDb);
    await onDisconnect(dbRef(dirtyClientDb, 'stale/disconnect')).set('should-never-fire');

    const dirtyShard = getOrCreateBackend(dirty, databaseInstanceNamed('dirty-shard'));
    dirtyShard.setRules(DATABASE_RULES);
    dirtyShard.adminSet('leftover/item', 'polluted');
    const dirtyShardClient = getDatabase(dirty, 'https://dirty-shard.firebaseio.com/');
    goOnline(dirtyShardClient);
    await onDisconnect(dbRef(dirtyShardClient, 'leftover/disconnect')).set('should-never-fire');

    const auth = getAuth(dirty);
    authDriver.restoreProviderConfig(auth, { password: true, 'github.com': true });
    authDriver.seedUsers(auth, [{ uid: 'dirty-user', email: 'dirty@example.com', password: 'pw' }]);
    authAccountsFor(dirty)?.revokeRefreshTokens('dirty-user');

    await uploadBytes(storageRef(getAdminStorageSandbox(dirty), 'stale/file.txt'), new Uint8Array([99]));
    await uploadBytes(
      storageRef(getAdminStorageSandbox(dirty, { bucket: 'dirty-bucket' }), 'stale/bucket-file.txt'),
      new Uint8Array([88]),
    );

    return dirty;
  }

  async function readSharedCapabilities(sandbox: ReturnType<typeof initializeSandbox>) {
    const { encodeStateDocument } = await import('../../src/sandbox/internal/state-values.js');
    const { databaseInstanceNamed } = await import('../../src/sandbox/internal/instances.js');
    const {
      getStorageCrossServiceIam,
      getStorageRulesResolution,
      getStorageService,
      storageBucketsWithRules,
    } = await import('../../src/storage/internal.js');

    const rawDocs = getInternalEnv(sandbox).snapshot();
    const firestoreDocs = Object.fromEntries(
      Object.entries(rawDocs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, docData]) => [path, encodeStateDocument(docData)]),
    );

    const defaultRtdb = getOrCreateBackend(sandbox);
    const secondaryRtdb = getOrCreateBackend(sandbox, databaseInstanceNamed('secondary-shard'));
    const dirtyRtdb = getOrCreateBackend(sandbox, databaseInstanceNamed('dirty-shard'));

    const defaultStorage = getAdminStorageSandbox(sandbox);
    const defaultService = await getStorageService(defaultStorage);
    const defaultListed = await defaultService.backend.listByPrefix('');
    const defaultObjects = await Promise.all(
      defaultListed.map(async (entry) => ({
        path: entry.fullPath,
        bytes: Array.from(new Uint8Array(await getBytes(storageRef(defaultStorage, entry.fullPath)))),
        contentType: entry.contentType,
        customMetadata: entry.customMetadata,
        generation: entry.generation,
        md5Hash: entry.md5Hash,
      })),
    );

    const assetsStorage = getAdminStorageSandbox(sandbox, { bucket: 'assets-bucket' });
    const assetsListed = await (await getStorageService(assetsStorage)).backend.listByPrefix('');
    const assetsObjects = await Promise.all(
      assetsListed.map(async (entry) => ({
        path: entry.fullPath,
        bytes: Array.from(new Uint8Array(await getBytes(storageRef(assetsStorage, entry.fullPath)))),
        contentType: entry.contentType,
        customMetadata: entry.customMetadata,
        generation: entry.generation,
        md5Hash: entry.md5Hash,
      })),
    );

    const dirtyBucketStorage = getAdminStorageSandbox(sandbox, { bucket: 'dirty-bucket' });
    const dirtyBucketListed = await (await getStorageService(dirtyBucketStorage)).backend.listByPrefix('');

    const users = [...authDriver.exportUsers(getAuth(sandbox))].sort((a, b) => a.uid.localeCompare(b.uid));

    return structuredClone({
      firestoreDocs,
      firestoreRules: getInternalEnv(sandbox).getRules(),
      rtdbDefault: defaultRtdb.exportPersistenceState(),
      rtdbSecondary: secondaryRtdb.exportPersistenceState(),
      rtdbDirtyShard: dirtyRtdb.adminGet('/'),
      rtdbDirtyShardRules: dirtyRtdb.getActiveRules(),
      authUsers: users,
      authProviders: authDriver.exportProviderConfig(getAuth(sandbox)),
      storageDefaultObjects: defaultObjects,
      storageAssetsObjects: assetsObjects,
      storageDefaultRules: getStorageRulesResolution(defaultStorage)?.source ?? null,
      storageAssetsRules: getStorageRulesResolution(assetsStorage)?.source ?? null,
      storageBucketsWithRules: storageBucketsWithRules(sandbox),
      storageCrossServiceIam: getStorageCrossServiceIam(sandbox),
      dirtyBucketCount: dirtyBucketListed.length,
    });
  }

  it('produces identical capabilities across both codecs, wipes dirty targets, and prevents bidirectional aliasing', async () => {
    const {
      captureSandboxSnapshot,
      forkSandbox,
      restoreSandboxSnapshot,
    } = await import('../../src/sandbox/internal/snapshot-codec.js');
    const { diff, fork, promote } = await import('../../src/sandbox/branches/engine.js');
    const { getDatabase, goOffline } = await import('../../src/database/index.js');
    const { databaseInstanceNamed } = await import('../../src/sandbox/internal/instances.js');

    const source = await populatedAllCapabilities();
    const baselineShared = await readSharedCapabilities(source);
    const baselineClock = getClock(source).capture();
    const baselineHistory = structuredClone(authAccountsFor(source)?.history());

    const fullState = await captureFullState(source);
    const snapshot = await captureSandboxSnapshot(source);
    const forkedViaSnapshot = await forkSandbox(source);
    const branch = await fork(fullState);

    const sourceWrappers = getInternalEnv(source).getDocument('items/wrappers');
    if (sourceWrappers === undefined) throw new Error('Expected items/wrappers on source.');
    ((sourceWrappers.nested as Record<string, unknown>).tags as string[]).push('mutated-source');
    getOrCreateBackend(source).adminSet('tree/group/leaf/label', 'mutated-source');
    const sourcePwUser = authDriver.exportUsers(getAuth(source)).find((u) => u.uid === 'pw-user');
    if (sourcePwUser === undefined) throw new Error('Expected pw-user on source.');
    ((sourcePwUser.customClaims as Record<string, unknown>).roles as string[]).push('mutated-claim');

    const dirtyFullTarget = await populatedDirtyTarget();
    await applyFullState(dirtyFullTarget, fullState);

    const dirtySnapTarget = await populatedDirtyTarget();
    const { refusals } = await restoreSandboxSnapshot(dirtySnapTarget, snapshot, { merge: false });
    expect(refusals).toEqual([]);

    for (const restored of [dirtyFullTarget, dirtySnapTarget, forkedViaSnapshot.sandbox, branch.sandbox]) {
      goOffline(getDatabase(restored));
      goOffline(getDatabase(restored, 'https://dirty-shard.firebaseio.com/'));
      expect(getOrCreateBackend(restored).adminGet('stale/disconnect')).toBeNull();
      expect(getOrCreateBackend(restored).adminGet('tree/disconnected')).toBeNull();
      expect(getOrCreateBackend(restored, databaseInstanceNamed('dirty-shard')).adminGet('leftover/disconnect')).toBeNull();
    }

    expect(await readSharedCapabilities(dirtyFullTarget)).toEqual(baselineShared);
    expect(await readSharedCapabilities(dirtySnapTarget)).toEqual(baselineShared);
    expect(await readSharedCapabilities(forkedViaSnapshot.sandbox)).toEqual(baselineShared);
    expect(await readSharedCapabilities(branch.sandbox)).toEqual(baselineShared);
    expect(await diff(branch, dirtyFullTarget)).toEqual([]);

    expect(getClock(dirtyFullTarget).capture()).toEqual(baselineClock);
    expect(getClock(forkedViaSnapshot.sandbox).capture()).toEqual(baselineClock);
    expect(authAccountsFor(dirtyFullTarget)?.history()).toEqual(baselineHistory);

    const promoBase = await populatedDirtyTarget();
    await applyFullState(promoBase, await captureFullState(initializeSandbox()));
    const promoBranch = await fork(await captureFullState(promoBase));
    await applyFullState(promoBranch.sandbox, fullState);
    await promote(promoBranch, promoBase);
    const promotedCapabilities = await readSharedCapabilities(promoBase);
    expect(promotedCapabilities.firestoreDocs).toEqual(baselineShared.firestoreDocs);
    expect(promotedCapabilities.rtdbSecondary).toEqual(baselineShared.rtdbSecondary);
    expect(promotedCapabilities.authUsers).toEqual(baselineShared.authUsers);
    expect(promotedCapabilities.storageAssetsObjects).toEqual(baselineShared.storageAssetsObjects);
    expect(promotedCapabilities.storageBucketsWithRules).toEqual(['assets-bucket']);

    const sourceAfterSourceMutation = await readSharedCapabilities(source);
    const targetWrappers = getInternalEnv(dirtyFullTarget).getDocument('items/wrappers');
    if (targetWrappers === undefined) throw new Error('Expected items/wrappers on dirtyFullTarget.');
    ((targetWrappers.nested as Record<string, unknown>).tags as string[]).push('mutated-target');
    const targetSnapUser = authDriver.exportUsers(getAuth(dirtySnapTarget)).find((u) => u.uid === 'pw-user');
    if (targetSnapUser === undefined) throw new Error('Expected pw-user on dirtySnapTarget.');
    ((targetSnapUser.customClaims as Record<string, unknown>).roles as string[]).push('mutated-snap-target');

    expect(await readSharedCapabilities(source)).toEqual(sourceAfterSourceMutation);
    expect(await readSharedCapabilities(forkedViaSnapshot.sandbox)).toEqual(baselineShared);
    expect(await readSharedCapabilities(branch.sandbox)).toEqual(baselineShared);
  });
});
