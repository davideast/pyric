/**
 * Tests for `captureFullState` / `applyFullState`.
 *
 * The contract under test: a capture is a pure read, and applying a captured
 * state onto a fresh sandbox makes every read the capture covers identical.
 * "Every read" means Firestore documents, the Realtime Database tree, Storage
 * objects with their bytes and metadata, auth accounts, and the three rule
 * sources.
 */
import { describe, it, expect } from 'bun:test';

import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  applyFullState,
  captureFullState,
  type FullSandboxState,
} from '../../src/sandbox/full-state.js';
import { captureCheckpoint, restoreCheckpoint } from '../../src/sandbox/checkpoints/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';
import { getOrCreateBackend } from '../../src/database/sandbox/backend-for.js';
import { getAuth } from '../../src/auth/instances.js';
import { signInWithEmailAndPassword } from '../../src/auth/index.js';
import { authAccountsFor } from 'pyric/sandbox/internal';
import { getClock } from '../../src/sandbox/clock.js';
import { sandbox as authDriver } from '../../src/auth/sandbox/driver.js';
import { getAdminStorageSandbox } from '../../src/storage/internal.js';
import { getBytes, getMetadata, ref as storageRef, uploadBytes } from '../../src/storage/index.js';

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`;

const DATABASE_RULES = { rules: { '.read': true, '.write': true } };

let nextStorageDb = 1;

/**
 * A sandbox holding one value in every service this state covers.
 *
 * Storage durability is keyed by database name, so each sandbox pins one of
 * its own. Without that, two sandboxes in one run would share a bucket and a
 * case would read the objects a previous case uploaded.
 */
async function populated() {
  const sandbox = initializeSandbox();
  getAdminStorageSandbox(sandbox, { dbName: `pyric-full-state-test:${nextStorageDb++}` });
  getInternalEnv(sandbox).seed({
    rules: FIRESTORE_RULES,
    documents: { 'things/a': { v: 1 }, 'things/b': { nested: { n: 2 }, tags: ['x'] } },
  });

  const database = getOrCreateBackend(sandbox);
  database.setRules(DATABASE_RULES);
  database.adminSet('rooms/one', { title: 'first' });

  const auth = getAuth(sandbox);
  authDriver.seedUsers(auth, [
    {
      uid: 'alice',
      email: 'alice@example.com',
      password: 'secret-alice',
      displayName: 'Alice',
      customClaims: { admin: true },
      tenantId: 'tenant-a',
    },
  ]);

  const storage = getAdminStorageSandbox(sandbox);
  await uploadBytes(storageRef(storage, 'docs/hello.txt'), new Uint8Array([1, 2, 3, 250]), {
    contentType: 'text/plain',
    customMetadata: { owner: 'alice' },
  });

  return sandbox;
}

/** Every read the full state claims to cover, as one comparable value. */
async function readEverything(sandbox: ReturnType<typeof initializeSandbox>) {
  const storage = getAdminStorageSandbox(sandbox);
  const bytes = await getBytes(storageRef(storage, 'docs/hello.txt'));
  const metadata = await getMetadata(storageRef(storage, 'docs/hello.txt'));
  return {
    firestore: getInternalEnv(sandbox).snapshot(),
    firestoreRules: getInternalEnv(sandbox).getRules(),
    database: getOrCreateBackend(sandbox).adminGet('rooms/one'),
    databaseRules: getOrCreateBackend(sandbox).getActiveRules(),
    users: authDriver.exportUsers(getAuth(sandbox)),
    storageBytes: Array.from(new Uint8Array(bytes)),
    storageContentType: metadata.contentType,
    storageCustomMetadata: metadata.customMetadata,
  };
}

describe('full sandbox state', () => {
  it('captures every service the branch engine carries', async () => {
    const sandbox = await populated();
    const state: FullSandboxState = await captureFullState(sandbox);

    expect(state.firestore['things/a']).toEqual({ v: 1 });
    expect(state.database).not.toBeNull();
    expect(state.auth.users.map((u) => u.uid)).toEqual(['alice']);
    expect(state.auth.users[0]?.tenantId).toBe('tenant-a');
    expect(state.auth.users[0]?.password).toBe('secret-alice');
    expect(state.auth.users[0]?.customClaims).toEqual({ admin: true });
    expect(state.storage).toHaveLength(1);
    expect(state.storage[0]?.path).toBe('docs/hello.txt');
    expect(state.storage[0]?.contentType).toBe('text/plain');
    expect(state.storage[0]?.customMetadata).toEqual({ owner: 'alice' });
    expect(state.rules.firestore).toBe(FIRESTORE_RULES);
    expect(state.rules.database).toEqual(DATABASE_RULES);
  });

  it('captures the storage rules source when the sandbox has one', async () => {
    const sandbox = await populated();
    const { replaceStorageRules } = await import('../../src/storage/internal.js');
    await replaceStorageRules(sandbox, STORAGE_RULES);

    const state = await captureFullState(sandbox);
    expect(state.rules.storage).toBe(STORAGE_RULES);
  });

  it('capture is a pure read: the sandbox hashes the same before and after', async () => {
    const sandbox = await populated();
    const before = JSON.stringify(await readEverything(sandbox));
    await captureFullState(sandbox);
    const after = JSON.stringify(await readEverything(sandbox));
    expect(after).toBe(before);
  });

  it('applying a captured state onto a fresh sandbox reproduces every read', async () => {
    const source = await populated();
    const state = await captureFullState(source);

    const fresh = initializeSandbox();
    await applyFullState(fresh, state);

    expect(await readEverything(fresh)).toEqual(await readEverything(source));
  });

  it('apply is a total replace: state the target holds and the capture does not is gone', async () => {
    const source = await populated();
    const state = await captureFullState(source);

    const target = await populated();
    getInternalEnv(target).seed({ rules: FIRESTORE_RULES, documents: { 'things/extra': { v: 9 } } });
    getOrCreateBackend(target).adminSet('rooms/two', { title: 'second' });
    authDriver.seedUsers(getAuth(target), [
      { uid: 'bob', email: 'bob@example.com', password: 'secret-bob' },
    ]);
    await uploadBytes(
      storageRef(getAdminStorageSandbox(target), 'docs/extra.txt'),
      new Uint8Array([7]),
    );

    await applyFullState(target, state);

    expect(getInternalEnv(target).snapshot()['things/extra']).toBeUndefined();
    expect(getOrCreateBackend(target).adminGet('rooms/two')).toBeNull();
    expect(authDriver.exportUsers(getAuth(target)).map((u) => u.uid)).toEqual(['alice']);
    const captured = await captureFullState(target);
    expect(captured.storage.map((o) => o.path)).toEqual(['docs/hello.txt']);
  });

  it('round-trips through JSON, so a persisted state reloads identically', async () => {
    const source = await populated();
    const state = await captureFullState(source);

    const reloaded = JSON.parse(JSON.stringify(state)) as FullSandboxState;
    const fresh = initializeSandbox();
    await applyFullState(fresh, reloaded);

    expect(await readEverything(fresh)).toEqual(await readEverything(source));
  });

  it('clears storage rules back to null (default-deny) when applying a state captured without storage rules (ST-ENF-1)', async () => {
    const { getStorageSandbox } = await import('../../src/storage/index.js');
    const { replaceStorageRules } = await import('../../src/storage/internal.js');

    const sandbox = initializeSandbox();
    const clientStorage = getStorageSandbox(sandbox, {
      dbName: `pyric-full-state-test:${nextStorageDb++}`,
    });

    const initialSnapshot = await captureFullState(sandbox);
    expect(initialSnapshot.rules.storage).toBeNull();
    await expect(
      uploadBytes(storageRef(clientStorage, 'probe.txt'), new Uint8Array([1, 2, 3])),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });

    await replaceStorageRules(sandbox, STORAGE_RULES);
    await uploadBytes(storageRef(clientStorage, 'allowed.txt'), new Uint8Array([4, 5, 6]));

    await applyFullState(sandbox, initialSnapshot);

    const restoredSnapshot = await captureFullState(sandbox);
    expect(restoredSnapshot.rules.storage).toBeNull();
    await expect(
      uploadBytes(storageRef(clientStorage, 'after-restore.txt'), new Uint8Array([7, 8, 9])),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });
  });
});

describe('applyFullState and held Auth sessions (#1950)', () => {
  it('a checkpoint restore keeps the held session refreshing', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authDriver.createUser(auth, { uid: 'u1', email: 'u1@x.com', password: 'pw1234' });
    const { user } = await signInWithEmailAndPassword(auth, 'u1@x.com', 'pw1234');
    // The state carries the clock, so capture it after the sign-in's second.
    getClock(sandbox).advance(2000);
    const state = await captureFullState(sandbox);
    await applyFullState(sandbox, state);
    expect(authAccountsFor(sandbox)?.standing('u1')).toEqual({ kind: 'active', tokensValidAfterMs: null });
    expect(await user.getIdToken(true)).toBeString();
    expect(auth.currentUser?.uid).toBe('u1');
  });
});

describe('a captured state carries revocations and deletions (#2021)', () => {
  /** A sandbox holding a signed-in session for `uid`, its clock moved past the sign-in's second. */
  async function heldSession(uid: string) {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);
    authDriver.createUser(auth, { uid, email: `${uid}@x.com`, password: 'pw1234' });
    const { user } = await signInWithEmailAndPassword(auth, `${uid}@x.com`, 'pw1234');
    getClock(sandbox).advance(2000);
    return { sandbox, auth, user };
  }

  it('a session revoked before the capture stays refused after the restore', async () => {
    const { sandbox, auth, user } = await heldSession('revoked');
    authDriver.updateUser(auth, 'revoked', { password: 'changed-pw' });
    const revokedAt = authAccountsFor(sandbox)?.standing('revoked');
    const state = await captureFullState(sandbox);

    await applyFullState(sandbox, state);

    expect(authAccountsFor(sandbox)?.standing('revoked')).toEqual(revokedAt!);
    await expect(user.getIdToken(true)).rejects.toMatchObject({ code: 'auth/user-token-expired' });
  });

  it('revokeRefreshTokens before the capture is replayed onto another sandbox', async () => {
    const { sandbox } = await heldSession('admin-revoked');
    authAccountsFor(sandbox)?.revokeRefreshTokens('admin-revoked');
    const state = await captureFullState(sandbox);

    const target = initializeSandbox();
    await applyFullState(target, state);

    expect(authAccountsFor(target)?.standing('admin-revoked')).toEqual(authAccountsFor(sandbox)?.standing('admin-revoked')!);
  });

  it('a session of an account deleted before the capture stays refused after the restore', async () => {
    const { sandbox, auth, user } = await heldSession('gone');
    authDriver.deleteUser(auth, 'gone');
    const state = await captureFullState(sandbox);

    await applyFullState(sandbox, state);

    expect(authAccountsFor(sandbox)?.standing('gone')).toEqual({ kind: 'deleted' });
    await expect(user.getIdToken(true)).rejects.toMatchObject({ code: 'auth/user-token-expired' });
  });

  it('a revocation made after the capture is undone by the restore', async () => {
    const { sandbox, auth, user } = await heldSession('later');
    const state = await captureFullState(sandbox);
    authDriver.updateUser(auth, 'later', { password: 'changed-pw' });

    await applyFullState(sandbox, state);

    expect(authAccountsFor(sandbox)?.standing('later')).toEqual({ kind: 'active', tokensValidAfterMs: null });
    expect(await user.getIdToken(true)).toBeString();
  });

  it('a capture written without the history restores as before: every revocation is forgotten', async () => {
    const { sandbox, auth, user } = await heldSession('legacy');
    authDriver.updateUser(auth, 'legacy', { password: 'changed-pw' });
    const state = await captureFullState(sandbox);
    const legacy = structuredClone(state) as FullSandboxState;
    legacy.auth = { users: legacy.auth.users, providers: legacy.auth.providers };

    await applyFullState(sandbox, legacy);

    expect(authAccountsFor(sandbox)?.standing('legacy')).toEqual({ kind: 'active', tokensValidAfterMs: null });
    expect(await user.getIdToken(true)).toBeString();
  });

  it('a checkpoint restore keeps a revoked session refused', async () => {
    const { sandbox, auth, user } = await heldSession('checkpointed');
    authDriver.updateUser(auth, 'checkpointed', { password: 'changed-pw' });
    const checkpoint = await captureCheckpoint(sandbox);

    await restoreCheckpoint(sandbox, structuredClone(checkpoint));

    await expect(user.getIdToken(true)).rejects.toMatchObject({ code: 'auth/user-token-expired' });
  });
});

describe('applyFullState invalidates pre-restore Realtime Database onDisconnect queues', () => {
  it('discards pending onDisconnect operations registered before applyFullState', async () => {
    const {
      get,
      getDatabase,
      goOffline,
      goOnline,
      onDisconnect,
      ref,
      sandbox: rtdbDriver,
      set,
    } = await import('../../src/database/index.js');

    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    rtdbDriver.setRules(db, { rules: { '.read': true, '.write': true } });
    await set(ref(db, 'presence/u1'), { status: 'online' });
    const cleanState = await captureFullState(sandbox);

    await onDisconnect(ref(db, 'presence/u1')).set({ status: 'stale-disconnect' });
    await onDisconnect(ref(db, 'presence/ghost')).set('ghost-node');

    await applyFullState(sandbox, cleanState);
    goOffline(db);
    goOnline(db);

    expect((await get(ref(db, 'presence/u1'))).val()).toEqual({ status: 'online' });
    expect((await get(ref(db, 'presence/ghost'))).val()).toBeNull();
  });
});

describe('Storage crossServiceIam across full state, checkpoints, and branches', () => {
  it('preserves crossServiceIam: denied across captureFullState, restoreCheckpoint, fork, saveBranch/loadBranch, and promote', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fork, promote } = await import('../../src/sandbox/branches/engine.js');
    const { loadBranch, saveBranch } = await import('../../src/sandbox/branches/store.js');
    const { getStorageSandbox, uploadString } = await import('../../src/storage/index.js');
    const { replaceCrossServiceIam } = await import('../../src/storage/internal.js');

    const crossServiceRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow read, write: if request.auth != null
        && firestore.exists(/databases/(default)/documents/users/$(request.auth.uid));
    }
  }
}`;

    const source = initializeSandbox();
    getInternalEnv(source).seed({
      rules: FIRESTORE_RULES,
      documents: { 'users/u1': { active: true } },
    });
    const sourceStorage = getStorageSandbox(source.withAuth({ uid: 'u1' }), {
      dbName: `pyric-full-state-iam-src:${nextStorageDb++}`,
      rules: crossServiceRules,
      crossServiceIam: 'denied',
    });
    await expect(uploadString(storageRef(sourceStorage, 'items/i0.txt'), 'payload')).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });

    const checkpoint = await captureCheckpoint(source);
    const restored = initializeSandbox();
    getAdminStorageSandbox(restored, { dbName: `pyric-full-state-iam-restored:${nextStorageDb++}` });
    await restoreCheckpoint(restored, checkpoint);
    await expect(
      uploadString(storageRef(getStorageSandbox(restored.withAuth({ uid: 'u1' })), 'items/i1.txt'), 'payload'),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });

    const fullState = await captureFullState(source);
    const applied = initializeSandbox();
    getAdminStorageSandbox(applied, { dbName: `pyric-full-state-iam-applied:${nextStorageDb++}` });
    await applyFullState(applied, fullState);
    await expect(
      uploadString(storageRef(getStorageSandbox(applied.withAuth({ uid: 'u1' })), 'items/i2.txt'), 'payload'),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });

    const branch = await fork(fullState);
    await expect(
      uploadString(storageRef(getStorageSandbox(branch.sandbox.withAuth({ uid: 'u1' })), 'items/i3.txt'), 'payload'),
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });

    const dir = mkdtempSync(join(tmpdir(), 'pyric-iam-branch-'));
    try {
      await saveBranch(dir, 'iam-denied', branch, { base: 'live' });
      const loaded = await loadBranch(dir, 'iam-denied');
      expect(loaded).not.toBeNull();
      await expect(
        uploadString(
          storageRef(getStorageSandbox(loaded!.branch.sandbox.withAuth({ uid: 'u1' })), 'items/i4.txt'),
          'payload',
        ),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });

      const grantedLive = initializeSandbox();
      getInternalEnv(grantedLive).seed({
        rules: FIRESTORE_RULES,
        documents: { 'users/u1': { active: true } },
      });
      getStorageSandbox(grantedLive.withAuth({ uid: 'u1' }), {
        dbName: `pyric-full-state-iam-live:${nextStorageDb++}`,
        rules: crossServiceRules,
      });

      const branchDisablingIam = await fork(await captureFullState(grantedLive));
      await replaceCrossServiceIam(branchDisablingIam.sandbox, 'denied');
      await promote(branchDisablingIam, grantedLive);
      await expect(
        uploadString(storageRef(getStorageSandbox(grantedLive.withAuth({ uid: 'u1' })), 'items/i5.txt'), 'payload'),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('multi-instance Realtime Database across full state, checkpoints, and branches', () => {
  it('captures, forks, diffs, promotes, and total-replaces secondary Realtime Database instances and their rules', async () => {
    const { diff, fork, promote } = await import('../../src/sandbox/branches/engine.js');
    const secondaryInstance = { name: 'secondary-db', url: 'https://secondary-db.firebaseio.com/' };
    const secondaryRules = {
      rules: {
        orgs: {
          $orgId: {
            '.read': 'auth != null',
            '.write': 'auth != null && auth.uid === $orgId',
          },
        },
      },
    };

    const source = initializeSandbox();
    getOrCreateBackend(source).adminSet('rooms/main', { title: 'default' });
    const sourceSecondary = getOrCreateBackend(source, secondaryInstance);
    sourceSecondary.setRules(secondaryRules);
    sourceSecondary.adminSetWithPriority('orgs/u1', { plan: 'pro' }, 42);

    const checkpoint = await captureCheckpoint(source);
    expect(checkpoint.counts.database).toBe(2);

    const captured = await captureFullState(source);
    const branch = await fork(captured);

    const forkedSecondary = getOrCreateBackend(branch.sandbox, secondaryInstance);
    expect(forkedSecondary.adminGet('orgs/u1')).toEqual({ plan: 'pro' });
    expect(forkedSecondary.getPriority('orgs/u1')).toBe(42);
    expect(forkedSecondary.getActiveRules()).toEqual(secondaryRules);

    sourceSecondary.adminSet('orgs/u1', { plan: 'enterprise' });
    const branchDiff = await diff(branch, source);
    expect(branchDiff.length).toBeGreaterThan(0);

    forkedSecondary.adminSetWithPriority('orgs/u2', { plan: 'team' }, 7);
    await promote(branch, source);
    expect(sourceSecondary.adminGet('orgs/u1')).toEqual({ plan: 'enterprise' });
    expect(sourceSecondary.adminGet('orgs/u2')).toEqual({ plan: 'team' });
    expect(sourceSecondary.getPriority('orgs/u2')).toBe(7);

    const emptyCaptured = await captureFullState(initializeSandbox());
    const targetWithStaleSecondary = initializeSandbox();
    const staleSecondary = getOrCreateBackend(targetWithStaleSecondary, secondaryInstance);
    staleSecondary.setRules(secondaryRules);
    staleSecondary.adminSet('orgs/stale', { leftover: true });

    await applyFullState(targetWithStaleSecondary, emptyCaptured);
    expect(staleSecondary.adminGet('orgs/stale')).toBeNull();
    expect(staleSecondary.getActiveRules()).toBeNull();
  });
});

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
      embedding: new RulesVector([0.25, -0.5, 1.0]),
      nested: { tags: ['alpha', 'beta'], meta: { count: 2 } },
    });
    env.adminSetDocument('items/envelope', {
      type: 'pyric/map/1.0',
      fields: { a: 1 },
      sibling: 'kept',
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
      rules: FIRESTORE_RULES.replace('cloud.firestore', 'firebase.storage').replace('/databases/{db}/documents', '/b/{bucket}/o'),
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
      storageDefaultRules: getStorageRulesResolution(defaultStorage)?.source ?? null,
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
    const { getStorageService, storageBucketsWithRules } = await import('../../src/storage/internal.js');
    const { databaseInstanceNamed } = await import('../../src/sandbox/internal/instances.js');

    const source = await populatedAllCapabilities();
    const baselineShared = await readSharedCapabilities(source);
    const baselineClock = getClock(source).capture();
    const baselineHistory = structuredClone(authAccountsFor(source)?.history());

    const fullState = await captureFullState(source);
    const snapshot = await captureSandboxSnapshot(source);
    const forkedViaSnapshot = await forkSandbox(source);
    const branch = await fork(fullState);

    // Mutate source nested structures in-place after capture/fork to test source -> target non-aliasing
    const sourceWrappers = getInternalEnv(source).getDocument('items/wrappers')!;
    ((sourceWrappers.nested as Record<string, unknown>).tags as string[]).push('mutated-source');
    getOrCreateBackend(source).adminSet('tree/group/leaf/label', 'mutated-source');
    const sourcePwUser = authDriver.exportUsers(getAuth(source)).find((u) => u.uid === 'pw-user')!;
    ((sourcePwUser.customClaims as Record<string, unknown>).roles as string[]).push('mutated-claim');

    const dirtyFullTarget = await populatedDirtyTarget();
    await applyFullState(dirtyFullTarget, fullState);

    const dirtySnapTarget = await populatedDirtyTarget();
    const { refusals } = await restoreSandboxSnapshot(dirtySnapTarget, snapshot, { merge: false });
    expect(refusals).toEqual([]);

    // Armed onDisconnect operations from BOTH the dirty targets and the source must not fire on restored targets
    for (const restored of [dirtyFullTarget, dirtySnapTarget, forkedViaSnapshot.sandbox, branch.sandbox]) {
      goOffline(getDatabase(restored));
      goOffline(getDatabase(restored, 'https://dirty-shard.firebaseio.com/'));
      expect(getOrCreateBackend(restored).adminGet('stale/disconnect')).toBeNull();
      expect(getOrCreateBackend(restored).adminGet('tree/disconnected')).toBeNull();
      expect(getOrCreateBackend(restored, databaseInstanceNamed('dirty-shard')).adminGet('leftover/disconnect')).toBeNull();
    }

    // 2-Codec Parity on shared surface + dirty-target wipe assertions
    expect(await readSharedCapabilities(dirtyFullTarget)).toEqual(baselineShared);
    expect(await readSharedCapabilities(dirtySnapTarget)).toEqual(baselineShared);
    expect(await readSharedCapabilities(forkedViaSnapshot.sandbox)).toEqual(baselineShared);
    expect(await readSharedCapabilities(branch.sandbox)).toEqual(baselineShared);
    expect(await diff(branch, dirtyFullTarget)).toEqual([]);

    // Codec-specific surfaces: Clock + Auth history on FullSandboxState; Clock + custom bucket on forkSandbox/Snapshot
    expect(getClock(dirtyFullTarget).capture()).toEqual(baselineClock);
    expect(getClock(forkedViaSnapshot.sandbox).capture()).toEqual(baselineClock);
    expect(authAccountsFor(dirtyFullTarget)?.history()).toEqual(baselineHistory);
    expect(storageBucketsWithRules(dirtyFullTarget)).toEqual([]);
    expect(storageBucketsWithRules(dirtySnapTarget)).toEqual(['assets-bucket']);
    const restoredAssets = await (
      await getStorageService(getAdminStorageSandbox(dirtySnapTarget, { bucket: 'assets-bucket' }))
    ).backend.listByPrefix('');
    expect(restoredAssets.map((item) => item.fullPath)).toEqual(['assets/logo.svg']);

    // Branch promote onto a fresh dirty-wiped base reproduces full state cleanly
    const promoBase = await populatedDirtyTarget();
    await applyFullState(promoBase, await captureFullState(initializeSandbox()));
    const promoBranch = await fork(await captureFullState(promoBase));
    await applyFullState(promoBranch.sandbox, fullState);
    await promote(promoBranch, promoBase);
    expect((await readSharedCapabilities(promoBase)).firestoreDocs).toEqual(baselineShared.firestoreDocs);
    expect((await readSharedCapabilities(promoBase)).rtdbSecondary).toEqual(baselineShared.rtdbSecondary);
    expect((await readSharedCapabilities(promoBase)).authUsers).toEqual(baselineShared.authUsers);

    // Mutate restored targets in-place and verify source, forkedViaSnapshot, and branch remain untouched (bidirectional non-aliasing)
    const sourceAfterSourceMutation = await readSharedCapabilities(source);
    const targetWrappers = getInternalEnv(dirtyFullTarget).getDocument('items/wrappers')!;
    ((targetWrappers.nested as Record<string, unknown>).tags as string[]).push('mutated-target');
    const targetSnapUser = authDriver.exportUsers(getAuth(dirtySnapTarget)).find((u) => u.uid === 'pw-user')!;
    ((targetSnapUser.customClaims as Record<string, unknown>).roles as string[]).push('mutated-snap-target');

    expect(await readSharedCapabilities(source)).toEqual(sourceAfterSourceMutation);
    expect(await readSharedCapabilities(forkedViaSnapshot.sandbox)).toEqual(baselineShared);
    expect(await readSharedCapabilities(branch.sandbox)).toEqual(baselineShared);
  });
});
