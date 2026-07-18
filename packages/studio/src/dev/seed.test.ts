// Deterministic IDB global: the `fake-indexeddb/auto` side-effect import is
// evaluated once per process, so when another suite in the same bun run
// clobbers `globalThis.indexedDB` after that first evaluation, a cached
// re-import here does NOT restore it (observed as `indexedDB is not
// defined` in the CI library lane only). Assign a fresh factory explicitly.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import { getMetadata, listAll, ref as storageRef } from 'pyric/storage';
import { applySeed, createSeededSandbox, deploySeedRules, seedAuth } from './seed.js';

describe('Studio Auth dev seed', () => {
  it('seeds provider provenance as Auth data rather than custom claims', async () => {
    const auth = getAuth(initializeSandbox());
    await seedAuth(auth);
    const users = authSandbox.listUsers(auth);

    const alice = users.find((user) => user.uid === 'alice');
    expect(alice?.providerUserInfo).toEqual([{ providerId: 'google.com' }]);
    expect(alice?.customClaims).toEqual({ plan: 'pro' });

    const anonymous = users.find((user) => user.isAnonymous);
    expect(anonymous).toBeDefined();
    expect(anonymous?.providerUserInfo).toEqual([]);
  });
});

describe('Studio reset (dev-seed flow)', () => {
  // The in-process core of `useStudioReset`: `sandbox.resetAll()` (the ONE
  // sandbox-owned wipe — issue #359), then rules + fixture re-application.
  // Pre-fix there was no sandbox-owned path and storage objects survived a
  // Studio reset.
  it('resetAll wipes storage objects too, and the reseed restores the fixture', async () => {
    const handles = await createSeededSandbox();
    const avatars = storageRef(handles.storage, 'avatars');
    expect((await listAll(avatars)).items.length).toBeGreaterThan(0);
    expect(authSandbox.listUsers(handles.auth).length).toBeGreaterThan(0);

    await handles.sandbox.resetAll();

    // Everything is gone — including storage (the pre-fix escapee).
    expect((await listAll(avatars)).items).toHaveLength(0);
    await expect(getMetadata(storageRef(handles.storage, 'avatars/alice.png'))).rejects.toThrow();
    expect(authSandbox.listUsers(handles.auth)).toHaveLength(0);
    expect(Object.keys(handles.sandbox.snapshot().firestore)).toHaveLength(0);

    // Re-apply rules + fixture exactly as useStudioReset's dev branch does.
    deploySeedRules(handles.sandbox);
    await applySeed(handles);
    expect((await listAll(avatars)).items.length).toBeGreaterThan(0);
    expect(authSandbox.listUsers(handles.auth).length).toBeGreaterThan(0);
    expect(Object.keys(handles.sandbox.snapshot().firestore).length).toBeGreaterThan(0);
  });
});
