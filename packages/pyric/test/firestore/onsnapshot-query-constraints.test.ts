/**
 * FS-B2 — `onSnapshot(query(...))` honors where / orderBy / limit.
 *
 * Before FS-B2, a query listener dropped its constraints entirely: the
 * `SnapshotTarget` carried only `{ kind: 'query', collection }`, so the
 * listener delivered the WHOLE collection — including docs the query
 * filtered out, in arbitrary order, ignoring limits. The masking
 * listener oracles used a bare `collection(...)` listen, which never
 * exercised the constraint path.
 *
 * These probes register FILTERED / ORDERED / LIMITED listeners and
 * assert the delivered snapshot matches what `getDocs(sameQuery)` would
 * return — both on the initial fire and on writes.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  sandbox as sandboxOps,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

// Auth-only read rules — the constraint behavior under test is the query
// membership, not the rules model (a `resource.data`-gated read rule
// would deny the unconstrained `list`; see FS-B1 / RULES-B11).
const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /widgets/{id} { allow read, write: if request.auth != null; }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  sandboxOps.setRules(db, RULES);
  sandboxOps.seedDocuments(db, {
    'widgets/W-1': { name: 'a', status: 'open', priority: 3 },
    'widgets/W-2': { name: 'b', status: 'closed', priority: 1 },
    'widgets/W-3': { name: 'c', status: 'open', priority: 2 },
  });
  return db;
}

describe('FS-B2 — filtered onSnapshot excludes non-matching docs', () => {
  it('where() filter is applied on the initial snapshot', () => {
    const db = setup();
    const calls: QuerySnapshot[] = [];
    onSnapshot(
      query(collection(db, 'widgets'), where('status', '==', 'open')),
      (snap) => { calls.push(snap as QuerySnapshot); },
    );
    expect(calls).toHaveLength(1);
    // Only the two `open` widgets — NOT the closed W-2 (pre-FS-B2 this
    // delivered all 3).
    expect(calls[0]!.size).toBe(2);
    const ids = calls[0]!.docs.map((d) => d.id).sort();
    expect(ids).toEqual(['W-1', 'W-3']);
  });

  it('a write that does not match the filter does not appear', async () => {
    const db = setup();
    const calls: QuerySnapshot[] = [];
    onSnapshot(
      query(collection(db, 'widgets'), where('status', '==', 'open')),
      (snap) => { calls.push(snap as QuerySnapshot); },
    );
    expect(calls[0]!.size).toBe(2);
    // Add a non-matching (closed) doc — listener must NOT fire a change
    // that includes it (pre-FS-B2 the whole collection was redelivered).
    await setDoc(doc(db, 'widgets/W-4'), { name: 'd', status: 'closed', priority: 9 });
    const last = calls[calls.length - 1]!;
    expect(last.docs.every((d) => (d.data() as { status: string }).status === 'open')).toBe(true);
    expect(last.docs.some((d) => d.id === 'W-4')).toBe(false);
  });

  it('a write that matches the filter is delivered', async () => {
    const db = setup();
    const calls: QuerySnapshot[] = [];
    onSnapshot(
      query(collection(db, 'widgets'), where('status', '==', 'open')),
      (snap) => { calls.push(snap as QuerySnapshot); },
    );
    await setDoc(doc(db, 'widgets/W-5'), { name: 'e', status: 'open', priority: 7 });
    const last = calls[calls.length - 1]!;
    expect(last.docs.some((d) => d.id === 'W-5')).toBe(true);
  });
});

describe('FS-B2 — orderBy + limit applied on the listener', () => {
  it('orderBy + limit shape the initial snapshot', () => {
    const db = setup();
    const calls: QuerySnapshot[] = [];
    onSnapshot(
      query(collection(db, 'widgets'), orderBy('priority'), limit(2)),
      (snap) => { calls.push(snap as QuerySnapshot); },
    );
    expect(calls[0]!.size).toBe(2);
    // Ordered by priority ascending, limited to 2 → W-2 (1), W-3 (2).
    expect(calls[0]!.docs.map((d) => d.id)).toEqual(['W-2', 'W-3']);
  });
});
