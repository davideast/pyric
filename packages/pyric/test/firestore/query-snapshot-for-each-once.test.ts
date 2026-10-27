/**
 * `QuerySnapshot.forEach` visits each document once (#1203). The sandbox's
 * error-translation proxy ran every method inside the provenance window and
 * fell back to a second call when the window returned `undefined`, so a
 * void method such as `forEach` ran its callback twice per document, and a
 * write inside the callback ran twice too.
 *
 * Production's signature is `forEach(callback, thisArg?)`, calling
 * `callback.call(thisArg, doc)` with the document alone. Every in-page
 * snapshot follows it: modular `getDocs` with and without a converter, a
 * listener snapshot, and the Admin-shaped query snapshot.
 *
 * This file imports `pyric/sandbox/*` from the package's dist, so run
 * `scripts/build.sh --packages-only` after editing the sandbox sources.
 */
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getFirestore as getAdminCompatFirestore } from 'pyric/sandbox/admin-firestore';
import * as fs from '../../src/firestore/index.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

type Sandbox = ReturnType<typeof initializeSandbox>;

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const sandbox = initializeSandbox();
  try {
    getAdminCompatFirestore(sandbox.withAuth(null)).setRules(OPEN_RULES);
    await run(sandbox);
  } finally {
    getInternalEnv(sandbox).dispose();
  }
}

interface ForEachable {
  forEach(callback: (...args: unknown[]) => void, thisArg?: unknown): void;
}

/** What `forEach` passes: the ids it visits, the argument count per call, and the `this` it binds. */
function observeForEach(snapshot: unknown): { ids: string[]; argCounts: number[]; boundThis: boolean[] } {
  const self = { label: 'thisArg' };
  const ids: string[] = [];
  const argCounts: number[] = [];
  const boundThis: boolean[] = [];
  (snapshot as ForEachable).forEach(function (this: unknown, ...args: unknown[]) {
    ids.push((args[0] as { id: string }).id);
    argCounts.push(args.length);
    boundThis.push(this === self);
  }, self);
  return { ids, argCounts, boundThis };
}

const ONCE_EACH = { ids: ['a', 'b'], argCounts: [1, 1], boundThis: [true, true] };

async function seedModular(sandbox: Sandbox): Promise<ReturnType<typeof fs.getFirestore>> {
  const db = fs.getFirestore(sandbox);
  await fs.setDoc(fs.doc(db, 'posts/b'), { n: 2 });
  await fs.setDoc(fs.doc(db, 'posts/a'), { n: 1 });
  return db;
}

describe('in-page QuerySnapshot.forEach', () => {
  test('a modular getDocs snapshot visits each document once, with the document alone and thisArg bound', () => withSandbox(async (sandbox) => {
    const db = await seedModular(sandbox);
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'posts'), fs.orderBy('n')));
    expect(observeForEach(snap)).toEqual(ONCE_EACH);
  }));

  test('a modular getDocs snapshot with a converter has forEach', () => withSandbox(async (sandbox) => {
    const db = await seedModular(sandbox);
    const converter = {
      toFirestore: (value: { n: number }) => value,
      fromFirestore: (snapshot: fs.QueryDocumentSnapshot) => snapshot.data() as { n: number },
    };
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'posts').withConverter(converter), fs.orderBy('n')));
    expect(observeForEach(snap)).toEqual(ONCE_EACH);
    const values: number[] = [];
    snap.forEach((document) => { values.push(document.data().n); });
    expect(values).toEqual([1, 2]);
  }));

  test('a listener snapshot visits each document once', () => withSandbox(async (sandbox) => {
    const db = await seedModular(sandbox);
    const observed = await new Promise<ReturnType<typeof observeForEach>>((resolve) => {
      const stop = fs.onSnapshot(fs.query(fs.collection(db, 'posts'), fs.orderBy('n')), (snapshot) => {
        stop();
        resolve(observeForEach(snapshot));
      });
    });
    expect(observed).toEqual(ONCE_EACH);
  }));

  test('a write inside the callback runs once per document', () => withSandbox(async (sandbox) => {
    const db = await seedModular(sandbox);
    const snap = await fs.getDocs(fs.collection(db, 'posts'));
    const writes: Promise<unknown>[] = [];
    snap.forEach((document) => { writes.push(fs.addDoc(fs.collection(db, 'copies'), { from: document.id })); });
    await Promise.all(writes);
    expect((await fs.getDocs(fs.collection(db, 'copies'))).size).toBe(2);
  }));

  test('the Admin-shaped query snapshot visits each document once, with the document alone and thisArg bound', () => withSandbox(async (sandbox) => {
    const admin = getAdminCompatFirestore(sandbox.withAuth(null));
    admin.seed({ documents: { 'posts/a': { n: 1 }, 'posts/b': { n: 2 } } });
    const snap = await admin.collection('posts').orderBy('n').get();
    expect(observeForEach(snap)).toEqual(ONCE_EACH);
  }));

  test('Admin-shaped writes each run once', () => withSandbox(async (sandbox) => {
    const admin = getAdminCompatFirestore(sandbox.withAuth(null));
    await admin.collection('q').add({ v: 1 });
    await admin.doc('q/x').set({ v: 1 });
    await admin.doc('q/x').update({ v: 2 });
    const batch = admin.batch();
    batch.set(admin.doc('q/y'), { v: 1 });
    await batch.commit();
    await admin.runTransaction(async (tx) => { tx.set(admin.doc('q/z'), { v: 1 }); });
    expect((await admin.collection('q').get()).size).toBe(4);
    expect((await admin.doc('q/x').get()).get('v')).toBe(2);
  }));
});
