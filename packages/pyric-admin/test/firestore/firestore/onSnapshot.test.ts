/**
 * Slice 4 — Web SDK adapter `onSnapshot`.
 *
 * Verifies the four-overload surface routes correctly to
 * `LocalEnvironment.addSnapshotListener` and that the registering
 * context's auth is captured at register time (not re-read at
 * notification time).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getFirestore,
  onSnapshot,
  type DocumentSnapshot,
  type QuerySnapshot,
} from '../../../src/firestore/index.js';
import { getInternalEnv } from 'pyric/sandbox/internal';

const SIMPLE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /games/{id} {
      allow read, write: if request.auth != null;
    }
    match /unrelated/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const STRICT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /private/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

function seeded(uid: string | null, rules = SIMPLE_RULES) {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).seed({
    rules,
    documents: {
      'games/g1': { state: 'open', score: 0 },
      'games/g2': { state: 'closed', score: 5 },
    },
  });
  // Return a (sandbox, ctx-bound db) tuple. Tests prefer the destructured
  // form for the common case of "act as this uid"; the bare sandbox is
  // there for cases that need to derive sibling contexts.
  const db = getFirestore(sandbox.withAuth(uid === null ? null : { uid }));
  return { sandbox, db };
}

describe('onSnapshot — DocumentReference, callback form', () => {
  it('fires the initial snapshot synchronously', () => {
    const { db } = seeded('alice');

    const calls: DocumentSnapshot[] = [];
    onSnapshot(db.doc('games/g1'), (snap) => { calls.push(snap); });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.exists()).toBe(true);
    expect(calls[0]!.data()).toEqual({ state: 'open', score: 0 });
    expect(calls[0]!.id).toBe('g1');
    expect(calls[0]!.ref.path).toBe('games/g1');
  });

  it('fires again after a write to the watched doc', async () => {
    const { db } = seeded('alice');

    const calls: DocumentSnapshot[] = [];
    onSnapshot(db.doc('games/g1'), (snap) => { calls.push(snap); });
    expect(calls).toHaveLength(1);

    await db.doc('games/g1').update({ score: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.data()).toEqual({ state: 'open', score: 1 });
  });

  it('does not re-fire when the same data is written (no-op suppression)', async () => {
    const { db } = seeded('alice');

    const calls: DocumentSnapshot[] = [];
    onSnapshot(db.doc('games/g1'), (snap) => { calls.push(snap); });
    await db.doc('games/g1').set({ state: 'open', score: 0 });

    expect(calls).toHaveLength(1);
  });

  it('unsubscribe prevents further fires', async () => {
    const { db } = seeded('alice');

    const calls: DocumentSnapshot[] = [];
    const unsub = onSnapshot(db.doc('games/g1'), (snap) => { calls.push(snap); });
    expect(calls).toHaveLength(1);

    unsub();
    await db.doc('games/g1').update({ score: 9 });

    expect(calls).toHaveLength(1);
  });
});

describe('onSnapshot — DocumentReference, observer form', () => {
  it('routes the next handler', () => {
    const { db } = seeded('alice');

    const calls: DocumentSnapshot[] = [];
    onSnapshot(db.doc('games/g1'), {
      next: (snap) => { calls.push(snap); },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data()?.score).toBe(0);
  });

  it('routes the error handler on rule denial', () => {
    const { db } = seeded(null, SIMPLE_RULES);

    const errs: unknown[] = [];
    const nexts: DocumentSnapshot[] = [];
    onSnapshot(db.doc('games/g1'), {
      next: (snap) => { nexts.push(snap); },
      error: (err) => { errs.push(err); },
    });

    expect(nexts).toHaveLength(0);
    expect(errs).toHaveLength(1);
  });
});

describe('onSnapshot — DocumentReference, options + callbacks', () => {
  it('accepts SnapshotListenOptions before the callback', () => {
    const { db } = seeded('alice');

    const calls: DocumentSnapshot[] = [];
    onSnapshot(
      db.doc('games/g1'),
      { includeMetadataChanges: true },
      (snap) => { calls.push(snap); },
    );

    expect(calls).toHaveLength(1);
    // Sandbox metadata is constant — `includeMetadataChanges` is documented
    // as a no-op (snapshot-listeners.ts section 6).
    expect(calls[0]!.metadata.hasPendingWrites).toBe(false);
    expect(calls[0]!.metadata.fromCache).toBe(false);
  });

  it('accepts options + observer', () => {
    const { db } = seeded('alice');

    const calls: DocumentSnapshot[] = [];
    onSnapshot(
      db.doc('games/g1'),
      { includeMetadataChanges: false },
      { next: (snap) => { calls.push(snap); } },
    );

    expect(calls).toHaveLength(1);
  });
});

describe('onSnapshot — CollectionReference', () => {
  it('fires the initial snapshot with all docs', () => {
    const { db } = seeded('alice');

    const calls: QuerySnapshot[] = [];
    onSnapshot(db.collection('games'), (snap) => { calls.push(snap); });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(2);
    const paths = calls[0]!.docs.map((d) => d.ref.path).sort();
    expect(paths).toEqual(['games/g1', 'games/g2']);
  });

  it('fires again with docChanges after a write', async () => {
    const { db } = seeded('alice');

    const calls: QuerySnapshot[] = [];
    onSnapshot(db.collection('games'), (snap) => { calls.push(snap); });
    expect(calls).toHaveLength(1);

    await db.doc('games/g3').set({ state: 'open', score: 0 });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.size).toBe(3);
    const changes = calls[1]!.docChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe('added');
    expect(changes[0]!.doc.ref.path).toBe('games/g3');
  });

  it('does not fire when the change is in a different collection', async () => {
    const { db } = seeded('alice');

    const calls: QuerySnapshot[] = [];
    onSnapshot(db.collection('games'), (snap) => { calls.push(snap); });
    expect(calls).toHaveLength(1);

    // `unrelated` collection is unwatched.
    await db.doc('unrelated/x').set({ foo: 'bar' });

    expect(calls).toHaveLength(1);
  });
});

describe('onSnapshot — context auth is captured at register time', () => {
  it('listener registered on a context uses that context auth', async () => {
    const { sandbox: root } = seeded('alice', STRICT_RULES);
    getInternalEnv(root).seed({
      rules: STRICT_RULES,
      documents: { 'private/p1': { secret: 'shh' } },
    });
    const dbAsBob = getFirestore(root.withAuth({ uid: 'bob' }));

    const errs: unknown[] = [];
    onSnapshot(dbAsBob.doc('private/p1'), {
      next: () => { /* noop */ },
      error: (err) => { errs.push(err); },
    });

    // Bob is not 'alice' — STRICT_RULES denies.
    expect(errs).toHaveLength(1);
  });
});

