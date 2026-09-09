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
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';
import { getOrCreateBackend } from '../../src/database/sandbox/backend-for.js';
import { getAuth } from '../../src/auth/instances.js';
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
});
