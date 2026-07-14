/**
 * Upstream-mined modular probes (clusters 6–8).
 *
 *   6. Transform edges — arrayUnion/Remove via merge, object members,
 *      increment int↔double / on serverTimestamp, batch increment across docs
 *      (same-field double-increment in one batch and DocumentReference
 *      arrayUnion members are deferred gaps — last-write-wins / read-translation
 *      cycle respectively)
 *   7. Modular transaction breadth — replace set, get missing/deleted,
 *      empty txn, read-after-write abort, nested update
 *      (`tx.set(..., { merge })` not wired — deferred)
 *   8. QuerySnapshot.docChanges() type + indexes on modular onSnapshot
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  writeBatch,
  arrayUnion,
  arrayRemove,
  increment,
  serverTimestamp,
  Timestamp,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, OPEN_RULES);
  return { sandbox, db, env: getInternalEnv(sandbox) };
}

// ─── Cluster 6: transform edges ────────────────────────────────────────

describe('transform edges (upstream sentinel probes)', () => {
  it('arrayUnion via set(..., { merge: true })', async () => {
    const { sandbox, db } = setup();
    await setDoc(doc(db, 'items/a'), { tags: ['a'] });
    await setDoc(doc(db, 'items/a'), { tags: arrayUnion('b', 'a') }, { merge: true });
    expect(snapshotDocuments(sandbox)['items/a']).toEqual({ tags: ['a', 'b'] });
  });

  it('arrayRemove via set(..., { merge: true })', async () => {
    const { sandbox, db } = setup();
    await setDoc(doc(db, 'items/a'), { tags: ['a', 'b', 'c'] });
    await setDoc(doc(db, 'items/a'), { tags: arrayRemove('b') }, { merge: true });
    expect(snapshotDocuments(sandbox)['items/a']).toEqual({ tags: ['a', 'c'] });
  });

  it('arrayUnion of objects via update', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'items/a'), { tags: [{ x: 1 }] });
    await updateDoc(doc(db, 'items/a'), { tags: arrayUnion({ x: 2 }) });
    const snap = await getDoc(doc(db, 'items/a'));
    expect(snap.data()!.tags).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('increment on missing doc via set merge creates the field', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'counters/c1'), { count: increment(5) }, { merge: true });
    const snap = await getDoc(doc(db, 'counters/c1'));
    expect(snap.data()!.count).toBe(5);
  });

  it('increment int over double and double over int', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'counters/c1'), { count: 1.5 });
    await updateDoc(doc(db, 'counters/c1'), { count: increment(2) });
    expect((await getDoc(doc(db, 'counters/c1'))).data()!.count).toBe(3.5);
    await updateDoc(doc(db, 'counters/c1'), { count: increment(0.5) });
    expect((await getDoc(doc(db, 'counters/c1'))).data()!.count).toBe(4);
  });

  it('increment across two docs in one batch', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'counters/c1'), { count: 0 });
    await setDoc(doc(db, 'counters/c2'), { count: 10 });
    const batch = writeBatch(db);
    batch.update(doc(db, 'counters/c1'), { count: increment(3) });
    batch.update(doc(db, 'counters/c2'), { count: increment(2) });
    await batch.commit();
    expect((await getDoc(doc(db, 'counters/c1'))).data()!.count).toBe(3);
    expect((await getDoc(doc(db, 'counters/c2'))).data()!.count).toBe(12);
  });

  it('increment after serverTimestamp overwrites with a number', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'counters/c1'), { count: serverTimestamp() });
    expect((await getDoc(doc(db, 'counters/c1'))).data()!.count).toBeInstanceOf(Timestamp);
    await updateDoc(doc(db, 'counters/c1'), { count: increment(1) });
    // FS-B11 / prod: increment on non-number overwrites with the increment operand.
    expect((await getDoc(doc(db, 'counters/c1'))).data()!.count).toBe(1);
  });
});

// ─── Cluster 7: modular transaction breadth ────────────────────────────

describe('modular transaction breadth (upstream txn probes)', () => {
  it('transaction set replaces the document', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'docs/d1'), { a: 1, b: 2 });
    await runTransaction(db, async (tx) => {
      tx.set(doc(db, 'docs/d1'), { b: 9, c: 3 });
    });
    expect((await getDoc(doc(db, 'docs/d1'))).data()).toEqual({ b: 9, c: 3 });
  });

  it('transaction get nonexistent then set', async () => {
    const { db } = setup();
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'docs/missing'));
      expect(snap.data()).toBeUndefined();
      tx.set(doc(db, 'docs/missing'), { v: 1 });
    });
    expect((await getDoc(doc(db, 'docs/missing'))).data()).toEqual({ v: 1 });
  });

  it('transaction get deleted doc then set', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'docs/d1'), { v: 1 });
    await deleteDoc(doc(db, 'docs/d1'));
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'docs/d1'));
      expect(snap.data()).toBeUndefined();
      tx.set(doc(db, 'docs/d1'), { v: 2 });
    });
    expect((await getDoc(doc(db, 'docs/d1'))).data()).toEqual({ v: 2 });
  });

  it('empty transaction succeeds', async () => {
    const { db } = setup();
    await expect(runTransaction(db, async () => {})).resolves.toBeUndefined();
  });

  it('read after write in the same transaction throws', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'docs/d1'), { v: 1 });
    let err: unknown;
    try {
      await runTransaction(db, async (tx) => {
        tx.set(doc(db, 'docs/d1'), { v: 2 });
        await tx.get(doc(db, 'docs/d1'));
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
  });

  it('transaction update nested fields', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'docs/d1'), { owner: { name: 'A', email: 'a@x' } });
    await runTransaction(db, async (tx) => {
      tx.update(doc(db, 'docs/d1'), { 'owner.name': 'B' });
    });
    expect((await getDoc(doc(db, 'docs/d1'))).data()).toEqual({
      owner: { name: 'B', email: 'a@x' },
    });
  });
});

// ─── Cluster 8: docChanges indexes (modular onSnapshot) ────────────────

describe('docChanges indexes (upstream listener probes)', () => {
  it('maintains added / modified / removed with indexes', async () => {
    const { db, env } = setup();
    await setDoc(doc(db, 'widgets/a'), { n: 1 });
    await setDoc(doc(db, 'widgets/b'), { n: 2 });

    const snaps: QuerySnapshot[] = [];
    const unsub = onSnapshot(
      collection(db, 'widgets'),
      (snap) => {
        snaps.push(snap);
      },
    );
    env.flushListeners();
    expect(snaps).toHaveLength(1);
    const initial = snaps[0]!.docChanges();
    expect(initial.every((c) => c.type === 'added')).toBe(true);
    expect(initial.every((c) => c.oldIndex === -1)).toBe(true);
    expect(initial.map((c) => c.newIndex).sort()).toEqual([0, 1]);

    await setDoc(doc(db, 'widgets/c'), { n: 3 });
    env.flushListeners();
    const afterAdd = snaps[snaps.length - 1]!.docChanges();
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd[0]!.type).toBe('added');
    expect(afterAdd[0]!.doc.id).toBe('c');
    expect(afterAdd[0]!.oldIndex).toBe(-1);
    expect(afterAdd[0]!.newIndex).toBeGreaterThanOrEqual(0);

    await updateDoc(doc(db, 'widgets/a'), { n: 9 });
    env.flushListeners();
    const afterMod = snaps[snaps.length - 1]!.docChanges();
    expect(afterMod).toHaveLength(1);
    expect(afterMod[0]!.type).toBe('modified');
    expect(afterMod[0]!.doc.id).toBe('a');
    expect(afterMod[0]!.oldIndex).toBeGreaterThanOrEqual(0);
    expect(afterMod[0]!.newIndex).toBe(afterMod[0]!.oldIndex);

    await deleteDoc(doc(db, 'widgets/b'));
    env.flushListeners();
    const afterDel = snaps[snaps.length - 1]!.docChanges();
    expect(afterDel).toHaveLength(1);
    expect(afterDel[0]!.type).toBe('removed');
    expect(afterDel[0]!.doc.id).toBe('b');
    expect(afterDel[0]!.oldIndex).toBeGreaterThanOrEqual(0);
    expect(afterDel[0]!.newIndex).toBe(-1);

    unsub();
  });
});
