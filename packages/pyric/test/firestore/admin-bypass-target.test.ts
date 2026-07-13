/**
 * `pyric/firestore` admin lens — `getAdminFirestore` (Pyric Studio Gap #2).
 *
 * The modular Web-SDK surface gets a rules-bypassing handle. The deny-vs-
 * bypass contract: under a restrictive ruleset, the SAME modular write
 * (`setDoc`) is DENIED through `getFirestore(...)` but SUCCEEDS through
 * `getAdminFirestore(...)`. This is the handle the serve worker's
 * `{ mode: 'admin' }` auth lens needs.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import {
  getFirestore,
  getAdminFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
} from '../../src/firestore/index.js';

const DENY_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

function denyAllSandbox() {
  const sandbox = initializeSandbox();
  getInternalEnv(sandbox).deployRules(DENY_ALL);
  return sandbox;
}

describe('getAdminFirestore (modular) — shape', () => {
  it('accepts a bare Sandbox and a SandboxContext', () => {
    const sandbox = initializeSandbox();
    expect(getAdminFirestore(sandbox)).toBeDefined();
    expect(getAdminFirestore(sandbox.withAuth(null))).toBeDefined();
  });
});

describe('deny-vs-bypass: setDoc', () => {
  it('rules DENY setDoc through getFirestore (regression guard)', async () => {
    const sandbox = denyAllSandbox();
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await expect(setDoc(doc(db, 'locked/x'), { a: 1 })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(sandbox.admin.getDocument('locked/x')).toBeNull();
  });

  it('admin handle BYPASSES rules — setDoc succeeds and lands', async () => {
    const sandbox = denyAllSandbox();
    const admin = getAdminFirestore(sandbox);
    await setDoc(doc(admin, 'locked/x'), { a: 1 });
    expect(sandbox.admin.getDocument('locked/x')).toEqual({ a: 1 });
  });
});

describe('deny-vs-bypass: getDoc / getDocs', () => {
  it('rules DENY getDoc through getFirestore but admin reads it', async () => {
    const sandbox = denyAllSandbox();
    sandbox.admin.setDocument('locked/x', { a: 1 });

    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await expect(getDoc(doc(db, 'locked/x'))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    const admin = getAdminFirestore(sandbox);
    const snap = await getDoc(doc(admin, 'locked/x'));
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ a: 1 });
  });

  it('admin getDocs lists a collection despite deny-all rules', async () => {
    const sandbox = denyAllSandbox();
    sandbox.admin.setDocument('items/a', { n: 1 });
    sandbox.admin.setDocument('items/b', { n: 2 });
    const admin = getAdminFirestore(sandbox);
    const snap = await getDocs(collection(admin, 'items'));
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['a', 'b']);
  });

  it('admin listeners read documents and collections despite deny-all rules', () => {
    const sandbox = denyAllSandbox();
    sandbox.admin.setDocument('items/a', { n: 1 });
    sandbox.admin.setDocument('items/b', { n: 2 });
    const admin = getAdminFirestore(sandbox);
    const errors: unknown[] = [];
    const documents: unknown[] = [];
    const collections: string[][] = [];
    const listenerRequests: Array<{ result: string; detail?: { admin?: boolean } }> = [];
    sandbox.onEvent((event) => {
      if (event.kind === 'request' && event.origin === 'listener') {
        listenerRequests.push(event);
      }
    });

    const unsubscribeDocument = onSnapshot(doc(admin, 'items/a'), {
      next: (snapshot) => documents.push(snapshot.data()),
      error: (error) => errors.push(error),
    });
    const unsubscribeCollection = onSnapshot(collection(admin, 'items'), {
      next: (snapshot) => collections.push(snapshot.docs.map((item) => item.id).sort()),
      error: (error) => errors.push(error),
    });

    getInternalEnv(sandbox).flushListeners();

    expect(errors).toEqual([]);
    expect(documents).toEqual([{ n: 1 }]);
    expect(collections).toEqual([['a', 'b']]);

    sandbox.admin.setDocument('items/a', { n: 3 });
    sandbox.admin.setDocument('items/c', { n: 4 });
    getInternalEnv(sandbox).flushListeners();

    expect(errors).toEqual([]);
    expect(documents.at(-1)).toEqual({ n: 3 });
    expect(collections.at(-1)).toEqual(['a', 'b', 'c']);
    expect(listenerRequests.length).toBeGreaterThanOrEqual(4);
    expect(listenerRequests.every(
      (request) => request.result === 'allow' && request.detail?.admin === true,
    )).toBe(true);
    unsubscribeDocument();
    unsubscribeCollection();
  });
});

describe('deny-vs-bypass: updateDoc / deleteDoc', () => {
  it('admin updateDoc + deleteDoc succeed despite deny-all rules', async () => {
    const sandbox = denyAllSandbox();
    sandbox.admin.setDocument('locked/x', { a: 1 });
    const admin = getAdminFirestore(sandbox);
    await updateDoc(doc(admin, 'locked/x'), { a: 2 });
    expect(sandbox.admin.getDocument('locked/x')).toEqual({ a: 2 });
    await deleteDoc(doc(admin, 'locked/x'));
    expect(sandbox.admin.getDocument('locked/x')).toBeNull();
  });
});

describe('deny-vs-bypass: writeBatch + runTransaction', () => {
  it('admin writeBatch commits writes that rules would deny', async () => {
    const sandbox = denyAllSandbox();
    const admin = getAdminFirestore(sandbox);
    const batch = writeBatch(admin);
    batch.set(doc(admin, 'locked/a'), { v: 1 });
    batch.set(doc(admin, 'locked/b'), { v: 2 });
    await batch.commit();
    expect(sandbox.admin.getDocument('locked/a')).toEqual({ v: 1 });
    expect(sandbox.admin.getDocument('locked/b')).toEqual({ v: 2 });
  });

  it('admin runTransaction commits writes that rules would deny', async () => {
    const sandbox = denyAllSandbox();
    const admin = getAdminFirestore(sandbox);
    await runTransaction(admin, async (tx) => {
      tx.set(doc(admin, 'locked/t'), { v: 42 });
    });
    expect(sandbox.admin.getDocument('locked/t')).toEqual({ v: 42 });
  });
});

describe('rules-enforced handle is unchanged when rules allow', () => {
  it('an open ruleset allows a normal modular write through getFirestore', async () => {
    const sandbox = initializeSandbox(); // default open rules
    const db = getFirestore(sandbox.withAuth(null));
    await setDoc(doc(db, 'open/x'), { a: 1 });
    const snap = await getDoc(doc(db, 'open/x'));
    expect(snap.data()).toEqual({ a: 1 });
  });
});

describe('events still emit on the admin path', () => {
  it('an admin write emits a write/request event (so it shows on the traffic log)', async () => {
    const sandbox = denyAllSandbox();
    const events: string[] = [];
    sandbox.onEvent((e) => events.push(e.kind));
    const admin = getAdminFirestore(sandbox);
    await setDoc(doc(admin, 'locked/x'), { a: 1 });
    // The rule-allowed branch emits both a 'request' (allow) and a 'write'
    // committed event — the admin bypass reuses that same emit path.
    expect(events).toContain('request');
    expect(events).toContain('write');
  });
});
