import { afterEach, describe, expect, test } from 'bun:test';
import { deleteApp, getApps } from '../../src/app/index.js';
import { getFirestore, onSnapshot, Timestamp } from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each([
  ['in-process', inProcessFirestoreArm],
  ['shared-worker remote', sharedWorkerFirestoreArm],
])('pyric-admin/firestore snapshot immutability ($0)', (_label, makeArm) => {
  test('mutating DocumentSnapshot.data(), get(), or QueryDocumentSnapshot.data() does not alias subsequent reads', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const createdAt = Timestamp.fromMillis(1_700_000_000_000);

    await db.doc('users/u1').set({
      profile: { role: 'viewer', flags: ['read'] },
      createdAt,
    });

    const docSnap = await db.doc('users/u1').get();
    const docData = docSnap.data() as { profile: { role: string; flags: string[] }; createdAt: Timestamp };
    docData.profile.role = 'tampered';
    docData.profile.flags.push('write');

    expect(docSnap.data()).toEqual({
      profile: { role: 'viewer', flags: ['read'] },
      createdAt,
    });
    expect(docSnap.get('profile.role')).toBe('viewer');
    expect((docSnap.data() as { createdAt: unknown }).createdAt).toBeInstanceOf(Timestamp);

    const profileFromGet = docSnap.get('profile') as { role: string };
    profileFromGet.role = 'tampered-via-get';
    expect(docSnap.get('profile.role')).toBe('viewer');

    const querySnap = await db.collection('users').get();
    const queryDoc = querySnap.docs[0]!;
    const queryData = queryDoc.data() as { profile: { role: string } };
    queryData.profile.role = 'tampered-query';

    expect(queryDoc.data()?.profile).toEqual({ role: 'viewer', flags: ['read'] });
    expect(queryDoc.get('profile.role')).toBe('viewer');
  });

  test('mutating LiveDocumentSnapshot.data() and LiveQuerySnapshot doc.data() in onSnapshot does not alias subsequent reads', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    await db.doc('users/u1').set({ profile: { role: 'viewer' } });

    const docSnaps: Array<{ data(): unknown; get(fp: string): unknown }> = [];
    const unsubDoc = onSnapshot(db.doc('users/u1'), (snap) => {
      docSnaps.push(snap);
    });

    const querySnaps: Array<{ docs: Array<{ data(): unknown; get(fp: string): unknown }> }> = [];
    const unsubQuery = onSnapshot(db.collection('users'), (snap) => {
      querySnaps.push(snap);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    unsubDoc();
    unsubQuery();

    const liveDoc = docSnaps[0]!;
    (liveDoc.data() as { profile: { role: string } }).profile.role = 'tampered-live-doc';
    expect((liveDoc.data() as { profile: { role: string } }).profile.role).toBe('viewer');
    expect(liveDoc.get('profile.role')).toBe('viewer');

    const liveQueryDoc = querySnaps[0]!.docs[0]!;
    (liveQueryDoc.data() as { profile: { role: string } }).profile.role = 'tampered-live-query';
    expect((liveQueryDoc.data() as { profile: { role: string } }).profile.role).toBe('viewer');
    expect(liveQueryDoc.get('profile.role')).toBe('viewer');
  });
});
