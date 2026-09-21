/**
 * A listener's converter applies to that listener's deliveries only, and once.
 *
 * Deliveries are converted on the snapshot object the listener receives. Two
 * listeners on the same documents, or one listener across several deliveries,
 * must not see each other's conversion or a conversion applied twice.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  onSnapshot,
  type DocumentData,
  type QuerySnapshot,
} from '../../src/firestore/index.js';

interface Item {
  label: string;
  conversions: number;
}

let conversions = 0;
const itemConverter = {
  toFirestore: (item: Item): DocumentData => ({ label: item.label }),
  fromFirestore: (snapshot: { data(): DocumentData }): Item => {
    conversions += 1;
    const raw = snapshot.data();
    const alreadyConverted = 'conversions' in raw;
    if (alreadyConverted) throw new Error('fromFirestore received a converted model, not stored data');
    return { label: String(raw.label), conversions };
  },
};

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}`);
  return db;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('listener converters', () => {
  it('keeps an untyped listener raw while a typed listener watches the same collection', async () => {
    const db = setup();
    const raw = collection(db, 'items');
    const typed = raw.withConverter(itemConverter);
    await setDoc(doc(raw, 'one'), { label: 'first' });

    const typedSeen: unknown[] = [];
    const rawSeen: unknown[] = [];
    const stopTyped = onSnapshot(typed, (snap) => {
      typedSeen.push(...(snap as QuerySnapshot<Item>).docs.map((d) => d.data()));
    });
    const stopRaw = onSnapshot(raw, (snap) => {
      rawSeen.push(...snap.docs.map((d) => d.data()));
    });
    await settle();
    await setDoc(doc(raw, 'two'), { label: 'second' });
    await settle();
    stopTyped();
    stopRaw();

    expect(typedSeen.length).toBeGreaterThan(0);
    expect(rawSeen.length).toBeGreaterThan(0);
    for (const value of typedSeen) expect(value).toHaveProperty('conversions');
    for (const value of rawSeen) expect(value).not.toHaveProperty('conversions');
  });

  it('hands fromFirestore stored data on every delivery, including unchanged documents', async () => {
    const db = setup();
    const typed = collection(db, 'items').withConverter(itemConverter);
    await setDoc(doc(typed, 'one'), { label: 'first', conversions: 0 });

    const labels: string[][] = [];
    const errors: unknown[] = [];
    const stop = onSnapshot(
      typed,
      (snap) => {
        try {
          labels.push((snap as QuerySnapshot<Item>).docs.map((d) => d.data().label));
          // Reading twice must not feed the first result back into the converter.
          (snap as QuerySnapshot<Item>).docs.map((d) => d.data().label);
        } catch (error) { errors.push(error); }
      },
      (error) => errors.push(error),
    );
    await settle();
    await setDoc(doc(typed, 'two'), { label: 'second', conversions: 0 });
    await settle();
    await setDoc(doc(typed, 'three'), { label: 'third', conversions: 0 });
    await settle();
    stop();

    expect(errors).toEqual([]);
    expect(labels.at(-1)?.sort()).toEqual(['first', 'second', 'third']);
  });
});
