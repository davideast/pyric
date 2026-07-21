import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  queryEqual,
  setDoc,
  snapshotEqual,
  where,
  withConverter,
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

  it('queryEqual does not observe opaque query operands', () => {
    const { db } = setup();
    let traps = 0;
    const operand = new Proxy({}, {
      get() { traps += 1; return undefined; },
      has() { traps += 1; return false; },
      ownKeys() { traps += 1; return []; },
      getPrototypeOf() { traps += 1; return Object.prototype; },
    });
    const q1 = query(collection(db, 'items'), where('value', '==', operand));
    const q2 = query(collection(db, 'items'), where('value', '==', operand));
    const otherOperand = new Proxy({}, {
      get() { traps += 1; return undefined; },
      has() { traps += 1; return false; },
      ownKeys() { traps += 1; return []; },
      getPrototypeOf() { traps += 1; return Object.prototype; },
    });
    const q3 = query(collection(db, 'items'), where('value', '==', otherOperand));
    expect(traps).toBe(0);
    expect(queryEqual(q1, q2)).toBe(true);
    expect(queryEqual(q1, q3)).toBe(false);
    expect(traps).toBe(0);
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
