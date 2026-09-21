/**
 * `withConverter` as an INSTANCE method on collection and query values.
 *
 * The free `withConverter(ref, converter)` function is covered by
 * `sandbox-target.test.ts`. Firebase also exposes `.withConverter()` on
 * `CollectionReference`, `Query`, and `collectionGroup()` results, and the
 * converter a typed collection carries must reach every value derived from
 * it — except a subcollection, which describes different documents.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  doc,
  collection,
  collectionGroup,
  query,
  where,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  onSnapshot,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

interface UserDb {
  name: string;
  createdAtIso: string;
}
interface User {
  name: string;
  createdAt: Date;
}

const userConverter = {
  toFirestore: (u: User): UserDb => ({
    name: u.name,
    createdAtIso: u.createdAt.toISOString(),
  }),
  fromFirestore: (snap: { data(): UserDb }): User => {
    const d = snap.data();
    return { name: d.name, createdAt: new Date(d.createdAtIso) };
  },
};

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
  return { sandbox, db };
}

const WHEN = new Date('2026-05-01T12:00:00.000Z');

describe('CollectionReference.withConverter', () => {
  it('is an instance method on the value collection() returns', () => {
    const { db } = setup();
    expect(typeof collection(db, 'users').withConverter).toBe('function');
  });

  it('propagates onto doc(typedColl, id) for writes and reads', async () => {
    const { sandbox, db } = setup();
    const users = collection(db, 'users').withConverter(userConverter);
    const u1 = doc(users, 'u1');
    await setDoc(u1, { name: 'Alice', createdAt: WHEN });
    expect(snapshotDocuments(sandbox)['users/u1']).toEqual({
      name: 'Alice',
      createdAtIso: WHEN.toISOString(),
    });
    const snap = await getDoc(u1);
    expect(snap.data()?.createdAt).toBeInstanceOf(Date);
    expect(snap.data()?.createdAt.toISOString()).toBe(WHEN.toISOString());
  });

  it('propagates onto doc(typedColl) with no path segment', async () => {
    const { db } = setup();
    const users = collection(db, 'users').withConverter(userConverter);
    const minted = doc(users);
    expect(minted.id).toHaveLength(20);
    await setDoc(minted, { name: 'Minted', createdAt: WHEN });
    const snap = await getDoc(minted);
    expect(snap.data()?.createdAt).toBeInstanceOf(Date);
  });

  it('propagates through query() + getDocs()', async () => {
    const { db } = setup();
    const users = collection(db, 'users').withConverter(userConverter);
    await setDoc(doc(users, 'a'), { name: 'A', createdAt: WHEN });
    await setDoc(doc(users, 'b'), { name: 'B', createdAt: WHEN });
    const snap = await getDocs(query(users, where('name', '==', 'B')));
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().createdAt).toBeInstanceOf(Date);
  });

  it('propagates through addDoc()', async () => {
    const { db } = setup();
    const users = collection(db, 'users').withConverter(userConverter);
    const ref = await addDoc(users, { name: 'Carol', createdAt: WHEN });
    const snap = await getDoc(ref);
    expect(snap.data()?.name).toBe('Carol');
    expect(snap.data()?.createdAt).toBeInstanceOf(Date);
  });

  it('propagates through onSnapshot() on the typed collection', async () => {
    const { db } = setup();
    const users = collection(db, 'users').withConverter(userConverter);
    await setDoc(doc(users, 'a'), { name: 'A', createdAt: WHEN });
    const seen: unknown[] = [];
    const stop = onSnapshot(users, (snap) => {
      seen.push(...(snap as QuerySnapshot<User>).docs.map((d) => d.data().createdAt));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeInstanceOf(Date);
  });

  it('withConverter(null) removes the converter', async () => {
    const { db } = setup();
    const users = collection(db, 'users').withConverter(userConverter);
    await setDoc(doc(users, 'a'), { name: 'A', createdAt: WHEN });
    const untyped = users.withConverter(null);
    const snap = await getDoc(doc(untyped, 'a'));
    expect((snap.data() as UserDb | undefined)?.createdAtIso).toBe(WHEN.toISOString());
  });

  it('does not propagate into a subcollection of a typed document', async () => {
    const { db } = setup();
    const users = collection(db, 'users').withConverter(userConverter);
    const posts = collection(doc(users, 'u1'), 'posts');
    await setDoc(doc(posts, 'p1'), { title: 'raw' });
    const snap = await getDoc(doc(posts, 'p1'));
    expect(snap.data()).toEqual({ title: 'raw' });
  });
});

describe('Query.withConverter', () => {
  it('is an instance method on the value query() returns', () => {
    const { db } = setup();
    expect(typeof query(collection(db, 'users')).withConverter).toBe('function');
  });

  it('converts the documents getDocs() yields', async () => {
    const { db } = setup();
    const users = collection(db, 'users');
    await setDoc(doc(users, 'a'), { name: 'A', createdAtIso: WHEN.toISOString() });
    const typed = query(users, where('name', '==', 'A')).withConverter(userConverter);
    const snap = await getDocs(typed);
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().createdAt).toBeInstanceOf(Date);
  });

  it('withConverter(null) removes the converter', async () => {
    const { db } = setup();
    const users = collection(db, 'users');
    await setDoc(doc(users, 'a'), { name: 'A', createdAtIso: WHEN.toISOString() });
    const typed = query(users).withConverter(userConverter);
    const snap = await getDocs(typed.withConverter(null));
    expect((snap.docs[0]!.data() as UserDb).createdAtIso).toBe(WHEN.toISOString());
  });
});

describe('collectionGroup().withConverter', () => {
  it('is an instance method on the value collectionGroup() returns', () => {
    const { db } = setup();
    expect(typeof collectionGroup(db, 'posts').withConverter).toBe('function');
  });

  it('converts the documents getDocs() yields across collections', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'users/u1/posts/p1'), { name: 'A', createdAtIso: WHEN.toISOString() });
    await setDoc(doc(db, 'teams/t1/posts/p2'), { name: 'B', createdAtIso: WHEN.toISOString() });
    const posts = collectionGroup(db, 'posts').withConverter(userConverter);
    const snap = await getDocs(posts);
    expect(snap.size).toBe(2);
    for (const item of snap.docs) expect(item.data().createdAt).toBeInstanceOf(Date);
  });
});
