/**
 * ADR-0009 decision 6 — characterization pins for the admin-compat query
 * surface: edge cases and snapshot shape invariants. Public surface only.
 *
 * Notable current behaviors locked below:
 *   - Querying a nonexistent collection returns an empty snapshot, no
 *     error (under rules that allow the read).
 *   - Phantom parents (docs at deep paths whose parents hold no data of
 *     their own) never appear in query results — a collection whose only
 *     members are phantoms queries as empty.
 *   - Duplicate where() on the same field ANDs (intersection).
 *   - QuerySnapshot invariants: size/empty/docs agree, every doc has
 *     exists === true, id matches the last path segment, data() returns
 *     the stored fields, and forEach visits docs in docs[] order.
 */
import { describe, it, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { createCompatFirestore } from '../../../../../src/sandbox/firestore/admin-compat/index.js';

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

describe('characterization — empty and nonexistent collections', () => {
  it('a where() matching nothing returns an empty, well-shaped snapshot', async () => {
    const db = seededDb({ 'items/a': { n: 1 } });
    const snap = await db.collection('items').where('n', '==', 99).get();
    expect(snap.size).toBe(0);
    expect(snap.empty).toBe(true);
    expect(snap.docs).toEqual([]);
  });

  it('querying a collection that has never existed returns empty, not an error', async () => {
    const db = seededDb({ 'items/a': { n: 1 } });
    const snap = await db.collection('never-created').get();
    expect(snap.size).toBe(0);
    expect(snap.empty).toBe(true);
  });

  it('collectionGroup over a nonexistent group id returns empty', async () => {
    const db = seededDb({ 'items/a': { n: 1 } });
    expect((await db.collectionGroup('ghosts').get()).size).toBe(0);
  });
});

describe('characterization — subcollections and phantom parents', () => {
  it('subcollection queries scope to the parent doc path', async () => {
    const db = seededDb({
      'teams/t1/members/m1': { name: 'ana' },
      'teams/t1/members/m2': { name: 'bo' },
      'teams/t2/members/m3': { name: 'cy' },
    });
    expect(await ids(db.collection('teams/t1/members'))).toEqual(['m1', 'm2']);
    expect(await ids(db.collection('teams/t2/members'))).toEqual(['m3']);
  });

  it('a collection whose members are only phantom parents queries as empty', async () => {
    // Only the deep doc exists; 'teams/t1' has no data of its own.
    const db = seededDb({ 'teams/t1/members/m1': { name: 'ana' } });
    const snap = await db.collection('teams').get();
    expect(snap.size).toBe(0);
    expect(snap.empty).toBe(true);
  });

  it('a real doc among phantom siblings is the only query result', async () => {
    const db = seededDb({
      'teams/t1/members/m1': { name: 'ana' },
      'teams/t2': { name: 'real team' },
    });
    expect(await ids(db.collection('teams'))).toEqual(['t2']);
  });

  it('queries do not recurse — direct children only, never nested docs', async () => {
    const db = seededDb({
      'teams/t1': { level: 'top' },
      'teams/t1/members/m1': { level: 'nested' },
    });
    const snap = await db.collection('teams').get();
    expect(snap.docs.map((d) => d.ref.path)).toEqual(['teams/t1']);
  });

  it('collectionGroup finds same-named collections at every depth', async () => {
    const db = seededDb({
      'members/top': { at: 'root' },
      'teams/t1/members/m1': { at: 'nested' },
    });
    const snap = await db.collectionGroup('members').get();
    expect(snap.docs.map((d) => d.ref.path)).toEqual(['members/top', 'teams/t1/members/m1']);
  });
});

describe('characterization — duplicate where on the same field', () => {
  it('two ranges on one field intersect', async () => {
    const db = seededDb({
      'nums/n1': { v: 1 },
      'nums/n2': { v: 2 },
      'nums/n3': { v: 3 },
      'nums/n4': { v: 4 },
    });
    expect(
      await ids(db.collection('nums').where('v', '>', 1).where('v', '<', 4)),
    ).toEqual(['n2', 'n3']);
  });

  it('contradictory equalities on one field match nothing', async () => {
    const db = seededDb({ 'nums/n1': { v: 1 } });
    expect(
      await ids(db.collection('nums').where('v', '==', 1).where('v', '==', 2)),
    ).toEqual([]);
  });

  it('a tighter repeat of the same range narrows (AND, not replace)', async () => {
    const db = seededDb({
      'nums/n1': { v: 1 },
      'nums/n2': { v: 2 },
      'nums/n3': { v: 3 },
    });
    expect(
      await ids(db.collection('nums').where('v', '>', 0).where('v', '>', 2)),
    ).toEqual(['n3']);
  });
});

describe('characterization — QuerySnapshot shape invariants', () => {
  it('docs carry id, ref.path, exists=true, and data() with the stored fields', async () => {
    const db = seededDb({
      'books/b1': { title: 'Dune', pages: 412 },
      'books/b2': { title: 'Emma', pages: 474 },
    });
    const snap = await db.collection('books').orderBy('title').get();
    expect(snap.size).toBe(2);
    expect(snap.empty).toBe(false);
    expect(snap.docs.length).toBe(2);
    const first = snap.docs[0]!;
    expect(first.id).toBe('b1');
    expect(first.ref.path).toBe('books/b1');
    expect(first.exists).toBe(true);
    expect(first.data()).toEqual({ title: 'Dune', pages: 412 });
  });

  it('forEach visits docs in docs[] order', async () => {
    const db = seededDb({
      'books/b2': { n: 2 },
      'books/b1': { n: 1 },
      'books/b3': { n: 3 },
    });
    const snap = await db.collection('books').orderBy('n', 'desc').get();
    const visited: string[] = [];
    snap.forEach((d) => visited.push(d.id));
    expect(visited).toEqual(snap.docs.map((d) => d.id));
    expect(visited).toEqual(['b3', 'b2', 'b1']);
  });

  it('data() returns an independent value per snapshot read of the store', async () => {
    const db = seededDb({ 'books/b1': { pages: 1 } });
    const snap = await db.collection('books').get();
    // Mutating the store after the get does not change the held snapshot.
    await db.doc('books/b1').update({ pages: 2 });
    expect(snap.docs[0]!.data()).toEqual({ pages: 1 });
  });

  it('doc refs on query results are usable for follow-up reads', async () => {
    const db = seededDb({ 'books/b1': { pages: 1 } });
    const snap = await db.collection('books').get();
    const again = await db.doc(snap.docs[0]!.ref.path).get();
    expect(again.exists).toBe(true);
    expect(again.data()).toEqual({ pages: 1 });
  });
});
