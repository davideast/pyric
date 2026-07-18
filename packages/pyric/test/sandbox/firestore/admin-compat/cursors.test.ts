/**
 * `Query.startCursor` / `Query.endCursor` / `Query.limitToLast` —
 * Tier 3 / v1 scope-survey gap.
 *
 * Pins:
 *   - startCursor inclusive (startAt) vs exclusive (startAfter)
 *   - endCursor inclusive (endAt) vs exclusive (endBefore)
 *   - Cursors respect orderBy direction (asc + desc)
 *   - Multi-field cursors compare lexicographically across the
 *     orderBy fields
 *   - limitToLast reverses + slices + re-orders so the result still
 *     reads in the original orderBy direction
 *   - VALUE cursors throw when they carry more values than orderBy
 *     clauses (FS-B8 / upstream `boundFromFields`); SNAPSHOT cursors are
 *     legal without an explicit orderBy (implicit `__name__` key)
 *   - limitToLast throws without orderBy
 *   - CollectionGroup queries inherit the cursor + limitToLast
 *     plumbing via the shared `clone()` hook
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { FirestoreImpl } from '../../../../src/firestore/sandbox/admin-compat/firestore.js';

const RULES_AUTH_OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function setup(): FirestoreImpl {
  const env = new LocalEnvironment();
  env.deployRules(RULES_AUTH_OPEN);
  env.seed({
    rules: RULES_AUTH_OPEN,
    documents: {
      'tickets/T-1': { priority: 1, status: 'open' },
      'tickets/T-2': { priority: 2, status: 'open' },
      'tickets/T-3': { priority: 3, status: 'closed' },
      'tickets/T-4': { priority: 4, status: 'open' },
      'tickets/T-5': { priority: 5, status: 'open' },
    },
  });
  return new FirestoreImpl(env, { uid: 'alice', token: {} });
}

describe('startCursor / endCursor (single orderBy)', () => {
  it('startAt is inclusive', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .startCursor([3], true)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([3, 4, 5]);
  });

  it('startAfter is exclusive', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .startCursor([3], false)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });

  it('endAt is inclusive', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .endCursor([3], true)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2, 3]);
  });

  it('endBefore is exclusive', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .endCursor([3], false)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2]);
  });

  it('honors desc orderBy — start/end are relative to the ORDERED position', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority', 'desc')
      .startCursor([3], true)
      .get();
    // Descending → start at priority=3 yields [3, 2, 1].
    expect(snap.docs.map((d) => d.data().priority)).toEqual([3, 2, 1]);
  });

  it('start + end compose to a slice', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .startCursor([2], true)
      .endCursor([4], true)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([2, 3, 4]);
  });
});

describe('multi-field cursors', () => {
  function setupMulti(): FirestoreImpl {
    const env = new LocalEnvironment();
    env.deployRules(RULES_AUTH_OPEN);
    env.seed({
      rules: RULES_AUTH_OPEN,
      documents: {
        'q/A': { p: 1, t: 10 },
        'q/B': { p: 1, t: 20 },
        'q/C': { p: 1, t: 30 },
        'q/D': { p: 2, t: 5 },
        'q/E': { p: 2, t: 15 },
        'q/F': { p: 3, t: 25 },
      },
    });
    return new FirestoreImpl(env, { uid: 'alice', token: {} });
  }

  it('starts at the lexicographic position of the cursor values', async () => {
    const db = setupMulti();
    const snap = await db
      .collection('q')
      .orderBy('p')
      .orderBy('t')
      .startCursor([1, 20], true)
      .get();
    // Sorted: (1,10) (1,20) (1,30) (2,5) (2,15) (3,25)
    // startAt (1,20) inclusive → from index 1 onward.
    expect(snap.docs.map((d) => `${d.data().p}-${d.data().t}`))
      .toEqual(['1-10', '1-20', '1-30', '2-5', '2-15', '3-25'].slice(1));
  });

  it('shorter cursor than orderBy is a prefix match', async () => {
    const db = setupMulti();
    const snap = await db
      .collection('q')
      .orderBy('p')
      .orderBy('t')
      .startCursor([2], true) // only p — t left unconsulted
      .get();
    // (2,5) (2,15) (3,25)
    expect(snap.docs.map((d) => `${d.data().p}-${d.data().t}`))
      .toEqual(['2-5', '2-15', '3-25']);
  });
});

describe('limitToLast', () => {
  it('takes the trailing n in the ordering', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .limitToLast(2)
      .get();
    // Full order: 1 2 3 4 5. Last 2: 4, 5.
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });

  it('composes with where', async () => {
    const db = setup();
    const snap = await db
      .collection('tickets')
      .where('status', '==', 'open')
      .orderBy('priority')
      .limitToLast(2)
      .get();
    // open docs sorted by priority: 1, 2, 4, 5 → last 2: 4, 5
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });
});

describe('runtime contracts', () => {
  it('VALUE cursors with more values than orderBy clauses throw at get-time (FS-B8)', async () => {
    // A value cursor positions against the EXPLICIT orderBy only; with no
    // orderBy and one value it carries more values than clauses, so prod
    // throws "Too many arguments" (upstream `boundFromFields`). The error
    // now carries a FirestoreError `.code` (FS-B16).
    const db = setup();
    let err: unknown;
    try {
      await db.collection('tickets').startCursor([1], true).get();
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('invalid-argument');
    expect(String(err)).toContain('orderBy() clauses');
  });

  it('limitToLast without orderBy throws a FirestoreError invalid-argument (FS-B16)', async () => {
    const db = setup();
    let err: unknown;
    try {
      await db.collection('tickets').limitToLast(2).get();
    } catch (e) { err = e; }
    expect(String(err)).toContain('orderBy clause');
    // FS-B16 — the throw now carries a typed `.code` (was a plain Error).
    expect((err as { code?: string }).code).toBe('invalid-argument');
  });

  it('snapshot cursor from a non-existent doc throws not-found with a .code (FS-B16)', async () => {
    const db = setup();
    const missing = await db.collection('tickets').doc('does-not-exist').get();
    let err: unknown;
    try {
      db.collection('tickets').orderBy('priority').startCursorFromSnapshot(missing, true);
    } catch (e) { err = e; }
    expect((err as { code?: string }).code).toBe('not-found');
  });
});

describe('snapshot-based cursors', () => {
  it('startCursorFromSnapshot derives values from the snapshot data', async () => {
    const db = setup();
    // Grab T-3 as the cursor anchor; its priority is 3.
    const anchor = await db.collection('tickets').doc('T-3').get();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .startCursorFromSnapshot(anchor, true)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([3, 4, 5]);
  });

  it('startCursorFromSnapshot with inclusive=false skips the anchor', async () => {
    const db = setup();
    const anchor = await db.collection('tickets').doc('T-3').get();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .startCursorFromSnapshot(anchor, false)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });

  it('endCursorFromSnapshot trims to-and-including the anchor', async () => {
    const db = setup();
    const anchor = await db.collection('tickets').doc('T-3').get();
    const snap = await db
      .collection('tickets')
      .orderBy('priority')
      .endCursorFromSnapshot(anchor, true)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2, 3]);
  });

  it('extracts multi-field cursor values from one snapshot', async () => {
    const env = new LocalEnvironment();
    env.deployRules(RULES_AUTH_OPEN);
    env.seed({
      rules: RULES_AUTH_OPEN,
      documents: {
        'q/A': { p: 1, t: 10 },
        'q/B': { p: 1, t: 20 },
        'q/C': { p: 2, t: 5 },
        'q/D': { p: 2, t: 15 },
      },
    });
    const db = new FirestoreImpl(env, { uid: 'alice', token: {} });
    const anchor = await db.collection('q').doc('B').get(); // (p=1, t=20)
    const snap = await db
      .collection('q')
      .orderBy('p')
      .orderBy('t')
      .startCursorFromSnapshot(anchor, false) // after (1,20)
      .get();
    // Sorted: (1,10) (1,20) (2,5) (2,15) — after (1,20) leaves the (2,*) suffix.
    expect(snap.docs.map((d) => `${d.data().p}-${d.data().t}`)).toEqual(['2-5', '2-15']);
  });

  it('is legal without an explicit orderBy — positions on the doc key (FS-B8)', async () => {
    // Prod: a snapshot cursor uses the NORMALIZED orderBy (implicit
    // `__name__`), so `startAt(snapshot)` with no explicit orderBy is legal
    // and positions on the document key. Pre-FS-B8 this threw.
    const db = setup();
    const anchor = await db.collection('tickets').doc('T-3').get();
    const snap = await db
      .collection('tickets')
      .startCursorFromSnapshot(anchor, true) // inclusive — from T-3 onward by key
      .get();
    // Docs sort by `__name__` (T-1..T-5); from T-3 inclusive → T-3,T-4,T-5.
    expect(snap.docs.map((d) => d.id)).toEqual(['T-3', 'T-4', 'T-5']);
  });
});

describe('collectionGroup inherits cursors + limitToLast', () => {
  it('cursors apply across the cross-collection scan', async () => {
    const env = new LocalEnvironment();
    env.deployRules(RULES_AUTH_OPEN);
    env.seed({
      rules: RULES_AUTH_OPEN,
      documents: {
        'a/A1/items/I-1': { priority: 1 },
        'a/A1/items/I-2': { priority: 4 },
        'a/A2/items/I-3': { priority: 2 },
        'b/B1/items/I-4': { priority: 5 },
        'b/B2/items/I-5': { priority: 3 },
      },
    });
    const db = new FirestoreImpl(env, { uid: 'alice', token: {} });
    const snap = await db
      .collectionGroup('items')
      .orderBy('priority')
      .startCursor([2], true)
      .endCursor([4], true)
      .get();
    expect(snap.docs.map((d) => d.data().priority)).toEqual([2, 3, 4]);
  });
});
