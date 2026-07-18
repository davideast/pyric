/**
 * ADR-0009 decision 6 — characterization pins for the admin-compat query
 * surface: cursors. Public surface only.
 *
 * The surface does not expose Admin-SDK-named `startAt` / `startAfter` /
 * `endAt` / `endBefore` methods — cursor positioning goes through
 * `startCursor(values, inclusive)` / `endCursor(values, inclusive)` and
 * the snapshot variants `startCursorFromSnapshot` / `endCursorFromSnapshot`.
 * Both the supported semantics and the absent names are pinned here.
 *
 * Notable current behaviors locked below:
 *   - Value cursors with more values than explicit orderBy clauses throw
 *     invalid-argument at get() time (not at cursor-construction time).
 *   - Snapshot cursors are legal without any orderBy — they position on
 *     the implicit document-key ordering.
 *   - Snapshot cursors from a nonexistent doc throw not-found at
 *     cursor-construction time (synchronously).
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import {
  createCompatFirestore,
  FirestoreCompatError,
} from '../../../../../src/firestore/sandbox/admin-compat/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`;

function seededDb(documents: Record<string, Record<string, unknown>>) {
  const env = new LocalEnvironment();
  env.seed({ rules: RULES, documents });
  return createCompatFirestore(env, { auth: { uid: 'alice' } });
}

async function ids(q: { get: () => Promise<{ docs: { id: string }[] }> }): Promise<string[]> {
  return (await q.get()).docs.map((d) => d.id);
}

const TICKETS = {
  'tickets/T-1': { priority: 1, group: 'a' },
  'tickets/T-2': { priority: 2, group: 'a' },
  'tickets/T-3': { priority: 3, group: 'b' },
  'tickets/T-4': { priority: 4, group: 'b' },
  'tickets/T-5': { priority: 5, group: 'b' },
} as const;

describe('characterization — value cursors', () => {
  it('startCursor inclusive (startAt) vs exclusive (startAfter)', async () => {
    const db = seededDb(TICKETS);
    const base = () => db.collection('tickets').orderBy('priority');
    expect(await ids(base().startCursor([3], true))).toEqual(['T-3', 'T-4', 'T-5']);
    expect(await ids(base().startCursor([3], false))).toEqual(['T-4', 'T-5']);
  });

  it('endCursor inclusive (endAt) vs exclusive (endBefore)', async () => {
    const db = seededDb(TICKETS);
    const base = () => db.collection('tickets').orderBy('priority');
    expect(await ids(base().endCursor([3], true))).toEqual(['T-1', 'T-2', 'T-3']);
    expect(await ids(base().endCursor([3], false))).toEqual(['T-1', 'T-2']);
  });

  it('start + end compose to a window; desc reverses the frame', async () => {
    const db = seededDb(TICKETS);
    expect(
      await ids(
        db.collection('tickets').orderBy('priority').startCursor([2], true).endCursor([4], true),
      ),
    ).toEqual(['T-2', 'T-3', 'T-4']);
    expect(
      await ids(db.collection('tickets').orderBy('priority', 'desc').startCursor([4], true)),
    ).toEqual(['T-4', 'T-3', 'T-2', 'T-1']);
  });

  it('multi-field cursors compare lexicographically across orderBy clauses', async () => {
    const db = seededDb(TICKETS);
    expect(
      await ids(
        db.collection('tickets').orderBy('group').orderBy('priority').startCursor(['b', 4], true),
      ),
    ).toEqual(['T-4', 'T-5']);
  });

  it('a shorter cursor than the orderBy list is a legal prefix cursor', async () => {
    const db = seededDb(TICKETS);
    expect(
      await ids(
        db.collection('tickets').orderBy('group').orderBy('priority').startCursor(['b'], true),
      ),
    ).toEqual(['T-3', 'T-4', 'T-5']);
  });

  it('a repeated startCursor replaces the previous one', async () => {
    const db = seededDb(TICKETS);
    expect(
      await ids(
        db.collection('tickets').orderBy('priority').startCursor([4], true).startCursor([2], true),
      ),
    ).toEqual(['T-2', 'T-3', 'T-4', 'T-5']);
  });

  it('more cursor values than orderBy clauses throws invalid-argument at get()', async () => {
    const db = seededDb(TICKETS);
    // Construction succeeds — the throw is deferred to execution.
    const q = db.collection('tickets').orderBy('priority').startCursor([1, 'x'], true);
    let err: unknown;
    try { await q.get(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FirestoreCompatError);
    expect((err as FirestoreCompatError).code).toBe('invalid-argument');
  });

  it('a value cursor with no orderBy at all also throws invalid-argument at get()', async () => {
    const db = seededDb(TICKETS);
    let err: unknown;
    try { await db.collection('tickets').startCursor([1], true).get(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FirestoreCompatError);
    expect((err as FirestoreCompatError).code).toBe('invalid-argument');
  });
});

describe('characterization — snapshot cursors', () => {
  it('startCursorFromSnapshot pages after a fetched doc', async () => {
    const db = seededDb(TICKETS);
    const page1 = await db.collection('tickets').orderBy('priority').limit(2).get();
    expect(page1.docs.map((d) => d.id)).toEqual(['T-1', 'T-2']);
    const last = await db.doc(`tickets/${page1.docs[1]!.id}`).get();
    expect(
      await ids(
        db.collection('tickets').orderBy('priority').startCursorFromSnapshot(last, false).limit(2),
      ),
    ).toEqual(['T-3', 'T-4']);
  });

  it('endCursorFromSnapshot bounds the window inclusively', async () => {
    const db = seededDb(TICKETS);
    const snap = await db.doc('tickets/T-3').get();
    expect(
      await ids(db.collection('tickets').orderBy('priority').endCursorFromSnapshot(snap, true)),
    ).toEqual(['T-1', 'T-2', 'T-3']);
  });

  it('a snapshot cursor is legal with no orderBy — positions on the doc key', async () => {
    const db = seededDb(TICKETS);
    const snap = await db.doc('tickets/T-2').get();
    expect(await ids(db.collection('tickets').startCursorFromSnapshot(snap, false))).toEqual([
      'T-3', 'T-4', 'T-5',
    ]);
  });

  it('a snapshot cursor from a missing doc throws not-found synchronously', async () => {
    const db = seededDb(TICKETS);
    const missing = await db.doc('tickets/nope').get();
    expect(missing.exists).toBe(false);
    let err: unknown;
    try {
      db.collection('tickets').orderBy('priority').startCursorFromSnapshot(missing, true);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FirestoreCompatError);
    expect((err as FirestoreCompatError).code).toBe('not-found');
  });
});

describe('characterization — Admin-SDK cursor names are absent', () => {
  it('startAt / startAfter / endAt / endBefore do not exist on the surface', () => {
    const db = seededDb(TICKETS);
    const q = db.collection('tickets').orderBy('priority') as unknown as Record<string, unknown>;
    expect(q.startAt).toBeUndefined();
    expect(q.startAfter).toBeUndefined();
    expect(q.endAt).toBeUndefined();
    expect(q.endBefore).toBeUndefined();
  });
});
