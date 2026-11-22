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

    const expectedStanding = authAccountsFor(sandbox)?.standing('revoked');
    expect(expectedStanding).toBeDefined();
    expect(authAccountsFor(sandbox)?.standing('revoked')).toEqual(expectedStanding);
    await expect(user.getIdToken(true)).rejects.toMatchObject({ code: 'auth/user-token-expired' });
  });

  it('revokeRefreshTokens before the capture is replayed onto another sandbox', async () => {
    const { sandbox } = await heldSession('admin-revoked');
    authAccountsFor(sandbox)?.revokeRefreshTokens('admin-revoked');
    const state = await captureFullState(sandbox);

    const target = initializeSandbox();
    await applyFullState(target, state);

    const sourceStanding = authAccountsFor(sandbox)?.standing('admin-revoked');
    expect(sourceStanding).toBeDefined();
    expect(authAccountsFor(target)?.standing('admin-revoked')).toEqual(sourceStanding);
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
      if (loaded === null) {
        throw new Error('Expected saved branch iam-denied to load.');
      }
      await expect(
        uploadString(
          storageRef(getStorageSandbox(loaded.branch.sandbox.withAuth({ uid: 'u1' })), 'items/i4.txt'),
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
