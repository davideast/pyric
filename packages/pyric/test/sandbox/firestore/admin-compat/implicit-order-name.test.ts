/**
 * FS-B8 — implicit orderBy + `__name__` doc-key tiebreak.
 *
 * Mirrors `clones/.../core/query.ts:queryNormalizedOrderBy`:
 *   - explicit orderBy fields, then an implicit order on each inequality-
 *     filtered field, then a final `__name__` (document key) clause.
 *
 * The masked gaps (round-1 cursor probes used distinct integer values, so
 * the missing tiebreak never surfaced):
 *   - equal-valued docs under `orderBy` had nondeterministic order;
 *   - a `startAfter(snapshot)` couldn't disambiguate two docs sharing the
 *     orderBy value — it kept or dropped both;
 *   - a `where('x','>',v)` query returned docs in candidate (insertion)
 *     order, not ordered by `x`;
 *   - `startAt(snapshot)` with no explicit orderBy threw (legal in prod).
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { FirestoreImpl } from '../../../../src/firestore/sandbox/admin-compat/firestore.js';

const OPEN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

function setup(documents: Record<string, Record<string, unknown>>): FirestoreImpl {
  const env = new LocalEnvironment();
  env.seed({ rules: OPEN, documents });
  return new FirestoreImpl(env, { uid: 'u', token: {} });
}

describe('FS-B8 — __name__ tiebreak makes equal-valued ordering deterministic', () => {
  it('docs sharing an orderBy value sort by document key', async () => {
    // Insert out of key order so insertion order != key order.
    const db = setup({
      'items/c': { score: 5 },
      'items/a': { score: 5 },
      'items/b': { score: 5 },
    });
    const snap = await db.collection('items').orderBy('score').get();
    // All score=5 → tiebreak by __name__: a, b, c.
    expect(snap.docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('a snapshot cursor disambiguates two docs sharing the orderBy value', async () => {
    const db = setup({
      'items/a': { score: 5 },
      'items/b': { score: 5 },
      'items/c': { score: 5 },
    });
    const anchor = await db.collection('items').doc('b').get();
    const snap = await db
      .collection('items')
      .orderBy('score')
      .startCursorFromSnapshot(anchor, false) // startAfter(b)
      .get();
    // Pre-FS-B8 (no __name__ in the cursor): all three share score=5, so
    // `startAfter` dropped everyone or no one. With the key tiebreak it
    // skips exactly through `b` → just `c` remains.
    expect(snap.docs.map((d) => d.id)).toEqual(['c']);
  });
});

describe('FS-B8 — inequality filter implies an orderBy on its field', () => {
  it('a `>` filter orders the result by the filtered field', async () => {
    const db = setup({
      'n/x': { v: 30 },
      'n/y': { v: 10 },
      'n/z': { v: 20 },
    });
    // No explicit orderBy — prod implicitly orders by `v` (the inequality
    // field). Pre-FS-B8 the result came back in candidate (insertion) order.
    const snap = await db.collection('n').where('v', '>', 5).get();
    expect(snap.docs.map((d) => (d.data() as { v: number }).v)).toEqual([10, 20, 30]);
  });
});

describe('FS-B8 — startAt(snapshot) is legal without an explicit orderBy', () => {
  it('positions on the document key', async () => {
    const db = setup({
      'd/a': { n: 1 },
      'd/b': { n: 2 },
      'd/c': { n: 3 },
    });
    const anchor = await db.collection('d').doc('b').get();
    const snap = await db.collection('d').startCursorFromSnapshot(anchor, true).get();
    // From b inclusive, ordered by __name__ → b, c.
    expect(snap.docs.map((d) => d.id)).toEqual(['b', 'c']);
  });
});
