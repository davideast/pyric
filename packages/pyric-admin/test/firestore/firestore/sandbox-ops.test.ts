/**
 * Sandbox-only operations on the firestore handle: `db.setRules`,
 * `db.seed`, `db.snapshot`. Plus the sandbox-level `sandbox.snapshot()`
 * index across services.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from '../../../src/firestore/index.js';

// Two linter constraints to dodge:
//   - PERMISSIVE_RULE flags `if true` on any write op, so writes go
//     behind a trivial auth gate (`if request.auth != null`).
//   - RECURSIVE_WILDCARD_OPEN flags `{document=**}` paired with an
//     always-true read; we use a specific `/tickets/{id}` path (the
//     only collection these tests touch) to stay clear of it.
const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`;

const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tickets/{id} {
      allow read: if request.auth != null
        && request.auth.uid == resource.data.ownerId;
    }
  }
}`;

describe('db.setRules', () => {
  it('replaces the active ruleset for subsequent operations', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    db.setRules(OPEN_RULES);
    db.seed({ documents: { 'tickets/T-1': { ownerId: 'bob', title: 'first' } } });

    // Open rules: alice can read bob's ticket.
    const openRead = await db.doc('tickets/T-1').get();
    expect(openRead.exists).toBe(true);

    // Tighten — alice can no longer read bob's ticket.
    db.setRules(OWNER_RULES);
    let err: unknown;
    try {
      await db.doc('tickets/T-1').get();
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string }).code).toBe('permission-denied');
  });

  it('returns the lint result and refuses to swap on parse errors', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth(null));
    db.setRules(OPEN_RULES);

    const broken = db.setRules('not a real rules document');
    expect(broken).toHaveProperty('warnings');
    expect(Array.isArray(broken.warnings)).toBe(true);
  });
});

describe('db.seed', () => {
  it('replaces documents while preserving rules', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    db.setRules(OPEN_RULES);
    db.seed({ documents: { 'tickets/T-1': { title: 'first' } } });

    const first = await db.doc('tickets/T-1').get();
    expect(first.data()?.title).toBe('first');

    db.seed({ documents: { 'tickets/T-2': { title: 'second' } } });

    // T-1 is gone (seed replaces state).
    const goneT1 = await db.doc('tickets/T-1').get();
    expect(goneT1.exists).toBe(false);

    // T-2 is new — rules still permit read because OPEN_RULES survived.
    const t2 = await db.doc('tickets/T-2').get();
    expect(t2.data()?.title).toBe('second');
  });

  it('clears state when called with no documents', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth(null));
    db.setRules(OPEN_RULES);
    db.seed({ documents: { 'tickets/T-1': { title: 'first' } } });

    db.seed();
    const after = await db.doc('tickets/T-1').get();
    expect(after.exists).toBe(false);
  });
});

describe('db.snapshot', () => {
  it('returns a path-keyed view of stored documents', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth(null));
    db.setRules(OPEN_RULES);
    db.seed({
      documents: {
        'tickets/T-1': { title: 'a' },
        'tickets/T-2': { title: 'b' },
      },
    });
    const snap = db.snapshot();
    expect(snap['tickets/T-1']).toEqual({ title: 'a' });
    expect(snap['tickets/T-2']).toEqual({ title: 'b' });
  });
});

describe('sandbox.snapshot (sandbox-level)', () => {
  it('indexes per-service snapshots — firestore is populated for v1', () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth(null));
    db.setRules(OPEN_RULES);
    db.seed({ documents: { 'tickets/T-1': { title: 'a' } } });

    const sandboxSnap = sandbox.snapshot();
    expect(sandboxSnap.firestore).toBeDefined();
    expect((sandboxSnap.firestore as Record<string, unknown>)['tickets/T-1']).toEqual({
      title: 'a',
    });
  });

  it('reflects writes made through any sibling context on the same sandbox', async () => {
    const sandbox = initializeSandbox();
    const dbAlice = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    dbAlice.setRules(OPEN_RULES);
    dbAlice.seed({ documents: { 'tickets/T-1': { title: 'alice-write' } } });

    // Bob writes through a sibling context.
    const dbBob = getFirestore(sandbox.withAuth({ uid: 'bob' }));
    await dbBob.doc('tickets/T-2').set({ title: 'bob-write' });

    // The sandbox-level snapshot sees both.
    const snap = sandbox.snapshot().firestore;
    expect(snap['tickets/T-1']).toEqual({ title: 'alice-write' });
    expect(snap['tickets/T-2']).toEqual({ title: 'bob-write' });
  });
});
