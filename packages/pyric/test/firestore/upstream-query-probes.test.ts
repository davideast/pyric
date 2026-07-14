/**
 * Upstream-mined modular query probes (clusters 1–3).
 *
 * Sourced from firebase-js-sdk `packages/firestore/test/integration/api/`
 * (query.test.ts / cursor.test.ts) against behaviors COMPAT already claims
 * ✓ but held with thin modular evidence:
 *   1. Membership filters — `in` / `array-contains` / `array-contains-any`
 *      (+ OR composites)
 *   2. `documentId()` / `__name__` as where + orderBy
 *   3. `limitToLast` composed with cursors and descending orderBy
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  query,
  where,
  or,
  and,
  orderBy,
  limitToLast,
  startAfter,
  startAt,
  endAt,
  documentId,
} from '../../src/firestore/index.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

async function setupDb(
  docs: Record<string, Record<string, unknown>>,
): Promise<ReturnType<typeof getFirestore>> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, OPEN_RULES);
  for (const [path, data] of Object.entries(docs)) {
    await setDoc(doc(db, path), data);
  }
  return db;
}

function ids(snap: { docs: Array<{ id: string }> }): string[] {
  return snap.docs.map((d) => d.id).sort();
}

// ─── Cluster 1: membership filters ─────────────────────────────────────

describe('membership filters (upstream query probes)', () => {
  async function setupTags() {
    return setupDb({
      'items/a': { tags: ['red', 'blue'], status: 'open', n: 1 },
      'items/b': { tags: ['green'], status: 'open', n: 2 },
      'items/c': { tags: ['red', 'green'], status: 'closed', n: 3 },
      'items/d': { tags: [], status: 'open', n: 4 },
      'items/e': { status: 'open', n: 5 }, // no tags field
    });
  }

  it('in matches any listed value', async () => {
    const db = await setupTags();
    const snap = await getDocs(
      query(collection(db, 'items'), where('status', 'in', ['closed', 'archived'])),
    );
    expect(ids(snap)).toEqual(['c']);
  });

  it('array-contains matches a single element', async () => {
    const db = await setupTags();
    const snap = await getDocs(
      query(collection(db, 'items'), where('tags', 'array-contains', 'red')),
    );
    expect(ids(snap)).toEqual(['a', 'c']);
  });

  it('array-contains-any matches any of the listed elements', async () => {
    const db = await setupTags();
    const snap = await getDocs(
      query(
        collection(db, 'items'),
        where('tags', 'array-contains-any', ['blue', 'green']),
      ),
    );
    expect(ids(snap)).toEqual(['a', 'b', 'c']);
  });

  it('array-contains excludes missing and empty arrays', async () => {
    const db = await setupTags();
    const snap = await getDocs(
      query(collection(db, 'items'), where('tags', 'array-contains', 'missing')),
    );
    expect(snap.empty).toBe(true);
  });

  it('or() composes with in', async () => {
    const db = await setupTags();
    const snap = await getDocs(
      query(
        collection(db, 'items'),
        or(
          where('status', 'in', ['closed']),
          where('n', '==', 1),
        ),
      ),
    );
    expect(ids(snap)).toEqual(['a', 'c']);
  });

  it('or() composes with array-contains', async () => {
    const db = await setupTags();
    const snap = await getDocs(
      query(
        collection(db, 'items'),
        or(
          where('tags', 'array-contains', 'blue'),
          where('status', '==', 'closed'),
        ),
      ),
    );
    expect(ids(snap)).toEqual(['a', 'c']);
  });

  it('and() requires membership + equality', async () => {
    const db = await setupTags();
    const snap = await getDocs(
      query(
        collection(db, 'items'),
        and(
          where('tags', 'array-contains', 'red'),
          where('status', '==', 'open'),
        ),
      ),
    );
    expect(ids(snap)).toEqual(['a']);
  });
});

// ─── Cluster 2: documentId() / __name__ ────────────────────────────────

describe('documentId() filters + orderBy (upstream query probes)', () => {
  async function setupIds() {
    return setupDb({
      'cities/aa': { key: 'aa' },
      'cities/ab': { key: 'ab' },
      'cities/ba': { key: 'ba' },
      'cities/bb': { key: 'bb' },
    });
  }

  it('where(documentId(), "==", id) matches one doc', async () => {
    const db = await setupIds();
    const snap = await getDocs(
      query(collection(db, 'cities'), where(documentId(), '==', 'ab')),
    );
    expect(ids(snap)).toEqual(['ab']);
  });

  it('where(documentId(), "in", [...]) matches listed ids', async () => {
    const db = await setupIds();
    const snap = await getDocs(
      query(collection(db, 'cities'), where(documentId(), 'in', ['aa', 'bb'])),
    );
    expect(ids(snap)).toEqual(['aa', 'bb']);
  });

  it('where(documentId(), "==", ref) accepts a DocumentReference', async () => {
    const db = await setupIds();
    const snap = await getDocs(
      query(
        collection(db, 'cities'),
        where(documentId(), '==', doc(db, 'cities/ba')),
      ),
    );
    expect(ids(snap)).toEqual(['ba']);
  });

  it('where(documentId()) range filters by id string', async () => {
    const db = await setupIds();
    const snap = await getDocs(
      query(
        collection(db, 'cities'),
        where(documentId(), '>', 'aa'),
        where(documentId(), '<=', 'ba'),
      ),
    );
    expect(ids(snap)).toEqual(['ab', 'ba']);
  });

  it('orderBy(documentId()) sorts by document id', async () => {
    const db = await setupIds();
    const snap = await getDocs(
      query(collection(db, 'cities'), orderBy(documentId())),
    );
    expect(snap.docs.map((d) => d.id)).toEqual(['aa', 'ab', 'ba', 'bb']);
  });

  it('orderBy(documentId(), "desc") reverses id order', async () => {
    const db = await setupIds();
    const snap = await getDocs(
      query(collection(db, 'cities'), orderBy(documentId(), 'desc')),
    );
    expect(snap.docs.map((d) => d.id)).toEqual(['bb', 'ba', 'ab', 'aa']);
  });
});

// ─── Cluster 3: limitToLast × cursors / desc ───────────────────────────

describe('limitToLast with cursors + descending (upstream query probes)', () => {
  async function setupPriority() {
    return setupDb({
      'tickets/T-1': { priority: 1 },
      'tickets/T-2': { priority: 2 },
      'tickets/T-3': { priority: 3 },
      'tickets/T-4': { priority: 4 },
      'tickets/T-5': { priority: 5 },
    });
  }

  it('limitToLast with descending orderBy takes the trailing window of the desc order', async () => {
    const db = await setupPriority();
    // Desc order: 5,4,3,2,1 — last 2 of that sequence: 2,1 — then returned
    // in the original (desc) orderBy direction: 2,1.
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        orderBy('priority', 'desc'),
        limitToLast(2),
      ),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([2, 1]);
  });

  it('limitToLast + startAfter composes (trailing window after cursor)', async () => {
    const db = await setupPriority();
    // Asc order 1..5, startAfter(2) → 3,4,5; limitToLast(2) → 4,5.
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        orderBy('priority'),
        startAfter(2),
        limitToLast(2),
      ),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });

  it('limitToLast + startAt + endAt window', async () => {
    const db = await setupPriority();
    // startAt(2) endAt(5) → 2,3,4,5; limitToLast(2) → 4,5.
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        orderBy('priority'),
        startAt(2),
        endAt(5),
        limitToLast(2),
      ),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });

  it('limitToLast + descending + startAfter', async () => {
    const db = await setupPriority();
    // Desc: 5,4,3,2,1; startAfter(4) in desc → 3,2,1; limitToLast(2) → 2,1.
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        orderBy('priority', 'desc'),
        startAfter(4),
        limitToLast(2),
      ),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([2, 1]);
  });
});
