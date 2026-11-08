import 'fake-indexeddb/auto';
import { describe, expect, it, spyOn } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox, signInAnonymously } from 'pyric/auth';
import { Bytes, doc, GeoPoint, getAdminFirestore, getDoc, Timestamp } from 'pyric/firestore';
import { get as dbGet, getAdminDatabase, ref as dbRef } from 'pyric/database';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { getBytes, getMetadata, ref as storageRef } from 'pyric/storage';
import { applyData, applyRules, applyUsers } from '../../../src/bridge/surface/seed-apply.js';
import { applyFixture, buildFixture } from '../../../src/bridge/surface/fixture.js';

describe('seed-apply (applyUsers, applyRules, applyData)', () => {
  it('does not synthesize email or password for anonymous users unless explicitly supplied', async () => {
    const sandbox = initializeSandbox();
    const seedSpy = spyOn(authSandbox, 'seedUsers');
    try {
      applyUsers(sandbox, [
        { uid: 'anon-1', providerId: 'anonymous', customClaims: { guest: true } },
        { uid: 'anon-explicit', providerId: 'anonymous', email: 'explicit@example.com', password: 'secret' },
        { uid: 'member-1' },
      ]);

      expect(seedSpy).toHaveBeenCalledTimes(1);
      const passedRecords = seedSpy.mock.calls[0]?.[1] ?? [];
      expect(passedRecords[0]).toEqual({
        uid: 'anon-1',
        providerId: 'anonymous',
        customClaims: { guest: true },
      });
      expect(Object.hasOwn(passedRecords[0] ?? {}, 'email')).toBe(false);
      expect(Object.hasOwn(passedRecords[0] ?? {}, 'password')).toBe(false);

      expect(passedRecords[1]).toEqual({
        uid: 'anon-explicit',
        providerId: 'anonymous',
        email: 'explicit@example.com',
        password: 'secret',
      });

      expect(passedRecords[2]).toEqual({
        uid: 'member-1',
        email: 'member-1@pyric.invalid',
        password: 'seed-member-1',
      });
    } finally {
      seedSpy.mockRestore();
    }

    const exported = authSandbox.exportUsers(getAuth(sandbox));
    const anon1 = exported.find((u) => u.uid === 'anon-1');
    expect(anon1?.providerId).toBe('anonymous');
    expect(anon1?.email).toBeUndefined();
    expect(anon1?.password).toBeUndefined();
    expect(anon1?.customClaims).toEqual({ guest: true });

    const source = initializeSandbox();
    const { user: liveAnon } = await signInAnonymously(getAuth(source));
    const fixture = await buildFixture(source);
    const target = initializeSandbox();
    await applyFixture(target, fixture);
    const roundTripped = authSandbox.listUsers(getAuth(target)).find((u) => u.uid === liveAnon.uid);
    expect(roundTripped?.isAnonymous).toBe(true);
    expect(roundTripped?.email).toBeNull();
    expect(roundTripped?.providerUserInfo).toEqual([]);
  });

  it('captures syntax refusals from applyRules without throwing', async () => {
    const sandbox = initializeSandbox();
    const refusals = await applyRules(sandbox, {
      firestoreRules: 'rules_version = "2"; invalid {{{',
      databaseRules: JSON.stringify({ rules: { '.read': 'auth &&&' } }),
      storageRules: 'service firebase.storage { invalid {{{ }',
    });
    expect(refusals).toHaveLength(3);
  });

  it('applies Firestore rich values, Realtime Database priority nodes, and Storage objects', async () => {
    const sandbox = initializeSandbox();
    await applyRules(sandbox, {
      storageRules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} { allow read, write: if true; }
  }
}`,
    });
    await applyData(sandbox, {
      users: [
        {
          uid: 'user-1',
          email: 'user@example.com',
          password: 'password-1',
          emailVerified: true,
          displayName: 'User One',
          disabled: false,
          tenantId: 'org-a',
        },
      ],
      firestore: {
        'items/item-1': {
          createdAt: new Timestamp(1700000000, 500).toJSON(),
          coords: new GeoPoint(40.0, -74.0).toJSON(),
          payload: Bytes.fromUint8Array(new Uint8Array([9, 8, 7])).toJSON(),
          owner: { __type: 'reference', path: 'users/user-1' },
        },
      },
      database: {
        orgs: {
          'org-1': { '.value': 'active', '.priority': 5 },
        },
      },
      storage: [
        {
          path: 'docs/readme.txt',
          contentBase64: Buffer.from('hello world', 'utf8').toString('base64'),
          contentType: 'text/plain',
          customMetadata: { version: '1' },
        },
      ],
    });

    const fsSnap = await getDoc(doc(getAdminFirestore(sandbox), 'items/item-1'));
    const data = fsSnap.data()!;
    expect(data.createdAt).toBeInstanceOf(Timestamp);
    expect(data.coords).toBeInstanceOf(GeoPoint);
    expect(data.payload).toBeInstanceOf(Bytes);
    expect((data.owner as { path?: string }).path).toBe('users/user-1');

    const rtdbSnap = await dbGet(dbRef(getAdminDatabase(sandbox), 'orgs/org-1'));
    expect(rtdbSnap.val()).toBe('active');
    expect(rtdbSnap.priority).toBe(5);

    const objRef = storageRef(getAdminStorageSandbox(sandbox), 'docs/readme.txt');
    const bytes = await getBytes(objRef);
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello world');
    const meta = await getMetadata(objRef);
    expect(meta.contentType).toBe('text/plain');
    expect(meta.customMetadata).toEqual({ version: '1' });
  });
});