describe('onSnapshot — argument validation', () => {
  it('throws when no next handler is provided (empty observer)', () => {
    const { db } = seeded('alice');
    expect(() => onSnapshot(db.doc('games/g1'), {} as never)).toThrow(/next/);
  });

  it('throws on an unfamiliar reference', () => {
    seeded('alice');
    // The fake is a plain object lacking the CONTEXT_SYMBOL the wrapper
    // attaches to refs produced via getFirestore(ctx).
    const fake = { foo: 'bar' } as unknown as Parameters<typeof onSnapshot>[0];
    expect(() => onSnapshot(fake, () => {})).toThrow();
  });
});

describe('onSnapshot — chainable .onSnapshot(...) method on refs', () => {
  it('db.doc(path).onSnapshot(cb) fires the initial snapshot', () => {
    const { db } = seeded('alice');
    const calls: DocumentSnapshot[] = [];
    db.doc('games/g1').onSnapshot((snap) => { calls.push(snap); });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data()).toEqual({ state: 'open', score: 0 });
  });

  it('db.collection(path).onSnapshot(cb) fires the initial snapshot', () => {
    const { db } = seeded('alice');
    const calls: QuerySnapshot[] = [];
    db.collection('games').onSnapshot((snap) => { calls.push(snap); });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.size).toBe(2);
  });

  it('db.collection(path).where(...).onSnapshot(cb) — the chained form that motivated the shim', () => {
    const { db } = seeded('alice');
    const calls: QuerySnapshot[] = [];
    // Same listener routing as the free-function form; chained
    // where/orderBy/limit dispatch as whole-collection listeners.
    db.collection('games').where('state', '==', 'open').onSnapshot((snap) => {
      calls.push(snap);
    });
    expect(calls).toHaveLength(1);
  });

  it('chained .onSnapshot(cb) returns a working unsubscribe', async () => {
    const { db } = seeded('alice');
    const calls: DocumentSnapshot[] = [];
    const unsub = db.doc('games/g1').onSnapshot((snap) => { calls.push(snap); });
    expect(calls).toHaveLength(1);
    unsub();
    await db.doc('games/g1').update({ score: 1 });
    expect(calls).toHaveLength(1); // no further fires after unsubscribe
  });

  it('chained .onSnapshot(observer) form works with the full observer shape', () => {
    const { db } = seeded('alice');
    const next: DocumentSnapshot[] = [];
    db.doc('games/g1').onSnapshot({ next: (snap) => { next.push(snap); } });
    expect(next).toHaveLength(1);
  });
});
