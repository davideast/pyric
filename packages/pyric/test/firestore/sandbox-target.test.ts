/**
 * `@pyric/firestore` sandbox target — smoke + parity tests.
 *
 * Verifies the modular Web-SDK surface routes correctly through to
 * `@pyric/admin`'s chainable adapter on top of `@pyric/sandbox`.
 * Same operations should produce the same observable outcomes
 * regardless of which adapter (modular vs. chainable) the consumer
 * picks — this is the load-bearing claim for the dual-target design.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  // Construction
  getFirestore,
  // Path
  doc,
  collection,
  // Reads
  getDoc,
  getDocs,
  // Writes
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  // Query
  query,
  where,
  orderBy,
  limit,
  // Listeners
  onSnapshot,
  // Tx + batch
  runTransaction,
  writeBatch,
  // Sandbox-only setup
  sandbox as sandboxOps,
  // Sentinels
  serverTimestamp,
  increment,
  arrayUnion,
  arrayRemove,
  Timestamp,
  // Scalar types re-exported from firebase/firestore
  Bytes,
  GeoPoint,
  vector,
  VectorValue,
  // Converters
  withConverter,
  // Errors
  SandboxError,
  // Types
  type DocumentSnapshot,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read: if request.auth != null
        && (request.auth.uid == resource.data.assigneeId
            || request.auth.uid == resource.data.reporterId);
      allow create: if request.auth != null
        && request.auth.uid == request.resource.data.reporterId;
      allow update, delete: if request.auth != null
        && request.auth.uid == resource.data.assigneeId;
    }
    match /counters/{id} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  sandboxOps.setRules(db, RULES);
  sandboxOps.seedDocuments(db, {
    'tickets/T-1': { title: 'Set up CI', reporterId: 'alice', assigneeId: 'bob', status: 'open', priority: 1 },
    'tickets/T-2': { title: 'Fix login', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 2 },
    'counters/views': { count: 0 },
  });
  return { sandbox, db };
}

// Query reads enforce security rules (FS-B1). The ticket-tracker RULES
// above gate `read` on per-doc fields (`resource.data.assigneeId`),
// which a `list` evaluation can't prove for an unconstrained collection
// scan — production denies such a query ("rules are not filters"). These
// query tests verify the modular wrapper's plumbing, not the rules
// model, so they run against an auth-only ruleset (the same approach the
// listener tests below already use for the same reason). Pre-FS-B1, query
// reads bypassed rules entirely, so the original tests passed under the
// field-gated RULES — that pass masked the bypass.
const QUERY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} { allow read, write: if request.auth != null; }
  }
}`;

function querySetup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  sandboxOps.setRules(db, QUERY_RULES);
  sandboxOps.seedDocuments(db, {
    'tickets/T-1': { title: 'Set up CI', reporterId: 'alice', assigneeId: 'bob', status: 'open', priority: 1 },
    'tickets/T-2': { title: 'Fix login', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 2 },
  });
  return { sandbox, db };
}

describe('getFirestore + path constructors', () => {
  it('doc(db, path) returns a tagged DocumentReference', () => {
    const { db } = setup();
    const ref = doc(db, 'tickets/T-1');
    expect(ref.path).toBe('tickets/T-1');
  });

  it('doc(db, ...segments) joins path segments', () => {
    const { db } = setup();
    const ref = doc(db, 'tickets', 'T-1');
    expect(ref.path).toBe('tickets/T-1');
  });

  it('collection(db, path) returns a CollectionReference', () => {
    const { db } = setup();
    const coll = collection(db, 'tickets');
    expect(coll.path).toBe('tickets');
  });

  it('doc(coll, id) appends an id under a collection', () => {
    const { db } = setup();
    const ref = doc(collection(db, 'tickets'), 'T-3');
    expect(ref.path).toBe('tickets/T-3');
  });

  it('doc(coll) generates an auto-id ref', () => {
    const { db } = setup();
    const ref = doc(collection(db, 'tickets'));
    expect(ref.path).toMatch(/^tickets\/[A-Za-z0-9]+$/);
  });

  it('collection(docRef, name) builds a subcollection ref', () => {
    const { db } = setup();
    const subColl = collection(doc(db, 'tickets/T-1'), 'comments');
    expect(subColl.path).toBe('tickets/T-1/comments');
  });

  it('throws TypeError for refs not produced by this package', () => {
    expect(() => doc({} as never, 'x')).toThrow(/unrecognized reference/);
  });
});

describe('reads', () => {
  it('getDoc returns a populated DocumentSnapshot', async () => {
    const { db } = setup();
    const snap = await getDoc(doc(db, 'tickets/T-1'));
    // `.exists()` (method form) is the documented modular Web SDK
    // shape. The sandbox adapter exposed `exists` as a property
    // pre-#339; that PR normalized to method form for parity. See
    // tagSnapshotRefs / normalizeExists in packages/firestore/src/index.ts.
    expect((snap.exists as () => boolean)()).toBe(true);
    expect(snap.data()?.title).toBe('Set up CI');
  });

  it('getDoc denies when rules reject the read', async () => {
    const sandbox = initializeSandbox();
    const dbCarol = getFirestore(sandbox.withAuth({ uid: 'carol' }));
    sandboxOps.setRules(dbCarol, RULES);
    sandboxOps.seedDocuments(dbCarol, {
      'tickets/T-1': { reporterId: 'alice', assigneeId: 'bob', status: 'open' },
    });
    let err: unknown;
    try {
      await getDoc(doc(dbCarol, 'tickets/T-1'));
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('permission-denied');
  });

  it('getDocs returns a QuerySnapshot for a collection', async () => {
    const { db } = querySetup();
    const snap = await getDocs(collection(db, 'tickets'));
    expect(snap.size).toBe(2);
    const titles = snap.docs.map((d) => d.data().title).sort();
    expect(titles).toEqual(['Fix login', 'Set up CI']);
  });
});

describe('writes', () => {
  it('setDoc creates a new document', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'tickets/T-3'), {
      title: 'New', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 3,
    });
    const snap = await getDoc(doc(db, 'tickets/T-3'));
    expect(snap.data()?.title).toBe('New');
  });

  it('updateDoc merges fields into an existing document', async () => {
    const { db } = setup();
    await updateDoc(doc(db, 'tickets/T-2'), { status: 'in-progress' });
    const snap = await getDoc(doc(db, 'tickets/T-2'));
    expect(snap.data()?.status).toBe('in-progress');
    // Other fields preserved.
    expect(snap.data()?.title).toBe('Fix login');
  });

  it('deleteDoc removes a document', async () => {
    const { db } = setup();
    await deleteDoc(doc(db, 'tickets/T-2'));
    // Verify via the sandbox-only snapshotState — getDoc on the
    // deleted doc would fail rule eval (resource.data is null and
    // the read rule references resource.data.assigneeId).
    const state = sandboxOps.snapshotState(db);
    expect(state['tickets/T-2']).toBeUndefined();
  });

  it('addDoc returns a tagged ref usable in subsequent calls', async () => {
    const { db } = setup();
    const ref = await addDoc(collection(db, 'tickets'), {
      title: 'Auto-id', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 5,
    });
    expect(ref.path).toMatch(/^tickets\/[A-Za-z0-9]+$/);
    // Tagged → subsequent operations route correctly.
    const snap = await getDoc(ref);
    expect(snap.data()?.title).toBe('Auto-id');
  });

  it('setDoc default replaces the existing document', async () => {
    const { db } = setup();
    // T-2 has title, reporterId, assigneeId, status, priority. Replace
    // with a minimal doc — dropped fields must NOT survive.
    await setDoc(doc(db, 'tickets/T-2'), {
      title: 'Reset', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 9,
    });
    const state = sandboxOps.snapshotState(db);
    expect(state['tickets/T-2']).toEqual({
      title: 'Reset', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 9,
    });
  });

  it('setDoc with { merge: true } preserves fields not in data', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'tickets/T-2'), { priority: 99 }, { merge: true });
    const state = sandboxOps.snapshotState(db);
    expect(state['tickets/T-2']).toEqual({
      title: 'Fix login', reporterId: 'alice', assigneeId: 'alice', status: 'open', priority: 99,
    });
  });

  it('setDoc with { mergeFields: [...] } merges only listed fields', async () => {
    const { db } = setup();
    await setDoc(
      doc(db, 'tickets/T-2'),
      { priority: 42, status: 'closed', ignored: 'no' },
      { mergeFields: ['priority'] },
    );
    const state = sandboxOps.snapshotState(db);
    expect(state['tickets/T-2']).toEqual({
      title: 'Fix login', reporterId: 'alice', assigneeId: 'alice',
      status: 'open',     // unchanged — not in mergeFields
      priority: 42,
    });
  });
});

describe('queries', () => {
  it('query() applies where + orderBy + limit', async () => {
    const { db } = querySetup();
    const q = query(
      collection(db, 'tickets'),
      where('status', '==', 'open'),
      orderBy('priority'),
      limit(5),
    );
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
    expect(snap.docs[0]!.data().priority).toBe(1);
    expect(snap.docs[1]!.data().priority).toBe(2);
  });

  it('chained queries are taggable for further constraints', async () => {
    const { db } = querySetup();
    const baseQ = query(collection(db, 'tickets'), where('status', '==', 'open'));
    const refinedQ = query(baseQ, orderBy('priority'), limit(1));
    const snap = await getDocs(refinedQ);
    expect(snap.size).toBe(1);
    expect(snap.docs[0]!.data().priority).toBe(1);
  });
});

describe('snapshot listeners', () => {
  // Listener tests use a separate, simpler ruleset that doesn't gate
  // reads on a per-doc field. The ticket-tracker rules are designed
  // around `resource.data.assigneeId` access, which interacts badly
  // with collection listeners that pre-filter via rule eval — out of
  // scope for verifying the modular wrapper's plumbing.
  const LISTENER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /widgets/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

  function listenerSetup() {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, LISTENER_RULES);
    sandboxOps.seedDocuments(db, {
      'widgets/W-1': { name: 'first', priority: 1 },
      'widgets/W-2': { name: 'second', priority: 2 },
    });
    return db;
  }

  it('onSnapshot(docRef, cb) fires the initial snapshot synchronously', () => {
    const db = listenerSetup();
    const calls: DocumentSnapshot[] = [];
    onSnapshot(doc(db, 'widgets/W-1'), (snap) => {
      calls.push(snap as DocumentSnapshot);
    });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.data() as { name: string }).name).toBe('first');
  });

  it('onSnapshot(query, cb) fires on collection writes', async () => {
    const db = listenerSetup();
    const calls: QuerySnapshot[] = [];
    onSnapshot(collection(db, 'widgets'), (snap) => {
      calls.push(snap as QuerySnapshot);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(2);
    await setDoc(doc(db, 'widgets/W-3'), { name: 'third', priority: 3 });
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returned unsubscribe stops further fires', async () => {
    const db = listenerSetup();
    const calls: DocumentSnapshot[] = [];
    const unsub = onSnapshot(doc(db, 'widgets/W-1'), (snap) => {
      calls.push(snap as DocumentSnapshot);
    });
    expect(calls).toHaveLength(1);
    unsub();
    await updateDoc(doc(db, 'widgets/W-1'), { priority: 99 });
    expect(calls).toHaveLength(1); // no further fires
  });
});

describe('transactions + batches', () => {
  it('runTransaction reads and writes atomically', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'system' }));
    sandboxOps.setRules(db, RULES);
    sandboxOps.seedDocuments(db, { 'counters/views': { count: 0 } });

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'counters/views'));
      const next = (snap.data()!.count as number) + 5;
      tx.update(doc(db, 'counters/views'), { count: next });
    });

    const snap = await getDoc(doc(db, 'counters/views'));
    expect(snap.data()?.count).toBe(5);
  });

  it('writeBatch commits multiple writes atomically', async () => {
    // T-1 has assigneeId=bob, T-2 has assigneeId=alice; alice can
    // only update T-2 under the ticket-tracker rules. Sign in as bob
    // to demonstrate batching across both.
    const sandbox = initializeSandbox();
    const dbBob = getFirestore(sandbox.withAuth({ uid: 'bob' }));
    sandboxOps.setRules(dbBob, RULES);
    sandboxOps.seedDocuments(dbBob, {
      'tickets/T-1': { title: 'a', reporterId: 'alice', assigneeId: 'bob',   status: 'open', priority: 1 },
      'tickets/T-2': { title: 'b', reporterId: 'alice', assigneeId: 'bob',   status: 'open', priority: 2 },
    });

    const batch = writeBatch(dbBob);
    batch.update(doc(dbBob, 'tickets/T-1'), { status: 'in-progress' });
    batch.update(doc(dbBob, 'tickets/T-2'), { status: 'in-progress' });
    await batch.commit();

    const snap1 = await getDoc(doc(dbBob, 'tickets/T-1'));
    const snap2 = await getDoc(doc(dbBob, 'tickets/T-2'));
    expect(snap1.data()?.status).toBe('in-progress');
    expect(snap2.data()?.status).toBe('in-progress');
  });
});

describe('sentinels', () => {
  it('serverTimestamp() resolves to a Timestamp', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'system' }));
    sandboxOps.setRules(db, RULES);
    sandboxOps.seedDocuments(db, { 'counters/views': { count: 0, lastBumpedAt: null } });

    await updateDoc(doc(db, 'counters/views'), {
      lastBumpedAt: serverTimestamp(),
    });
    const snap = await getDoc(doc(db, 'counters/views'));
    expect(snap.data()?.lastBumpedAt instanceof Timestamp).toBe(true);
  });

  it('increment(n) atomically bumps a numeric field', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'system' }));
    sandboxOps.setRules(db, RULES);
    sandboxOps.seedDocuments(db, { 'counters/views': { count: 0 } });

    await updateDoc(doc(db, 'counters/views'), { count: increment(7) });
    await updateDoc(doc(db, 'counters/views'), { count: increment(3) });
    const snap = await getDoc(doc(db, 'counters/views'));
    expect(snap.data()?.count).toBe(10);
  });

  it('arrayUnion/arrayRemove de-dupe + remove members', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'system' }));
    sandboxOps.setRules(db, RULES);
    sandboxOps.seedDocuments(db, { 'counters/views': { tags: [] } });

    await updateDoc(doc(db, 'counters/views'), { tags: arrayUnion('a', 'b') });
    await updateDoc(doc(db, 'counters/views'), { tags: arrayUnion('a') }); // no-op
    await updateDoc(doc(db, 'counters/views'), { tags: arrayRemove('b') });
    const snap = await getDoc(doc(db, 'counters/views'));
    expect(snap.data()?.tags).toEqual(['a']);
  });
});

describe('snapshotState (sandbox-only)', () => {
  it('returns the path-keyed view of stored docs', () => {
    const { db } = setup();
    const state = sandboxOps.snapshotState(db);
    expect(state['tickets/T-1']).toBeDefined();
    expect(state['tickets/T-2']).toBeDefined();
  });
});

describe('collectionGroup (Tier 2)', () => {
  it('gathers documents across every parent collection with the same id', async () => {
    const { collectionGroup, getDocs, setDoc, doc } = await import('../../src/firestore/index.js');
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    await setDoc(doc(db, 'items/A'), { priority: 1 });
    await setDoc(doc(db, 'items/B'), { priority: 3 });
    await setDoc(doc(db, 'parents/P1/items/C'), { priority: 2 });
    await setDoc(doc(db, 'orgs/O1/teams/T1/items/D'), { priority: 5 });
    // Unrelated collection — should NOT appear.
    await setDoc(doc(db, 'tasks/T-1'), { kind: 'task' });

    const snap = await getDocs(collectionGroup(db, 'items'));
    expect(snap.size).toBe(4);
    const paths = snap.docs
      .map((d) => (d as unknown as { ref: { path: string } }).ref.path)
      .sort();
    expect(paths).toEqual([
      'items/A',
      'items/B',
      'orgs/O1/teams/T1/items/D',
      'parents/P1/items/C',
    ]);
  });

  it('chains through where / orderBy / limit constraints', async () => {
    const { collectionGroup, getDocs, query, where, orderBy, limit, setDoc, doc } = await import('../../src/firestore/index.js');
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    await setDoc(doc(db, 'items/A'), { priority: 1 });
    await setDoc(doc(db, 'parents/P/items/B'), { priority: 5 });
    await setDoc(doc(db, 'parents/P/items/C'), { priority: 3 });
    await setDoc(doc(db, 'orgs/O/items/D'), { priority: 9 });

    const q = query(
      collectionGroup(db, 'items'),
      where('priority', '>', 1),
      orderBy('priority'),
      limit(2),
    );
    const snap = await getDocs(q);
    expect(snap.docs.map((d) => d.data().priority)).toEqual([3, 5]);
  });

  it('returns an empty result for an unknown collection id', async () => {
    const { collectionGroup, getDocs } = await import('../../src/firestore/index.js');
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    const snap = await getDocs(collectionGroup(db, 'never-existed'));
    expect(snap.empty).toBe(true);
  });
});

describe('cursor pagination + limitToLast (Tier 3)', () => {
  async function setupPriorityTickets() {
    const { setDoc, doc } = await import('../../src/firestore/index.js');
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    for (const p of [1, 2, 3, 4, 5]) {
      await setDoc(doc(db, `tickets/T-${p}`), { priority: p, status: p % 2 === 0 ? 'closed' : 'open' });
    }
    return { db };
  }

  it('startAt is inclusive of the cursor position', async () => {
    const { collection, getDocs, query, orderBy, startAt } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    const snap = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), startAt(3)),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([3, 4, 5]);
  });

  it('startAfter is exclusive', async () => {
    const { collection, getDocs, query, orderBy, startAfter } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    const snap = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), startAfter(3)),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });

  it('endAt is inclusive', async () => {
    const { collection, getDocs, query, orderBy, endAt } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    const snap = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), endAt(3)),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2, 3]);
  });

  it('endBefore is exclusive', async () => {
    const { collection, getDocs, query, orderBy, endBefore } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    const snap = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), endBefore(3)),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2]);
  });

  it('startAfter + limit forms the canonical pagination pattern', async () => {
    const { collection, getDocs, query, orderBy, startAfter, limit } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    // First page: priority 1 and 2
    const page1 = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), limit(2)),
    );
    expect(page1.docs.map((d) => d.data().priority)).toEqual([1, 2]);
    // Second page: skip past priority=2
    const page2 = await getDocs(
      query(
        collection(db, 'tickets'),
        orderBy('priority'),
        startAfter(2),
        limit(2),
      ),
    );
    expect(page2.docs.map((d) => d.data().priority)).toEqual([3, 4]);
  });

  it('limitToLast takes the trailing n', async () => {
    const { collection, getDocs, query, orderBy, limitToLast } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    const snap = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), limitToLast(2)),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([4, 5]);
  });

  it('startAfter(snapshot) yields the canonical paginate-past-last-of-page pattern', async () => {
    const { collection, getDoc, getDocs, query, orderBy, startAfter, limit, doc } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    // First page (n=2)
    const page1 = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), limit(2)),
    );
    const lastOnPage1 = page1.docs[1];
    expect(lastOnPage1.data().priority).toBe(2);
    // Re-fetch the anchor as a DocumentSnapshot (the JS SDK pattern)
    // and pass it to startAfter.
    const anchor = await getDoc(doc(db, 'tickets/T-2'));
    const page2 = await getDocs(
      query(
        collection(db, 'tickets'),
        orderBy('priority'),
        startAfter(anchor),
        limit(2),
      ),
    );
    expect(page2.docs.map((d) => d.data().priority)).toEqual([3, 4]);
  });

  it('endAt(snapshot) trims to-and-including the anchor', async () => {
    const { collection, getDoc, getDocs, query, orderBy, endAt, doc } = await import('../../src/firestore/index.js');
    const { db } = await setupPriorityTickets();
    const anchor = await getDoc(doc(db, 'tickets/T-3'));
    const snap = await getDocs(
      query(collection(db, 'tickets'), orderBy('priority'), endAt(anchor)),
    );
    expect(snap.docs.map((d) => d.data().priority)).toEqual([1, 2, 3]);
  });
});

describe('composite filters (Tier 2)', () => {
  async function setupTickets() {
    const { setDoc, doc } = await import('../../src/firestore/index.js');
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    await setDoc(doc(db, 'tickets/T-1'), { priority: 1, status: 'open',     assignee: 'alice' });
    await setDoc(doc(db, 'tickets/T-2'), { priority: 5, status: 'open',     assignee: 'bob' });
    await setDoc(doc(db, 'tickets/T-3'), { priority: 2, status: 'closed',   assignee: 'alice' });
    await setDoc(doc(db, 'tickets/T-4'), { priority: 4, status: 'closed',   assignee: 'carol' });
    return { db };
  }

  it('or() matches docs where any sub-filter matches', async () => {
    const { collection, getDocs, query, where, or } = await import('../../src/firestore/index.js');
    const { db } = await setupTickets();
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        or(
          where('status', '==', 'open'),
          where('priority', '==', 2),
        ),
      ),
    );
    const ids = snap.docs.map((d) => (d as unknown as { ref: { id: string } }).ref.id).sort();
    expect(ids).toEqual(['T-1', 'T-2', 'T-3']);
  });

  it('and() requires every sub-filter to match', async () => {
    const { collection, getDocs, query, where, and } = await import('../../src/firestore/index.js');
    const { db } = await setupTickets();
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        and(
          where('status', '==', 'closed'),
          where('priority', '>=', 3),
        ),
      ),
    );
    expect(snap.docs.map((d) => (d as unknown as { ref: { id: string } }).ref.id)).toEqual(['T-4']);
  });

  it('nested or/and — the canonical composite pattern', async () => {
    const { collection, getDocs, query, where, or, and } = await import('../../src/firestore/index.js');
    const { db } = await setupTickets();
    // open OR (closed AND assignee=alice)
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        or(
          where('status', '==', 'open'),
          and(
            where('status', '==', 'closed'),
            where('assignee', '==', 'alice'),
          ),
        ),
      ),
    );
    const ids = snap.docs.map((d) => (d as unknown as { ref: { id: string } }).ref.id).sort();
    expect(ids).toEqual(['T-1', 'T-2', 'T-3']);
  });

  it('composite filters AND with other query constraints', async () => {
    const { collection, getDocs, query, where, or } = await import('../../src/firestore/index.js');
    const { db } = await setupTickets();
    // assignee=alice AND (priority=1 OR priority=4) — only T-1
    const snap = await getDocs(
      query(
        collection(db, 'tickets'),
        where('assignee', '==', 'alice'),
        or(where('priority', '==', 1), where('priority', '==', 4)),
      ),
    );
    expect(snap.docs.map((d) => (d as unknown as { ref: { id: string } }).ref.id)).toEqual(['T-1']);
  });

  it('passing orderBy / limit to or() throws TypeError', async () => {
    const { or, orderBy } = await import('../../src/firestore/index.js');
    expect(() => or(orderBy('priority'))).toThrow(/non-filter constraint/);
  });

  it('passing zero arguments to or()/and() throws TypeError', async () => {
    const { or, and } = await import('../../src/firestore/index.js');
    expect(() => or()).toThrow(/at least one filter/);
    expect(() => and()).toThrow(/at least one filter/);
  });
});

describe('aggregates (Tier 2)', () => {
  async function setupTickets() {
    const { setDoc, doc, collection: coll, getDocs } = await import('../../src/firestore/index.js');
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    await setDoc(doc(db, 'tickets/T-1'), { priority: 1, status: 'open',   estimate: 3 });
    await setDoc(doc(db, 'tickets/T-2'), { priority: 3, status: 'open',   estimate: 5 });
    await setDoc(doc(db, 'tickets/T-3'), { priority: 2, status: 'closed', estimate: null });
    await setDoc(doc(db, 'tickets/T-4'), { priority: 5, status: 'open',   estimate: 8 });
    // Smoke-check the seed.
    expect((await getDocs(coll(db, 'tickets'))).size).toBe(4);
    return { db };
  }

  it('getCountFromServer returns the count of matching docs', async () => {
    const { getCountFromServer, collection } = await import('../../src/firestore/index.js');
    const { db } = await setupTickets();
    const snap = await getCountFromServer(collection(db, 'tickets'));
    expect(snap.data()).toEqual({ count: 4 });
  });

  it('getCountFromServer honors where filters', async () => {
    const { getCountFromServer, collection, query, where } = await import('../../src/firestore/index.js');
    const { db } = await setupTickets();
    const snap = await getCountFromServer(
      query(collection(db, 'tickets'), where('status', '==', 'open')),
    );
    expect(snap.data()).toEqual({ count: 3 });
  });

  it('count() / sum(field) / average(field) compose under getAggregateFromServer', async () => {
    const { getAggregateFromServer, collection, count, sum, average } = await import('../../src/firestore/index.js');
    const { db } = await setupTickets();
    const snap = await getAggregateFromServer(collection(db, 'tickets'), {
      n: count(),
      totalEstimate: sum('estimate'),
      avgPriority: average('priority'),
    });
    expect(snap.data()).toEqual({
      n: 4,
      totalEstimate: 16,  // 3 + 5 + 8 (null skipped)
      avgPriority: 2.75,  // (1+3+2+5)/4
    });
  });

  it('average returns null on empty input', async () => {
    const { getAggregateFromServer, collection, average } = await import('../../src/firestore/index.js');
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    const snap = await getAggregateFromServer(collection(db, 'never'), {
      avg: average('x'),
    });
    expect(snap.data()).toEqual({ avg: null });
  });
});

describe('Tier 1 surface — equality + emulator + scalar re-exports', () => {
  it('refEqual returns true for two refs at the same path', async () => {
    const { refEqual, doc } = await import('../../src/firestore/index.js');
    const { db } = setup();
    const a = doc(db, 'tickets/T-1');
    const b = doc(db, 'tickets/T-1');
    expect(refEqual(a, b)).toBe(true);
  });

  it('refEqual returns false for refs at different paths', async () => {
    const { refEqual, doc } = await import('../../src/firestore/index.js');
    const { db } = setup();
    expect(refEqual(doc(db, 'tickets/T-1'), doc(db, 'tickets/T-2'))).toBe(false);
  });

  it('queryEqual returns true for identity on the same Query object', async () => {
    const { queryEqual, collection, query: q, where: w } = await import('../../src/firestore/index.js');
    const { db } = setup();
    const built = q(collection(db, 'tickets'), w('priority', '==', 'high'));
    expect(queryEqual(built, built)).toBe(true);
  });

  it('connectFirestoreEmulator is a no-op on sandbox-target handles', async () => {
    const { connectFirestoreEmulator } = await import('../../src/firestore/index.js');
    const { db } = setup();
    // The point of the no-op behavior: consumer code that calls
    // connectFirestoreEmulator unconditionally still compiles + runs
    // against the sandbox without an env-specific branch.
    expect(() => connectFirestoreEmulator(db, 'localhost', 8080)).not.toThrow();
  });

  it('Bytes / GeoPoint / FieldPath / documentId are re-exported and constructible', async () => {
    const mod = await import('../../src/firestore/index.js');
    expect(typeof mod.Bytes).toBe('function');
    expect(typeof mod.GeoPoint).toBe('function');
    expect(typeof mod.FieldPath).toBe('function');
    expect(typeof mod.documentId).toBe('function');
    // documentId() returns a FieldPath sentinel — verify it's a value
    // (the actual where() integration is tested separately when the
    // simulator grows documentId support).
    const fp = mod.documentId();
    expect(fp).toBeDefined();
  });
});

describe('Bytes + GeoPoint + VectorValue round-trip, COMPAT rows #109 + #110 + #111', () => {
  // Permissive rules so the round-trip is the unit under test, not the
  // rules-eval path.
  const PERMISSIVE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

  function setupPermissive() {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, PERMISSIVE);
    return { sandbox, db };
  }

  it('Bytes round-trips through setDoc / getDoc as a Bytes instance', async () => {
    const { db } = setupPermissive();
    const original = Bytes.fromUint8Array(new Uint8Array([10, 20, 30, 40]));
    await setDoc(doc(db, 'blobs/b1'), { payload: original });
    const snap = await getDoc(doc(db, 'blobs/b1'));
    const data = snap.data();
    expect(data).toBeDefined();
    expect(data!.payload).toBeInstanceOf(Bytes);
    // Base64 round-trips losslessly.
    expect((data!.payload as Bytes).toBase64()).toBe(original.toBase64());
    // Underlying bytes match.
    expect(Array.from((data!.payload as Bytes).toUint8Array())).toEqual([
      10, 20, 30, 40,
    ]);
  });

  it('GeoPoint round-trips through setDoc / getDoc as a GeoPoint instance', async () => {
    const { db } = setupPermissive();
    const original = new GeoPoint(37.7749, -122.4194);
    await setDoc(doc(db, 'places/sf'), { loc: original });
    const snap = await getDoc(doc(db, 'places/sf'));
    const data = snap.data();
    expect(data).toBeDefined();
    expect(data!.loc).toBeInstanceOf(GeoPoint);
    expect((data!.loc as GeoPoint).latitude).toBe(37.7749);
    expect((data!.loc as GeoPoint).longitude).toBe(-122.4194);
  });

  it('Bytes + GeoPoint nested in objects and arrays round-trip', async () => {
    const { db } = setupPermissive();
    const sig = Bytes.fromUint8Array(new Uint8Array([0xde, 0xad]));
    const sf = new GeoPoint(37.7749, -122.4194);
    const ny = new GeoPoint(40.7128, -74.006);
    await setDoc(doc(db, 'mixed/m1'), {
      meta: { sig },
      coords: [sf, ny],
    });
    const snap = await getDoc(doc(db, 'mixed/m1'));
    const data = snap.data() as {
      meta: { sig: unknown };
      coords: unknown[];
    };
    expect(data.meta.sig).toBeInstanceOf(Bytes);
    expect((data.meta.sig as Bytes).toBase64()).toBe(sig.toBase64());
    expect(data.coords[0]).toBeInstanceOf(GeoPoint);
    expect((data.coords[0] as GeoPoint).latitude).toBe(37.7749);
    expect(data.coords[1]).toBeInstanceOf(GeoPoint);
    expect((data.coords[1] as GeoPoint).longitude).toBe(-74.006);
  });

  it('updateDoc with a Bytes field round-trips', async () => {
    const { db } = setupPermissive();
    await setDoc(doc(db, 'blobs/b2'), { label: 'pending' });
    const payload = Bytes.fromUint8Array(new Uint8Array([0xff, 0x00, 0xff]));
    await updateDoc(doc(db, 'blobs/b2'), { payload });
    const snap = await getDoc(doc(db, 'blobs/b2'));
    const data = snap.data();
    expect(data!.label).toBe('pending');
    expect(data!.payload).toBeInstanceOf(Bytes);
    expect((data!.payload as Bytes).toBase64()).toBe(payload.toBase64());
  });

  it('updateDoc with a GeoPoint field round-trips', async () => {
    const { db } = setupPermissive();
    await setDoc(doc(db, 'places/p2'), { name: 'TBD' });
    const loc = new GeoPoint(48.8566, 2.3522);
    await updateDoc(doc(db, 'places/p2'), { loc });
    const snap = await getDoc(doc(db, 'places/p2'));
    const data = snap.data();
    expect(data!.name).toBe('TBD');
    expect(data!.loc).toBeInstanceOf(GeoPoint);
    expect((data!.loc as GeoPoint).latitude).toBe(48.8566);
    expect((data!.loc as GeoPoint).longitude).toBe(2.3522);
  });

  it('vector() round-trips through setDoc / getDoc as a VectorValue instance', async () => {
    const { db } = setupPermissive();
    const original = vector([0.1, 0.2, 0.3, 0.4, 0.5]);
    await setDoc(doc(db, 'embeddings/e1'), { title: 'doc', embedding: original });
    const snap = await getDoc(doc(db, 'embeddings/e1'));
    const data = snap.data();
    expect(data).toBeDefined();
    expect(data!.title).toBe('doc');
    expect(data!.embedding).toBeInstanceOf(VectorValue);
    expect((data!.embedding as VectorValue).toArray()).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it('a vector nested in an object round-trips', async () => {
    const { db } = setupPermissive();
    await setDoc(doc(db, 'embeddings/e2'), {
      meta: { model: 'test', embedding: vector([1, 2, 3]) },
    });
    const snap = await getDoc(doc(db, 'embeddings/e2'));
    const data = snap.data() as { meta: { model: string; embedding: unknown } };
    expect(data.meta.model).toBe('test');
    expect(data.meta.embedding).toBeInstanceOf(VectorValue);
    expect((data.meta.embedding as VectorValue).toArray()).toEqual([1, 2, 3]);
  });
});

describe('withConverter (typed refs) — Tier 1b', () => {
  // Domain model the consumer wants to work with — keeps `createdAt`
  // as a real `Date`. Storage uses a serializable string (ISO) so the
  // round-trip exercises both directions of the converter.
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

  function setupConv() {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
    return { db };
  }

  it('withConverter on a DocumentReference round-trips through toFirestore / fromFirestore', async () => {
    const { db } = setupConv();
    const typedRef = withConverter(doc(db, 'users/u1'), userConverter);
    const when = new Date('2026-05-01T12:00:00.000Z');
    await setDoc(typedRef, { name: 'Alice', createdAt: when });
    // Underlying storage uses the DB shape — typed data() reconstructs Date.
    const stored = sandboxOps.snapshotState(db);
    expect(stored['users/u1']).toEqual({ name: 'Alice', createdAtIso: when.toISOString() });
    const snap = await getDoc(typedRef);
    const out = snap.data();
    expect(out?.name).toBe('Alice');
    expect(out?.createdAt).toBeInstanceOf(Date);
    expect(out?.createdAt.toISOString()).toBe(when.toISOString());
  });

  it('withConverter on a CollectionReference propagates to doc(coll, id)', async () => {
    const { db } = setupConv();
    const users = withConverter(collection(db, 'users'), userConverter);
    const u1 = doc(users, 'u1');
    const when = new Date('2026-05-02T00:00:00.000Z');
    await setDoc(u1, { name: 'Bob', createdAt: when });
    const snap = await getDoc(u1);
    expect(snap.data()?.createdAt.toISOString()).toBe(when.toISOString());
  });

  it('withConverter on a CollectionReference propagates through query() + getDocs()', async () => {
    const { db } = setupConv();
    const users = withConverter(collection(db, 'users'), userConverter);
    await setDoc(doc(users, 'a'), { name: 'A', createdAt: new Date('2026-01-01') });
    await setDoc(doc(users, 'b'), { name: 'B', createdAt: new Date('2026-02-01') });
    const q = query(users, where('name', '==', 'B'));
    const snap = await getDocs(q);
    expect(snap.size).toBe(1);
    const [b] = snap.docs;
    expect(b.data().name).toBe('B');
    expect(b.data().createdAt).toBeInstanceOf(Date);
  });

  it('addDoc through a converted collection returns a typed ref', async () => {
    const { db } = setupConv();
    const users = withConverter(collection(db, 'users'), userConverter);
    const when = new Date('2026-03-01');
    const newRef = await addDoc(users, { name: 'Carol', createdAt: when });
    // Returned ref retains the converter — getDoc round-trips as User.
    const snap = await getDoc(newRef);
    expect(snap.data()?.name).toBe('Carol');
    expect(snap.data()?.createdAt.toISOString()).toBe(when.toISOString());
  });

  it('withConverter(ref, null) strips the converter and returns the underlying view', async () => {
    const { db } = setupConv();
    const typedRef = withConverter(doc(db, 'users/u1'), userConverter);
    await setDoc(typedRef, { name: 'D', createdAt: new Date('2026-04-01') });
    const untyped = withConverter(typedRef, null);
    const snap = await getDoc(untyped);
    // No converter on the read path — `.data()` yields the raw DB shape.
    const raw = snap.data() as UserDb | undefined;
    expect(raw?.createdAtIso).toBe(new Date('2026-04-01').toISOString());
    expect(raw?.name).toBe('D');
  });

  it('the original untyped ref keeps its identity after withConverter', async () => {
    const { db } = setupConv();
    const untyped = doc(db, 'users/u1');
    const typed = withConverter(untyped, userConverter);
    expect(typed).not.toBe(untyped);
    // Writes through untyped land as raw DB shape.
    await setDoc(untyped, { name: 'E', createdAtIso: '2026-05-01T00:00:00.000Z' });
    // Reads through typed apply fromFirestore.
    const snap = await getDoc(typed);
    expect(snap.data()?.createdAt).toBeInstanceOf(Date);
  });
});
