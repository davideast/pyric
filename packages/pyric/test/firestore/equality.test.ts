import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  documentId,
  orderBy,
  query,
  queryEqual,
  setDoc,
  snapshotEqual,
  where,
  startAt,
  startAfter,
  endAt,
  endBefore,
  withConverter,
  Bytes,
  GeoPoint,
  Timestamp,
  vector,
} from '../../src/firestore/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox);
  return { sandbox, db };
}

const converterA = {
  toFirestore: (value: { n: number }) => value,
  fromFirestore: (snap: { data(): { n: number } }) => snap.data(),
};
const converterB = { ...converterA };

describe('Firestore equality helpers', () => {
  it('queryEqual includes converter identity', () => {
    const { db } = setup();
    const base = query(collection(db, 'items'), where('n', '==', 1));
    expect(queryEqual(withConverter(base, converterA), withConverter(base, converterA))).toBe(true);
    expect(queryEqual(withConverter(base, converterA), withConverter(base, converterB))).toBe(false);
  });

  it('queryEqual structurally compares independently-built object operands', () => {
    const { db } = setup();
    const q1 = query(collection(db, 'items'), where('value', '==', {
      a: 1,
      nested: ['x', { enabled: true }],
    }));
    const q2 = query(collection(db, 'items'), where('value', '==', {
      a: 1,
      nested: ['x', { enabled: true }],
    }));
    const q3 = query(collection(db, 'items'), where('value', '==', {
      a: 1,
      nested: ['x', { enabled: false }],
    }));

    expect(queryEqual(q1, q2)).toBe(true);
    expect(queryEqual(q1, q3)).toBe(false);
  });

  it('freezes the executable operand at query construction', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'items/a'), { value: { score: 1 } });
    await setDoc(doc(db, 'items/b'), { value: { score: 2 } });
    const firstOperand = { score: 1 };
    const secondOperand = { score: 1 };
    const first = query(collection(db, 'items'), where('value', '==', firstOperand));
    const second = query(collection(db, 'items'), where('value', '==', secondOperand));

    firstOperand.score = 2;

    expect(queryEqual(first, second)).toBe(true);
    expect((await getDocs(first)).docs.map((snap) => snap.id)).toEqual(['a']);
    expect((await getDocs(second)).docs.map((snap) => snap.id)).toEqual(['a']);
  });

  it('executes captured Firestore scalar operands without losing their value type', async () => {
    const { db } = setup();
    const values = {
      timestamp: Timestamp.fromMillis(1_234),
      bytes: Bytes.fromUint8Array(new Uint8Array([1, 2])),
      geo: new GeoPoint(10, 20),
      vector: vector([1, 2]),
    };
    await setDoc(doc(db, 'items/a'), values);
    for (const [field, value] of Object.entries(values)) {
      const built = query(collection(db, 'items'), where(field, '==', value));
      expect((await getDocs(built)).docs
        .map((snapshot) => snapshot.id)).toEqual(['a']);
    }
  });

  it('validates nested and converted reference owners and ignores operand converters', () => {
    const { db } = setup();
    const otherDb = getFirestore(initializeSandbox());
    const local = doc(db, 'items/a');
    const foreign = doc(otherDb, 'items/a');

    expect(() => query(collection(db, 'items'), where('value', '==', { ref: foreign })))
      .toThrow();
    expect(() => query(collection(db, 'items'), where('value', '==', [foreign])))
      .toThrow();
    expect(() => query(
      collection(db, 'items'),
      where('value', '==', withConverter(foreign, converterA)),
    )).toThrow();

    expect(queryEqual(
      query(collection(db, 'items'), where('value', '==', local)),
      query(collection(db, 'items'), where('value', '==', withConverter(local, converterA))),
    )).toBe(true);
  });

  it('compares snapshot and explicit cursors by their bound values', async () => {
    const { db } = setup();
    const ref = doc(db, 'items/a');
    await setDoc(ref, { rank: 1 });
    const snapshot = await getDoc(ref);
    const base = collection(db, 'items');

    const fromSnapshot = query(
      base,
      orderBy('rank'),
      orderBy(documentId()),
      startAt(snapshot),
    );
    const fromValues = query(
      base,
      orderBy('rank'),
      orderBy(documentId()),
      startAt(1, ref.id),
    );
    expect(queryEqual(fromSnapshot, fromValues)).toBe(true);
  });

  it('captures snapshot cursor bounds without invoking a consumer converter', async () => {
    const { sandbox, db } = setup();
    const ref = doc(db, 'items/a');
    await setDoc(ref, { rank: 1 });
    await setDoc(doc(db, 'items/b'), { rank: 2 });
    let converterCalls = 0;
    const statefulConverter = {
      toFirestore: (value: { rank: number }) => value,
      fromFirestore: () => {
        converterCalls += 1;
        return { rank: 999 };
      },
    };
    const snapshot = await getDoc(withConverter(ref, statefulConverter));
    const base = query(
      collection(db, 'items'),
      orderBy('rank'),
      orderBy(documentId()),
    );
    const cases = [
      [startAt(snapshot), startAt(1, ref.id), ['a', 'b']],
      [startAfter(snapshot), startAfter(1, ref.id), ['b']],
      [endAt(snapshot), endAt(1, ref.id), ['a']],
      [endBefore(snapshot), endBefore(1, ref.id), []],
    ] as const;

    expect(converterCalls).toBe(0);
    for (const [snapshotConstraint, explicitConstraint, expectedIds] of cases) {
      const fromSnapshot = query(base, snapshotConstraint);
      expect(queryEqual(fromSnapshot, query(base, explicitConstraint))).toBe(true);
      sandbox.currentUser = { uid: `first-${expectedIds.length}` };
      expect((await getDocs(fromSnapshot)).docs.map((docSnapshot) => docSnapshot.id))
        .toEqual(expectedIds);
      sandbox.currentUser = { uid: `second-${expectedIds.length}` };
      expect((await getDocs(fromSnapshot)).docs.map((docSnapshot) => docSnapshot.id))
        .toEqual(expectedIds);
    }
    expect(converterCalls).toBe(0);
  });

  it('treats raw and converted addDoc results as executable reference values', async () => {
    const { db } = setup();
    const returned = collection(db, 'returned');
    const rawRef = await addDoc(returned, { kind: 'raw' });
    const convertedRef = await addDoc(withConverter(returned, {
      toFirestore: (value: { kind: string }) => value,
      fromFirestore: (snapshot: { data(): { kind: string } }) => snapshot.data(),
    }), { kind: 'converted' });
    await setDoc(doc(db, 'items/a'), { rawRef, convertedRef });
    const items = collection(db, 'items');
    const rawQuery = query(items, where('rawRef', '==', rawRef));
    const convertedQuery = query(items, where('convertedRef', '==', convertedRef));

    expect(queryEqual(
      rawQuery,
      query(items, where('rawRef', '==', doc(db, rawRef.path))),
    )).toBe(true);
    expect(queryEqual(
      convertedQuery,
      query(items, where('convertedRef', '==', doc(db, convertedRef.path))),
    )).toBe(true);
    expect((await getDocs(rawQuery)).docs.map((snapshot) => snapshot.id)).toEqual(['a']);
    expect((await getDocs(convertedQuery)).docs.map((snapshot) => snapshot.id)).toEqual(['a']);
  });

  it('rejects raw and converted addDoc results owned by another sandbox', async () => {
    const { db } = setup();
    const { db: otherDb } = setup();
    const rawForeign = await addDoc(collection(otherDb, 'returned'), { kind: 'raw' });
    const convertedForeign = await addDoc(withConverter(collection(otherDb, 'returned'), {
      toFirestore: (value: { kind: string }) => value,
      fromFirestore: (snapshot: { data(): { kind: string } }) => snapshot.data(),
    }), { kind: 'converted' });
    const items = collection(db, 'items');

    expect(() => query(items, where('ref', '==', rawForeign)))
      .toThrow(/different Firestore database/);
    expect(() => query(items, where('ref', '==', convertedForeign)))
      .toThrow(/different Firestore database/);
  });

  it('keeps scalar-shaped maps distinct from Firestore scalar values', async () => {
    const { db } = setup();
    const ref = doc(db, 'items/a');
    const cases: Array<[unknown, unknown]> = [
      [{ seconds: 1, nanoseconds: 2 }, new Timestamp(1, 2)],
      [{ path: 'items/target' }, doc(db, 'items/target')],
      [{ latitude: 10, longitude: 20 }, new GeoPoint(10, 20)],
      [{ typeName: 'vector', value: [1, 2] }, vector([1, 2])],
    ];
    const results: boolean[] = [];
    for (const [plain, scalar] of cases) {
      await setDoc(ref, { value: plain });
      const plainSnapshot = await getDoc(ref);
      await setDoc(ref, { value: scalar });
      const scalarSnapshot = await getDoc(ref);
      results.push(snapshotEqual(plainSnapshot, scalarSnapshot));
    }
    expect(results).toEqual([false, false, false, false]);
  });

  it('queryEqual does not observe valid getter operands after query construction', () => {
    const { db } = setup();
    let getterCalls = 0;
    const operand = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() { getterCalls += 1; return 1; },
    });
    const q1 = query(collection(db, 'items'), where('value', '==', operand));
    const q2 = query(collection(db, 'items'), where('value', '==', operand));
    const constructionCalls = getterCalls;
    expect(constructionCalls).toBe(2);
    expect(queryEqual(q1, q2)).toBe(true);
    expect(getterCalls).toBe(constructionCalls);
  });

  it('structurally compares distinct simultaneous listener snapshots', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'items/a'), { value: 1 });
    const source = query(collection(db, 'items'), where('value', '==', 1));
    const firstSnapshot = () => new Promise<Parameters<typeof snapshotEqual>[0]>((resolve) => {
      let unsubscribe = () => {};
      unsubscribe = onSnapshot(source, (snapshot) => {
        unsubscribe();
        resolve(snapshot as Parameters<typeof snapshotEqual>[0]);
      });
    });

    const [first, second] = await Promise.all([firstSnapshot(), firstSnapshot()]);

    expect(first).not.toBe(second);
    expect(snapshotEqual(first, second)).toBe(true);
  });

  it('recognizes query child snapshots and compares document snapshots structurally', async () => {
    const { db } = setup();
    const ref = doc(db, 'items/a');
    await setDoc(ref, { n: 1 });
    const querySnap = await getDocs(collection(db, 'items'));
    expect(snapshotEqual(querySnap.docs[0]!, querySnap.docs[0]!)).toBe(true);

    const first = await getDoc(ref);
    const second = await getDoc(ref);
    expect(snapshotEqual(first, second)).toBe(true);
    await setDoc(ref, { n: 2 });
    const changed = await getDoc(ref);
    expect(snapshotEqual(first, changed)).toBe(false);
  });

  it('includes converter identity in document snapshot equality', async () => {
    const { db } = setup();
    const ref = doc(db, 'items/a');
    await setDoc(ref, { n: 1 });
    const first = await getDoc(withConverter(ref, converterA));
    const sameConverter = await getDoc(withConverter(ref, converterA));
    const otherConverter = await getDoc(withConverter(ref, converterB));
    expect(snapshotEqual(first, sameConverter)).toBe(true);
    expect(snapshotEqual(first, otherConverter)).toBe(false);
  });
});
