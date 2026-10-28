/**
 * In-page query ordering and equality against Firestore (#1364).
 *
 * Each case comes from a 2026-10-27 hunt repro (`SDK-FL-1.mjs` to
 * `SDK-FL-6.mjs`, `SDK-FL-31.mjs`). Expected values are the
 * upstream 12.13.0 offline engine's answers, or the production capture
 * `firestore-query-negative-zero` for FL-31.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  GeoPoint,
  Timestamp,
  collection,
  collectionGroup,
  doc,
  documentId,
  getDocs,
  getFirestore,
  orderBy,
  query,
  setDoc,
  vector,
  where,
  type Query,
} from '../../src/firestore/index.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

type Db = ReturnType<typeof getFirestore>;

async function seed(docs: Record<string, Record<string, unknown>>): Promise<Db> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, OPEN_RULES);
  for (const [path, data] of Object.entries(docs)) await setDoc(doc(db, path), data);
  return db;
}

async function ids(target: Query): Promise<string> {
  return (await getDocs(target)).docs.map((d) => d.id).join();
}

async function paths(target: Query): Promise<string> {
  return (await getDocs(target)).docs.map((d) => d.ref.path).join(' ');
}

describe('values rank by their Firestore type, never by shape', () => {
  it('FL-1: stored GeoPoints rank as geopoints', async () => {
    const db = await seed({
      'g/g1': { loc: new GeoPoint(1, 2) },
      'g/g2': { loc: new GeoPoint(3, 4) },
      'g/arr': { loc: [1] },
      'g/map': { loc: { a: 1 } },
    });
    const g = collection(db, 'g');
    expect(await ids(query(g, where('loc', '>', new GeoPoint(0, 0))))).toBe('g1,g2');
    expect(await ids(query(g, where('loc', '>=', new GeoPoint(-90, -180))))).toBe('g1,g2');
    expect(await ids(query(g, orderBy('loc')))).toBe('g1,g2,arr,map');
  });

  it('FL-2: vectors rank after arrays and before maps', async () => {
    const db = await seed({
      'v/vec': { e: vector([1, 2]) },
      'v/arr': { e: [9] },
      'v/map': { e: { a: 1 } },
    });
    const v = collection(db, 'v');
    expect(await ids(query(v, orderBy('e')))).toBe('arr,vec,map');
    expect(await ids(query(v, where('e', '>', vector([0]))))).toBe('vec');
  });

  it('FL-3: maps shaped like a Timestamp, GeoPoint or reference rank as maps', async () => {
    const db = await seed({
      't/ts': { v: new Timestamp(5, 0) },
      't/tsish': { v: { seconds: 1, nanoseconds: 0 } },
      't/refish': { v: { path: 'x/a' } },
      't/str': { v: 's' },
    });
    const t = collection(db, 't');
    expect(await ids(query(t, where('v', '>', new Timestamp(0, 0))))).toBe('ts');
    expect(await ids(query(t, orderBy('v')))).toBe('ts,str,tsish,refish');
  });
});

describe('implicit and key order', () => {
  it('FL-4: inequality fields add their implicit order in field-name order', async () => {
    const db = await seed({
      'k/p': { a: 2, b: 1 },
      'k/q': { a: 1, b: 2 },
      'k/r': { a: 1, b: 1 },
      'k/s': { a: 2, b: 2 },
    });
    const k = collection(db, 'k');
    expect(await ids(query(k, where('b', '>', 0), where('a', '>', 0)))).toBe('r,q,p,s');
  });

  it('FL-5: documentId() operands compare as full document keys', async () => {
    const db = await seed({
      'k/p': { v: 1 }, 'k/q': { v: 1 }, 'g/1': { v: 1 },
      'users/u/g/1': { v: 1 }, 'users/u/g/2': { v: 1 }, 'users/v/g/3': { v: 1 },
    });
    const k = collection(db, 'k');
    const cg = collectionGroup(db, 'g');
    const id = documentId();
    expect(await paths(query(k, where(id, 'in', [doc(db, 'k/p'), doc(db, 'other/q')])))).toBe('k/p');
    expect(await paths(query(cg, where(id, '==', 'users/u/g/2')))).toBe('users/u/g/2');
    expect(await paths(query(
      cg,
      where(id, '>=', 'users/u'),
      where(id, '<', `users/u${String.fromCharCode(0xf8ff)}`),
    ))).toBe('users/u/g/1 users/u/g/2');
    expect(await paths(query(cg, where(id, '==', doc(db, 'users/u/g/1'))))).toBe('users/u/g/1');
  });

  it('FL-5: a string documentId() operand on a collection query names a doc in that collection', async () => {
    const db = await seed({ 'k/p': { v: 1 }, 'k/q': { v: 1 } });
    const k = collection(db, 'k');
    expect(await ids(query(k, where(documentId(), '==', 'q')))).toBe('q');
    expect(await ids(query(k, where(documentId(), '>', 'p')))).toBe('q');
  });

  it('FL-6: collection-group order compares key segments, not path strings', async () => {
    const db = await seed({ 'users/u/g/1': { v: 1 }, 'users-x/u/g/2': { v: 1 } });
    expect(await paths(collectionGroup(db, 'g'))).toBe('users/u/g/1 users-x/u/g/2');
  });
});

describe('FL-31: -0 and 0 in equality filters', () => {
  async function zeros(): Promise<Db> {
    return seed({ 'z/pos': { v: 0 }, 'z/one': { v: 1 }, 'z/neg': { v: -0 } });
  }
  const sorted = async (target: Query) =>
    (await getDocs(target)).docs.map((d) => d.id).sort().join();

  it('== and != treat -0 and 0 as one value, as production does', async () => {
    const z = collection(await zeros(), 'z');
    expect(await sorted(query(z, where('v', '==', 0)))).toBe('neg,pos');
    expect(await sorted(query(z, where('v', '==', -0)))).toBe('neg,pos');
    expect(await sorted(query(z, where('v', '!=', 0)))).toBe('one');
  });

  it('in keeps them apart, as production does', async () => {
    const z = collection(await zeros(), 'z');
    expect(await sorted(query(z, where('v', 'in', [0])))).toBe('pos');
  });
});
