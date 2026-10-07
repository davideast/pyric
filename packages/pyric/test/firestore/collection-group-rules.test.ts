/**
 * Collection-group reads under the rule shape Firebase documents for them:
 * `match /{path=**}/<collectionId>/{id}` with `rules_version = '2'`.
 *
 * The recursive segment matches zero or more leading segments, so the rule
 * governs every collection with that id at any depth, and a collection-group
 * query on that id is authorized by it. Direct document reads resolve the
 * same block. Production verdicts for the matcher are recorded in the
 * `recursive-wildcard-placement` rules corpus scenario.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import {
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  setDoc,
  where,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

const SEED = {
  'users/u1/items/a': { owner: 'u1', visibility: 'public' },
  'users/u2/items/b': { owner: 'u2', visibility: 'private' },
  'items/c': { owner: 'root', visibility: 'public' },
  'users/u1/other/d': { owner: 'u1', visibility: 'public' },
};

function setup(rules: string, uid: string | null) {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, SEED);
  setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${rules}
  }
}`);
  const db = getFirestore(uid ? sandbox.withAuth({ uid }) : sandbox.withAuth(null));
  return { sandbox, db };
}

const SIGNED_IN_ITEMS = 'match /{path=**}/items/{id} { allow read: if request.auth != null; }';

describe('collection-group query under match /{path=**}/<collectionId>/{id}', () => {
  it('authorizes the query and returns every items document at any depth', async () => {
    const { db } = setup(SIGNED_IN_ITEMS, 'alice');
    const snap = await getDocs(collectionGroup(db, 'items'));
    expect(snap.docs.map((d) => d.ref.path).sort()).toEqual([
      'items/c',
      'users/u1/items/a',
      'users/u2/items/b',
    ]);
  });

  it('denies the query when the rule condition is false for the request', async () => {
    const { db } = setup(SIGNED_IN_ITEMS, null);
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('reads a document directly through the same rule, at the root and nested', async () => {
    const { db } = setup(SIGNED_IN_ITEMS, 'alice');
    expect((await getDoc(doc(db, 'users/u1/items/a'))).exists()).toBe(true);
    expect((await getDoc(doc(db, 'items/c'))).exists()).toBe(true);
    await expect(getDoc(doc(db, 'users/u1/other/d'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('proves a data-gated rule against the query constraints', async () => {
    const { db } = setup(
      "match /{path=**}/items/{id} { allow list: if resource.data.visibility == 'public'; }",
      null,
    );
    const pub = await getDocs(query(collectionGroup(db, 'items'), where('visibility', '==', 'public')));
    expect(pub.docs.map((d) => d.ref.path).sort()).toEqual(['items/c', 'users/u1/items/a']);
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('does not authorize a group query from a rule for another collection id', async () => {
    const { db } = setup('match /{path=**}/other/{id} { allow read: if true; }', 'alice');
    const error = await getDocs(collectionGroup(db, 'items')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'permission-denied' });
    expect(String((error as Error).message)).toContain('match /{path=**}/items/{id}');
  });

  it('does not authorize a group query from a rule that reads the recursive binding', async () => {
    const { db } = setup("match /{path=**}/items/{id} { allow read: if path == 'users/u1'; }", 'alice');
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('does not authorize a group query from concrete collection rules', async () => {
    const { db } = setup(`
    match /items/{id} { allow read: if true; }
    match /users/{uid}/items/{id} { allow read: if true; }`, 'alice');
    await expect(getDocs(collectionGroup(db, 'items'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

const LISTEN_RULES = `
    match /{path=**}/items/{id} { allow read, write: if request.auth != null; }
    match /users/{uid}/other/{id} { allow read, write: if request.auth != null; }`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function paths(snap: QuerySnapshot): string[] {
  return snap.docs.map((d) => d.ref.path).sort();
}

function changes(snap: QuerySnapshot): string[] {
  return snap.docChanges().map((c) => `${c.type} ${c.doc.ref.path}`);
}

describe('collection-group listener under match /{path=**}/<collectionId>/{id}', () => {
  it('delivers the initial snapshot, then writes to any items collection, and nothing for a sibling collection', async () => {
    const { db } = setup(LISTEN_RULES, 'alice');
    const snaps: QuerySnapshot[] = [];
    const errors: unknown[] = [];
    const stop = onSnapshot(collectionGroup(db, 'items'), (s) => snaps.push(s as QuerySnapshot), (e) => errors.push(e));
    try {
      await settle();
      expect(errors).toEqual([]);
      expect(snaps).toHaveLength(1);
      expect(paths(snaps[0]!)).toEqual(['items/c', 'users/u1/items/a', 'users/u2/items/b']);

      await setDoc(doc(db, 'users/u1/items/n1'), { owner: 'u1' });
      await settle();
      expect(snaps).toHaveLength(2);
      expect(changes(snaps[1]!)).toEqual(['added users/u1/items/n1']);

      await setDoc(doc(db, 'items/n2'), { owner: 'root' });
      await settle();
      expect(snaps).toHaveLength(3);
      expect(changes(snaps[2]!)).toEqual(['added items/n2']);

      await setDoc(doc(db, 'users/u1/other/n3'), { owner: 'u1' });
      await settle();
      expect(snaps).toHaveLength(3);
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });

  it('routes a denial to the error callback without throwing', async () => {
    const { db } = setup(LISTEN_RULES, null);
    const errors: unknown[] = [];
    let fires = 0;
    const stop = onSnapshot(collectionGroup(db, 'items'), () => fires++, (e) => errors.push(e));
    try {
      await settle();
      expect(fires).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: 'permission-denied' });
    } finally {
      stop();
    }
  });

  it('denies a listener that concrete collection rules do not authorize as a group', async () => {
    const { db } = setup(`
    match /items/{id} { allow read: if true; }
    match /users/{uid}/items/{id} { allow read: if true; }`, 'alice');
    const errors: unknown[] = [];
    const stop = onSnapshot(collectionGroup(db, 'items'), () => {}, (e) => errors.push(e));
    try {
      await settle();
      expect(errors).toHaveLength(1);
      expect(String((errors[0] as Error).message)).toContain('match /{path=**}/items/{id}');
    } finally {
      stop();
    }
  });

  it('applies query constraints to the delivered documents', async () => {
    const { db } = setup(LISTEN_RULES, 'alice');
    const snaps: QuerySnapshot[] = [];
    const stop = onSnapshot(
      query(collectionGroup(db, 'items'), where('visibility', '==', 'public')),
      (s) => snaps.push(s as QuerySnapshot),
    );
    try {
      await settle();
      expect(paths(snaps[0]!)).toEqual(['items/c', 'users/u1/items/a']);
      await setDoc(doc(db, 'users/u9/items/z'), { visibility: 'private' });
      await settle();
      expect(snaps).toHaveLength(1);
      await setDoc(doc(db, 'users/u9/items/y'), { visibility: 'public' });
      await settle();
      expect(changes(snaps[1]!)).toEqual(['added users/u9/items/y']);
    } finally {
      stop();
    }
  });
});
