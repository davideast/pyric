import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import {
  get as rtdbGet,
  getAdminDatabase,
  ref as rtdbRef,
  set as rtdbSet,
  setPriority,
} from 'pyric/database';
import { doc, getAdminFirestore, getDoc, setDoc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
  encodeBytesToBase64,
  restoreSandboxSnapshot,
  type SandboxSnapshot,
} from 'pyric/sandbox/internal';
import {
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
} from 'pyric/storage';
import {
  deployStorageBucketRules,
  getAdminStorageSandbox,
  storageBucketsWithRules,
} from 'pyric/storage/internal';

let nextRestoreDb = 1;

describe('snapshot-restore', () => {
  it('replaces state by default and merges state across services when merge is true', async () => {
    const base = initializeSandbox();
    await setDoc(doc(getAdminFirestore(base), 'items/keep'), { v: 1 });
    await rtdbSet(rtdbRef(getAdminDatabase(base), 'items/keep'), { v: 1 });
    authSandbox.seedUsers(getAuth(base), [{ uid: 'u-keep', email: 'keep@example.test' }]);

    const deltaSource = initializeSandbox();
    await setDoc(doc(getAdminFirestore(deltaSource), 'orgs/org-1'), { added: true });
    const deltaRtdb = getAdminDatabase(deltaSource);
    await rtdbSet(rtdbRef(deltaRtdb, 'orgs/org-1'), { added: true });
    await setPriority(rtdbRef(deltaRtdb, '/'), 42);
    authSandbox.seedUsers(getAuth(deltaSource), [{ uid: 'u-added', email: 'added@example.test' }]);
    const deltaSnapshot = await captureSandboxSnapshot(deltaSource);

    // Merge mode keeps pre-existing state while applying delta and root priority.
    const merged = await restoreSandboxSnapshot(base, deltaSnapshot, { merge: true });
    expect(merged.refusals).toEqual([]);
    expect((await getDoc(doc(getAdminFirestore(base), 'items/keep'))).exists()).toBe(true);
    expect((await getDoc(doc(getAdminFirestore(base), 'orgs/org-1'))).data()).toEqual({ added: true });
    expect((await rtdbGet(rtdbRef(getAdminDatabase(base), 'items/keep'))).val()).toEqual({ v: 1 });
    expect((await rtdbGet(rtdbRef(getAdminDatabase(base), 'orgs/org-1'))).val()).toEqual({ added: true });
    expect((await rtdbGet(rtdbRef(getAdminDatabase(base), '/'))).priority).toBe(42);
    expect(authSandbox.listUsers(getAuth(base)).map((u) => u.uid).sort()).toEqual(['u-added', 'u-keep']);

    // Replace mode (default) removes state absent from snapshot.
    const replaced = await restoreSandboxSnapshot(base, deltaSnapshot);
    expect(replaced.refusals).toEqual([]);
    expect((await getDoc(doc(getAdminFirestore(base), 'items/keep'))).exists()).toBe(false);
    expect((await rtdbGet(rtdbRef(getAdminDatabase(base), 'items/keep'))).val()).toBeNull();
    expect(authSandbox.listUsers(getAuth(base)).map((u) => u.uid)).toEqual(['u-added']);
  });

  it('collects rule refusals without aborting data restoration', async () => {
    const target = initializeSandbox();
    const malformedSnapshot: SandboxSnapshot = {
      version: 1,
      rules: {
        rtdb: {
          [DEFAULT_SNAPSHOT_RESOURCE]: '{ not valid json',
        },
        storage: {
          [DEFAULT_SNAPSHOT_RESOURCE]: 'rules_version = "2"; invalid storage rules {{{',
        },
      },
      auth: { users: [{ uid: 'u1', email: 'u1@example.test' }] },
      firestore: {
        [DEFAULT_SNAPSHOT_RESOURCE]: {
          'items/item-1': { ok: true },
        },
      },
      rtdb: {},
      storage: {},
    };

    const { refusals } = await restoreSandboxSnapshot(target, malformedSnapshot);
    expect(refusals.length).toBe(2);
    expect((await getDoc(doc(getAdminFirestore(target), 'items/item-1'))).data()).toEqual({ ok: true });
    expect(authSandbox.listUsers(getAuth(target)).map((u) => u.uid)).toEqual(['u1']);
  });

  it('clears stale named-bucket Storage rules on replace restore and unlocks undeployed buckets', async () => {
    const target = initializeSandbox();
    deployStorageBucketRules(
      target,
      'named-bucket',
      `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} { allow read, write: if false; }\n  }\n}`,
    );
    expect(storageBucketsWithRules(target)).toEqual(['named-bucket']);

    const emptySnapshot = await captureSandboxSnapshot(initializeSandbox());
    const { refusals } = await restoreSandboxSnapshot(target, emptySnapshot);
    expect(refusals).toEqual([]);
    expect(storageBucketsWithRules(target)).toEqual([]);

    const undeployedBucket = getStorageSandbox(target, {
      bucket: 'other-bucket',
      dbName: `pyric-restore-unlocked:${nextRestoreDb++}`,
    });
    await expect(
      uploadBytes(storageRef(undeployedBucket, 'files/u1/test.bin'), new Uint8Array([7, 8])),
    ).rejects.toThrow(/No Storage rules configured; default deny/);

    const defaultRulesSnapshot: SandboxSnapshot = {
      version: 1,
      rules: {
        storage: {
          [DEFAULT_SNAPSHOT_RESOURCE]: `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} { allow read, write: if true; }\n  }\n}`,
        },
      },
      auth: { users: [] },
      firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: {} },
      rtdb: {},
      storage: {},
    };
    await restoreSandboxSnapshot(target, defaultRulesSnapshot);
    await uploadBytes(
      storageRef(undeployedBucket, 'files/u1/test.bin'),
      new Uint8Array([7, 8]),
    );
  });

  it('restores Storage objects without emitting synthetic history events', async () => {
    const target = initializeSandbox();
    getAdminStorageSandbox(target, { dbName: `pyric-restore-quiet:${nextRestoreDb++}` });
    const snapshot: SandboxSnapshot = {
      version: 1,
      rules: {},
      auth: { users: [] },
      firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: {} },
      rtdb: {},
      storage: {
        [DEFAULT_SNAPSHOT_RESOURCE]: [
          {
            path: 'files/u1/quiet.bin',
            contentBase64: encodeBytesToBase64(new Uint8Array([1, 2, 3])),
            size: 3,
            contentType: 'application/octet-stream',
          },
        ],
      },
    };
    const beforeCount = target.history().length;
    await restoreSandboxSnapshot(target, snapshot);
    expect(target.history().length).toBe(beforeCount);
  });

  it('refuses array-valued RTDB rules envelopes and guards Object.prototype keys', async () => {
    const target = initializeSandbox();
    await setDoc(doc(getAdminFirestore(target), 'constructor/stale'), { old: true });
    const snapshot: SandboxSnapshot = {
      version: 1,
      rules: {
        rtdb: {
          [DEFAULT_SNAPSHOT_RESOURCE]: '{"rules": []}',
        },
      },
      auth: { users: [] },
      firestore: {
        [DEFAULT_SNAPSHOT_RESOURCE]: {
          'constructor/doc-1': { ok: true },
          'toString/doc-2': { ok: true },
        },
      },
      rtdb: {},
      storage: {},
    };

    const { refusals } = await restoreSandboxSnapshot(target, snapshot);
    expect(refusals).toHaveLength(1);
    expect((await getDoc(doc(getAdminFirestore(target), 'constructor/stale'))).exists()).toBe(false);
    expect((await getDoc(doc(getAdminFirestore(target), 'constructor/doc-1'))).data()).toEqual({ ok: true });
    expect((await getDoc(doc(getAdminFirestore(target), 'toString/doc-2'))).data()).toEqual({ ok: true });
  });
});
