/**
 * Upstream-mined modular probes (clusters 4–5).
 *
 * Sourced from firebase-js-sdk integration/api database.test.ts +
 * aggregation.test.ts against claimed COMPAT rows with thin modular
 * evidence:
 *   4. mergeFields mask edges (delete/transform outside mask, empty
 *      mask, dotted paths, empty-object merge)
 *   5. Aggregates on nested map paths + collection groups
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  collection,
  collectionGroup,
  doc,
  setDoc,
  getDoc,
  getCountFromServer,
  getAggregateFromServer,
  count,
  sum,
  average,
  deleteField,
  serverTimestamp,
  Timestamp,
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
  return { sandbox, db };
}

// ─── Cluster 4: mergeFields mask edges ─────────────────────────────────

describe('mergeFields mask edges (upstream write probes)', () => {
  it('ignores deleteField outside the mask', async () => {
    const { sandbox, db } = setup();
    await setDoc(doc(db, 'docs/d1'), {
      desc: 'Description',
      owner: { name: 'Jonny', email: 'abc@xyz.com' },
    });
    await setDoc(
      doc(db, 'docs/d1'),
      { desc: deleteField(), owner: 'Sebastian' },
      { mergeFields: ['owner'] },
    );
    expect(snapshotDocuments(sandbox)['docs/d1']).toEqual({
      desc: 'Description',
      owner: 'Sebastian',
    });
  });

  it('ignores serverTimestamp outside the mask', async () => {
    const { sandbox, db } = setup();
    await setDoc(doc(db, 'docs/d1'), {
      desc: 'Description',
      owner: { name: 'Jonny', email: 'abc@xyz.com' },
    });
    await setDoc(
      doc(db, 'docs/d1'),
      { desc: serverTimestamp(), owner: 'Sebastian' },
      { mergeFields: ['owner'] },
    );
    const data = snapshotDocuments(sandbox)['docs/d1'];
    expect(data).toEqual({
      desc: 'Description',
      owner: 'Sebastian',
    });
  });

  it('empty mergeFields is a no-op write', async () => {
    const { sandbox, db } = setup();
    const initial = {
      desc: 'Description',
      owner: { name: 'Jonny', email: 'abc@xyz.com' },
    };
    await setDoc(doc(db, 'docs/d1'), initial);
    await setDoc(
      doc(db, 'docs/d1'),
      { desc: 'NewDescription', owner: 'Sebastian' },
      { mergeFields: [] },
    );
    expect(snapshotDocuments(sandbox)['docs/d1']).toEqual(initial);
  });

  it('dotted mergeFields reach into nested maps', async () => {
    const { sandbox, db } = setup();
    await setDoc(doc(db, 'docs/d1'), {
      desc: 'Description',
      owner: { name: 'Jonny', email: 'abc@xyz.com' },
    });
    await setDoc(
      doc(db, 'docs/d1'),
      { owner: { name: 'Sebastian', email: 'new@xyz.com' } },
      { mergeFields: ['owner.name'] },
    );
    expect(snapshotDocuments(sandbox)['docs/d1']).toEqual({
      desc: 'Description',
      owner: { name: 'Sebastian', email: 'abc@xyz.com' },
    });
  });

  it('deleteField inside the mask removes that field', async () => {
    const { sandbox, db } = setup();
    await setDoc(doc(db, 'docs/d1'), {
      desc: 'Description',
      owner: 'Jonny',
    });
    await setDoc(
      doc(db, 'docs/d1'),
      { desc: deleteField(), owner: 'Sebastian' },
      { mergeFields: ['desc', 'owner'] },
    );
    expect(snapshotDocuments(sandbox)['docs/d1']).toEqual({
      owner: 'Sebastian',
    });
  });

  it('merge:true with empty object preserves existing fields', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'docs/d1'), { a: 1, b: 2 });
    await setDoc(doc(db, 'docs/d1'), {}, { merge: true });
    const snap = await getDoc(doc(db, 'docs/d1'));
    expect(snap.data()).toEqual({ a: 1, b: 2 });
  });

  it('serverTimestamp inside mergeFields resolves', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'docs/d1'), { title: 't', updatedAt: null });
    await setDoc(
      doc(db, 'docs/d1'),
      { title: 'ignored', updatedAt: serverTimestamp() },
      { mergeFields: ['updatedAt'] },
    );
    const snap = await getDoc(doc(db, 'docs/d1'));
    expect(snap.data()!.title).toBe('t');
    expect(snap.data()!.updatedAt).toBeInstanceOf(Timestamp);
  });
});

// ─── Cluster 5: aggregates nested + collection group ───────────────────

describe('aggregates nested paths + collection groups (upstream agg probes)', () => {
  it('sum/average walk dotted nested map paths', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'books/a'), { metadata: { pages: 100 }, title: 'A' });
    await setDoc(doc(db, 'books/b'), { metadata: { pages: 50 }, title: 'B' });
    await setDoc(doc(db, 'books/c'), { metadata: { pages: 'n/a' }, title: 'C' });
    const snap = await getAggregateFromServer(collection(db, 'books'), {
      totalPages: sum('metadata.pages'),
      avgPages: average('metadata.pages'),
      n: count(),
    });
    expect(snap.data()).toEqual({
      totalPages: 150,
      avgPages: 75,
      n: 3,
    });
  });

  it('getCountFromServer works on collectionGroup', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'items/A'), { n: 1 });
    await setDoc(doc(db, 'parents/P/items/B'), { n: 2 });
    await setDoc(doc(db, 'orgs/O/items/C'), { n: 3 });
    const snap = await getCountFromServer(collectionGroup(db, 'items'));
    expect(snap.data()).toEqual({ count: 3 });
  });

  it('getAggregateFromServer sum works on collectionGroup', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'items/A'), { n: 1 });
    await setDoc(doc(db, 'parents/P/items/B'), { n: 2 });
    await setDoc(doc(db, 'orgs/O/items/C'), { n: 10 });
    const snap = await getAggregateFromServer(collectionGroup(db, 'items'), {
      total: sum('n'),
      n: count(),
    });
    expect(snap.data()).toEqual({ total: 13, n: 3 });
  });

  it('sum skips non-numeric nested values', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'books/a'), { metadata: { pages: 10 } });
    await setDoc(doc(db, 'books/b'), { metadata: { pages: null } });
    await setDoc(doc(db, 'books/c'), { metadata: {} });
    const snap = await getAggregateFromServer(collection(db, 'books'), {
      total: sum('metadata.pages'),
    });
    expect(snap.data()).toEqual({ total: 10 });
  });
});
