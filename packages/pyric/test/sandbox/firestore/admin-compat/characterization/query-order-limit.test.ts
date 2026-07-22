/**
 * ADR-0009 decision 6 — characterization pins for the admin-compat query
 * surface: orderBy / limit / limitToLast, plus the shape of what is not
 * supported (offset). Public surface only.
 *
 * Notable current behaviors locked below:
 *   - With no orderBy, no cursor, and no inequality filter, results come
 *     back in seed/insertion order (the raw candidate scan order).
 *   - orderBy excludes any doc missing the ordered field.
 *   - Mixed-type orderBy sorts by canonical type rank: null before
 *     numbers before strings.
 *   - Equal orderBy values tie-break on the document key (implicit
 *     `__name__` clause).
 *   - `offset` does not exist on the query surface at all.
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

// Deliberately seeded out of both id order and value order.
const TICKETS = {
  'tickets/T-3': { priority: 3, group: 'b' },
  'tickets/T-1': { priority: 1, group: 'a' },
  'tickets/T-5': { priority: 5, group: 'a' },
  'tickets/T-2': { priority: 2, group: 'b' },
  'tickets/T-4': { priority: 4, group: 'a' },
} as const;

describe('characterization — implicit ordering (no orderBy)', () => {
  it('a bare collection get returns seed/insertion order, not id order', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets'))).toEqual(['T-3', 'T-1', 'T-5', 'T-2', 'T-4']);
  });

  it('later writes append after seeded docs in the bare scan order', async () => {
    const db = seededDb(TICKETS);
    await db.doc('tickets/T-0').set({ priority: 0, group: 'c' });
    expect(await ids(db.collection('tickets'))).toEqual([
      'T-3', 'T-1', 'T-5', 'T-2', 'T-4', 'T-0',
    ]);
  });

  it('an equality-only where preserves the bare scan order', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').where('group', '==', 'a'))).toEqual([
      'T-1', 'T-5', 'T-4',
    ]);
  });

  it('an inequality where imposes an implicit orderBy on the filtered field', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').where('priority', '>=', 2))).toEqual([
      'T-2', 'T-3', 'T-4', 'T-5',
    ]);
  });
});

describe('characterization — orderBy', () => {
  it('orderBy defaults to ascending', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').orderBy('priority'))).toEqual([
      'T-1', 'T-2', 'T-3', 'T-4', 'T-5',
    ]);
  });

  it('orderBy desc reverses', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').orderBy('priority', 'desc'))).toEqual([
      'T-5', 'T-4', 'T-3', 'T-2', 'T-1',
    ]);
  });

  it('multi-key orderBy sorts lexicographically across keys', async () => {
    const db = seededDb(TICKETS);
    expect(
      await ids(db.collection('tickets').orderBy('group').orderBy('priority', 'desc')),
    ).toEqual(['T-5', 'T-4', 'T-1', 'T-3', 'T-2']);
  });

  it('equal orderBy values tie-break on the document key ascending', async () => {
    const db = seededDb({
      'rows/c': { v: 1 },
      'rows/a': { v: 1 },
      'rows/b': { v: 1 },
    });
    expect(await ids(db.collection('rows').orderBy('v'))).toEqual(['a', 'b', 'c']);
  });

  it('orderBy excludes docs missing the ordered field', async () => {
    const db = seededDb({
      'rows/a': { v: 2 },
      'rows/b': {},
      'rows/c': { v: 1 },
    });
    expect(await ids(db.collection('rows').orderBy('v'))).toEqual(['c', 'a']);
  });

  it('mixed-type orderBy ranks null before numbers before strings', async () => {
    const db = seededDb({
      'rows/a': { v: 'x' },
      'rows/b': { v: 2 },
      'rows/c': { v: null },
    });
    expect(await ids(db.collection('rows').orderBy('v'))).toEqual(['c', 'b', 'a']);
  });
});

describe('characterization — limit / limitToLast', () => {
  it('limit slices the head of the ordered result', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').orderBy('priority').limit(2))).toEqual([
      'T-1', 'T-2',
    ]);
  });

  it('limit without orderBy slices the bare scan order', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').limit(2))).toEqual(['T-3', 'T-1']);
  });

  it('limit(0) returns an empty snapshot', async () => {
    const db = seededDb(TICKETS);
    const snap = await db.collection('tickets').limit(0).get();
    expect(snap.size).toBe(0);
    expect(snap.empty).toBe(true);
  });

  it('limit larger than the result set returns everything', async () => {
    const db = seededDb(TICKETS);
    expect((await db.collection('tickets').limit(99).get()).size).toBe(5);
  });

  it('a later limit replaces an earlier one', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').orderBy('priority').limit(4).limit(1))).toEqual([
      'T-1',
    ]);
  });

  it('limitToLast takes the tail but returns it in orderBy direction', async () => {
    const db = seededDb(TICKETS);
    expect(await ids(db.collection('tickets').orderBy('priority').limitToLast(2))).toEqual([
      'T-4', 'T-5',
    ]);
  });

  it('firestore#61 limitToLast without orderBy throws unimplemented at get()', async () => {
    const db = seededDb(TICKETS);
    let err: unknown;
    try {
      await db.collection('tickets').limitToLast(2).get();
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FirestoreCompatError);
    expect((err as FirestoreCompatError).code).toBe('unimplemented');
  });
});

describe('characterization — unsupported surface members', () => {
  it('offset is not a method on Query or CollectionReference', () => {
    const db = seededDb(TICKETS);
    const coll = db.collection('tickets') as unknown as Record<string, unknown>;
    expect(coll.offset).toBeUndefined();
    const query = db.collection('tickets').where('priority', '>', 1) as unknown as Record<string, unknown>;
    expect(query.offset).toBeUndefined();
  });

  it('select() and count() are not methods on the query surface', () => {
    const db = seededDb(TICKETS);
    const coll = db.collection('tickets') as unknown as Record<string, unknown>;
    expect(coll.select).toBeUndefined();
    // Counting goes through aggregate({ alias: { kind: 'count' } }) instead.
    expect(coll.count).toBeUndefined();
  });
});
