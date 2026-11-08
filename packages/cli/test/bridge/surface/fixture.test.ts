import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  Bytes,
  DocumentReference,
  GeoPoint,
  Timestamp,
  collection,
  doc,
  getAdminFirestore,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from 'pyric/firestore';
import {
  get as databaseGet,
  getAdminDatabase,
  getDatabase,
  ref as databaseRef,
  sandbox as rtdbSandbox,
  set as databaseSet,
  setPriority,
  setWithPriority,
} from 'pyric/database';
import { getAuth, sandbox as authSandbox, signInAnonymously } from 'pyric/auth';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getBytes, getMetadata, ref as storageRef, uploadBytes } from 'pyric/storage';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';

import {
  applyFixture,
  buildFixture,
  readFixtureFile,
  writeFixtureFile,
} from '../../../src/bridge/surface/fixture.js';

let nextStorageSeq = 1;

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'pyric-fixture-'));
}

describe('buildFixture / writeFixtureFile / readFixtureFile / applyFixture', () => {
  it('carries documents and users into a fixture and back', async () => {
    const sandbox = initializeSandbox();
    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'orgs/org-1'), { open: true });
    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'u1', email: 'u1@example.test', password: 'super-secret', tenantId: 'org-1' },
    ]);

    const fixture = await buildFixture(sandbox);
    expect(fixture.firestore?.['orgs/org-1']).toEqual({ open: true });
    const user = fixture.users?.find((entry) => entry.uid === 'u1');
    expect(user?.tenantId).toBe('org-1');
    expect(user?.password).toBe('super-secret');

    const projectDir = tmpProjectDir();
    const path = join(projectDir, 'fixtures', 'scenario.json');
    writeFixtureFile(path, fixture);
    const read = readFixtureFile(path);
    expect(read).toEqual(fixture);

    const target = initializeSandbox();
    await applyFixture(target, read!);
    const restoredUser = authSandbox
      .exportUsers(getAuth(target))
      .find((entry) => entry.uid === 'u1');
    expect(restoredUser?.tenantId).toBe('org-1');
  });

  it('carries the seeded password by default, and leaves it out when asked', async () => {
    const sandbox = initializeSandbox();
    authSandbox.seedUsers(getAuth(sandbox), [
      { uid: 'u2', email: 'u2@example.test', password: 'plain-password' },
    ]);

    const carried = await buildFixture(sandbox);
    expect(carried.users?.find((entry) => entry.uid === 'u2')?.password).toBe('plain-password');

    const withheld = await buildFixture(sandbox, true);
    expect(withheld.users?.find((entry) => entry.uid === 'u2')?.password).toBeUndefined();
    expect(JSON.stringify(withheld)).not.toContain('plain-password');
  });

  it('reads back null for a fixture that does not exist', () => {
    const projectDir = tmpProjectDir();
    expect(readFixtureFile(join(projectDir, 'missing.json'))).toBeNull();
  });

  it('round-trips rich Firestore SDK types, RTDB priorities, Storage metadata, and Auth flags without wiping sibling live state', async () => {
    const source = initializeSandbox();
    setFirestoreRules(
      source,
      `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} { allow read: if request.auth != null; }\n  }\n}`,
    );

    const sourceDb = getAdminFirestore(source);
    const createdAt = new Timestamp(1_710_000_123, 456_000_000);
    const payload = Bytes.fromUint8Array(new Uint8Array([9, 8, 7, 6]));
    const location = new GeoPoint(37.7749, -122.4194);
    const ownerRef = doc(sourceDb, 'users/u1');
    await setDoc(doc(sourceDb, 'items/item-1'), {
      createdAt,
      payload,
      location,
      ownerRef,
      plainMarkerLike: { type: 'firestore/timestamp/1.0', note: 'user-map' },
    });

    const sourceRtdb = getDatabase(source);
    rtdbSandbox.setRules(sourceRtdb, { rules: { items: { '.read': 'auth != null' } } });
    const sourceAdminRtdb = getAdminDatabase(source);
    await setWithPriority(databaseRef(sourceAdminRtdb, 'items/item-1'), 'pinned', 7);
    await databaseSet(databaseRef(sourceAdminRtdb, 'items/item-2'), { title: 'ranked' });
    await setPriority(databaseRef(sourceAdminRtdb, 'items/item-2'), 'alpha');

    const sourceStorage = getAdminStorageSandbox(source, {
      dbName: `pyric-fixture-source:${nextStorageSeq++}`,
    });
    await replaceStorageRules(
      source,
      `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /files/{uid}/{name} { allow read: if request.auth != null; }\n  }\n}`,
    );
    await uploadBytes(
      storageRef(sourceStorage, 'files/u1/blob.bin'),
      new Uint8Array([1, 3, 5, 7]),
      { contentType: 'application/octet-stream', customMetadata: { rev: 'v2' } },
    );

    authSandbox.seedUsers(getAuth(source), [
      {
        uid: 'u1',
        email: 'u1@example.test',
        password: 'fixture-password',
        displayName: 'Alice Example',
        photoUrl: 'https://example.test/u1.png',
        phoneNumber: '+15550101',
        emailVerified: true,
        disabled: true,
        customClaims: { role: 'editor' },
        tenantId: 'org-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastLoginAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    const anonCred = await signInAnonymously(getAuth(source));
    const anonUid = anonCred.user.uid;

    const fixture = await buildFixture(source);
    const filePath = join(tmpProjectDir(), 'fixtures', 'rich.json');
    writeFixtureFile(filePath, fixture);
    const loaded = readFixtureFile(filePath);
    expect(loaded).not.toBeNull();

    const target = initializeSandbox();
    const targetDb = getAdminFirestore(target);
    await setDoc(doc(targetDb, 'orgs/existing'), { preserved: true });
    const targetAdminRtdb = getAdminDatabase(target);
    await databaseSet(databaseRef(targetAdminRtdb, 'orgs/existing'), { preserved: true });
    const targetStorage = getAdminStorageSandbox(target, {
      dbName: `pyric-fixture-target:${nextStorageSeq++}`,
    });

    const refusals = await applyFixture(target, loaded!);
    expect(refusals).toEqual([]);

    // Pre-existing sibling state remains intact.
    expect((await getDoc(doc(targetDb, 'orgs/existing'))).data()).toEqual({ preserved: true });
    expect((await databaseGet(databaseRef(targetAdminRtdb, 'orgs/existing'))).val()).toEqual({
      preserved: true,
    });

    // Rich Firestore types survived JSON serialization, re-application, and indexed queries.
    const itemSnap = await getDoc(doc(targetDb, 'items/item-1'));
    const data = itemSnap.data()!;
    expect(data.createdAt).toBeInstanceOf(Timestamp);
    expect((data.createdAt as Timestamp).isEqual(createdAt)).toBe(true);
    expect(data.payload).toBeInstanceOf(Bytes);
    expect(Array.from((data.payload as Bytes).toUint8Array())).toEqual([9, 8, 7, 6]);
    expect(data.location).toBeInstanceOf(GeoPoint);
    expect((data.location as GeoPoint).isEqual(location)).toBe(true);
    expect(data.ownerRef).toBeInstanceOf(DocumentReference);
    expect((data.ownerRef as DocumentReference).path).toBe('users/u1');
    expect(data.plainMarkerLike).toEqual({ type: 'firestore/timestamp/1.0', note: 'user-map' });

    const tsQuerySnap = await getDocs(
      query(collection(targetDb, 'items'), where('createdAt', '==', createdAt)),
    );
    expect(tsQuerySnap.docs.length).toBe(1);

    // RTDB leaf and branch priorities survived.
    const leafSnap = await databaseGet(databaseRef(targetAdminRtdb, 'items/item-1'));
    expect(leafSnap.val()).toBe('pinned');
    expect(leafSnap.priority).toBe(7);
    const branchSnap = await databaseGet(databaseRef(targetAdminRtdb, 'items/item-2'));
    expect(branchSnap.val()).toEqual({ title: 'ranked' });
    expect(branchSnap.priority).toBe('alpha');

    // Storage bytes and metadata survived.
    const meta = await getMetadata(storageRef(targetStorage, 'files/u1/blob.bin'));
    expect(meta.contentType).toBe('application/octet-stream');
    expect(meta.customMetadata).toEqual({ rev: 'v2' });
    const bytes = new Uint8Array(await getBytes(storageRef(targetStorage, 'files/u1/blob.bin')));
    expect(Array.from(bytes)).toEqual([1, 3, 5, 7]);

    // Auth profile metadata, flags, claims, timestamps, tenant, and anonymous accounts survived.
    const listedUsers = authSandbox.listUsers(getAuth(target));
    const userRecord = listedUsers.find((u) => u.uid === 'u1');
    expect(userRecord).toMatchObject({
      uid: 'u1',
      email: 'u1@example.test',
      displayName: 'Alice Example',
      photoUrl: 'https://example.test/u1.png',
      phoneNumber: '+15550101',
      emailVerified: true,
      disabled: true,
      customClaims: { role: 'editor' },
      tenantId: 'org-1',
    });
    const exportedU1 = authSandbox.exportUsers(getAuth(target)).find((u) => u.uid === 'u1');
    expect(exportedU1?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(exportedU1?.lastLoginAt).toBe('2026-01-02T00:00:00.000Z');

    const anonRecord = listedUsers.find((u) => u.uid === anonUid);
    expect(anonRecord).toMatchObject({
      uid: anonUid,
      email: null,
      isAnonymous: true,
      providerUserInfo: [],
    });
    const anonExport = authSandbox.exportUsers(getAuth(target)).find((u) => u.uid === anonUid);
    expect(anonExport?.providerId).toBe('anonymous');
    expect(anonExport?.email).toBeUndefined();
    expect(anonExport?.password).toBeUndefined();
  });

  it('passes hand-authored plain JSON SandboxSeed fixtures straight through applyFixture', async () => {
    const target = initializeSandbox();
    const refusals = await applyFixture(target, {
      users: [{ uid: 'u3', customClaims: { role: 'viewer' } }],
      firestore: {
        'items/plain': { title: 'hand-authored', tags: ['a', 'b'], count: 3 },
      },
      database: {
        items: { plain: { active: true } },
      },
    });
    expect(refusals).toEqual([]);
    const snap = await getDoc(doc(getAdminFirestore(target), 'items/plain'));
    expect(snap.data()).toEqual({ title: 'hand-authored', tags: ['a', 'b'], count: 3 });
    const rtdbSnap = await databaseGet(databaseRef(getAdminDatabase(target), 'items/plain'));
    expect(rtdbSnap.val()).toEqual({ active: true });
    const exportedUser = authSandbox.exportUsers(getAuth(target)).find((u) => u.uid === 'u3');
    expect(exportedUser?.email).toBe('u3@pyric.invalid');
    expect(exportedUser?.password).toBe('seed-u3');
  });
});
