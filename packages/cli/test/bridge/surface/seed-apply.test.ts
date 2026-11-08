import 'fake-indexeddb/auto';
import { describe, expect, it, spyOn } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import {
  get as databaseGet,
  getAdminDatabase,
  ref as databaseRef,
  set as databaseSet,
} from 'pyric/database';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  doc,
  getAdminFirestore,
  getDoc,
  setDoc,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { getActiveRules } from 'pyric/sandbox/database';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getBytes, getMetadata, ref as storageRef } from 'pyric/storage';
import {
  getAdminStorageSandbox,
  getStorageRulesResolution,
} from 'pyric/storage/internal';

import {
  applyData,
  applyRules,
  applyUsers,
} from '../../../src/bridge/surface/seed-apply.js';

let nextSeedStorageSeq = 1;

describe('seed-apply', () => {
  it('applyUsers preserves profile metadata, timestamps, and anonymous accounts without synthesizing anonymous credentials unless explicit', () => {
    const sandbox = initializeSandbox();
    const seedSpy = spyOn(authSandbox, 'seedUsers');
    try {
      applyUsers(sandbox, [
        {
          uid: 'u1',
          email: 'u1@example.test',
          password: 'pw-1',
          displayName: 'Alice Example',
          photoUrl: 'https://example.test/u1.png',
          phoneNumber: '+15550101',
          emailVerified: true,
          disabled: true,
          customClaims: { role: 'owner' },
          tenantId: 'org-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-02T00:00:00.000Z',
        },
        {
          uid: 'anon-1',
          providerId: 'anonymous',
          displayName: 'Guest One',
          photoUrl: 'https://example.test/guest.png',
          customClaims: { tier: 'guest' },
          tenantId: 'org-1',
        },
        {
          uid: 'anon-explicit',
          providerId: 'anonymous',
          email: 'explicit@example.test',
          password: 'secret',
        },
        {
          uid: 'u2',
        },
      ]);

      expect(seedSpy).toHaveBeenCalledTimes(1);
      const passedRecords = seedSpy.mock.calls[0]?.[1] ?? [];
      expect(Object.hasOwn(passedRecords[1] ?? {}, 'email')).toBe(false);
      expect(Object.hasOwn(passedRecords[1] ?? {}, 'password')).toBe(false);
      expect(passedRecords[2]).toEqual({
        uid: 'anon-explicit',
        providerId: 'anonymous',
        email: 'explicit@example.test',
        password: 'secret',
      });
    } finally {
      seedSpy.mockRestore();
    }

    const auth = getAuth(sandbox);
    const listed = authSandbox.listUsers(auth);
    const exported = authSandbox.exportUsers(auth);

    expect(listed.find((u) => u.uid === 'u1')).toMatchObject({
      uid: 'u1',
      email: 'u1@example.test',
      displayName: 'Alice Example',
      photoUrl: 'https://example.test/u1.png',
      phoneNumber: '+15550101',
      emailVerified: true,
      disabled: true,
      customClaims: { role: 'owner' },
      tenantId: 'org-1',
      isAnonymous: false,
    });
    const u1Export = exported.find((u) => u.uid === 'u1');
    expect(u1Export?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(u1Export?.lastLoginAt).toBe('2026-01-02T00:00:00.000Z');

    expect(listed.find((u) => u.uid === 'anon-1')).toMatchObject({
      uid: 'anon-1',
      email: null,
      displayName: 'Guest One',
      photoUrl: 'https://example.test/guest.png',
      customClaims: { tier: 'guest' },
      tenantId: 'org-1',
      isAnonymous: true,
      providerUserInfo: [],
    });
    const anonExport = exported.find((u) => u.uid === 'anon-1');
    expect(anonExport?.providerId).toBe('anonymous');
    expect(anonExport?.email).toBeUndefined();
    expect(anonExport?.password).toBeUndefined();

    const defaultExport = exported.find((u) => u.uid === 'u2');
    expect(defaultExport?.email).toBe('u2@pyric.invalid');
    expect(defaultExport?.password).toBe('seed-u2');
  });

  it('applyRules installs valid rules and retains existing rules when sources are refused', async () => {
    const sandbox = initializeSandbox();
    const validFirestore = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} { allow read: if true; }\n  }\n}`;
    const validDatabase = JSON.stringify({ rules: { items: { '.read': true } } });
    const validStorage = `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /files/{uid}/{name} { allow read: if true; }\n  }\n}`;

    const okRefusals = await applyRules(sandbox, {
      firestoreRules: validFirestore,
      databaseRules: validDatabase,
      storageRules: validStorage,
    });
    expect(okRefusals).toEqual([]);
    expect(getInternalEnv(sandbox).getRules()).toBe(validFirestore);
    expect(getActiveRules(sandbox)).toEqual({ rules: { items: { '.read': true } } });
    expect(getStorageRulesResolution(getAdminStorageSandbox(sandbox))?.source).toBe(validStorage);

    const badRefusals = await applyRules(sandbox, {
      firestoreRules: 'service broken {',
      databaseRules: JSON.stringify({ rules: { items: { '.read': 'auth.uid ===' } } }),
      storageRules: 'service broken {',
    });
    expect(badRefusals.length).toBe(3);
    expect(getInternalEnv(sandbox).getRules()).toBe(validFirestore);
    expect(getActiveRules(sandbox)).toEqual({ rules: { items: { '.read': true } } });
    expect(getStorageRulesResolution(getAdminStorageSandbox(sandbox))?.source).toBe(validStorage);
  });

  it('applyData merges rich Firestore, RTDB, Storage, and Auth entries without wiping sibling state', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getAdminFirestore(sandbox);
    await setDoc(doc(adminDb, 'orgs/existing'), { intact: true });
    const adminRtdb = getAdminDatabase(sandbox);
    await databaseSet(databaseRef(adminRtdb, 'orgs/existing'), { intact: true });
    const adminStorage = getAdminStorageSandbox(sandbox, {
      dbName: `pyric-seed-apply-test:${nextSeedStorageSeq++}`,
    });

    await applyData(sandbox, {
      users: [
        {
          uid: 'u1',
          email: 'u1@example.test',
          displayName: 'Alice Example',
          photoUrl: 'https://example.test/u1.png',
          phoneNumber: '+15550101',
        },
        {
          uid: 'anon-2',
          providerId: 'anonymous',
          displayName: 'Anonymous Visitor',
        },
      ],
      firestore: {
        'items/item-1': {
          createdAt: {
            type: 'firestore/timestamp/1.0',
            seconds: 1_700_000_000,
            nanoseconds: 250_000_000,
          },
          coords: new GeoPoint(40.0, -74.0).toJSON(),
          payload: {
            type: 'firestore/bytes/1.0',
            bytes: btoa('ok'),
          },
          owner: { __type: 'reference', path: 'users/u1' },
        },
      },
      database: {
        items: {
          ranked: { '.value': 'gold', '.priority': 3 },
        },
      },
      storage: [
        {
          path: 'files/u1/doc.txt',
          contentBase64: btoa('seeded-bytes'),
          contentType: 'text/plain',
          customMetadata: { source: 'seed' },
        },
      ],
    });

    expect((await getDoc(doc(adminDb, 'orgs/existing'))).data()).toEqual({ intact: true });
    expect((await databaseGet(databaseRef(adminRtdb, 'orgs/existing'))).val()).toEqual({
      intact: true,
    });

    const itemData = (await getDoc(doc(adminDb, 'items/item-1'))).data()!;
    expect(itemData.createdAt).toBeInstanceOf(Timestamp);
    expect(itemData.coords).toBeInstanceOf(GeoPoint);
    expect(itemData.payload).toBeInstanceOf(Bytes);
    expect((itemData.owner as { path?: string }).path).toBe('users/u1');

    const rankedSnap = await databaseGet(databaseRef(adminRtdb, 'items/ranked'));
    expect(rankedSnap.val()).toBe('gold');
    expect(rankedSnap.priority).toBe(3);

    const fileRef = storageRef(adminStorage, 'files/u1/doc.txt');
    const meta = await getMetadata(fileRef);
    expect(meta.contentType).toBe('text/plain');
    expect(meta.customMetadata).toEqual({ source: 'seed' });
    const bytes = new Uint8Array(await getBytes(fileRef));
    expect(new TextDecoder().decode(bytes)).toBe('seeded-bytes');

    const users = authSandbox.listUsers(getAuth(sandbox));
    expect(users.find((u) => u.uid === 'u1')).toMatchObject({
      displayName: 'Alice Example',
      photoUrl: 'https://example.test/u1.png',
      phoneNumber: '+15550101',
    });
    expect(users.find((u) => u.uid === 'anon-2')).toMatchObject({
      uid: 'anon-2',
      email: null,
      displayName: 'Anonymous Visitor',
      isAnonymous: true,
    });
  });
});
