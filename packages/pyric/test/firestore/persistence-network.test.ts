/**
 * `pyric/firestore` offline/persistence/network family (issue #144).
 *
 * A real app's init sequence commonly looks like:
 *
 *   const db = getFirestore(app);
 *   await enableIndexedDbPersistence(db);
 *   // ... later ...
 *   await enableNetwork(db);
 *   await disableNetwork(db);
 *   await waitForPendingWrites(db);
 *
 * Before this change, none of `enableIndexedDbPersistence`,
 * `enableMultiTabIndexedDbPersistence`, `clearIndexedDbPersistence`,
 * `enableNetwork`, `disableNetwork`, `waitForPendingWrites` were
 * exported from `pyric/firestore` at all — importing them from an app
 * bundled under pyric would fail at import time (a missing named
 * export), crashing before the app ever got to a read or write.
 *
 * These tests assert the full sequence now resolves without throwing,
 * and that the app can still read/write afterward. Each function also
 * gets its own resolve/return-contract test. See the HONEST-MIRROR
 * doc comments in `src/firestore/index.ts` (right above each function)
 * for why each one settles the way it does — this file only checks
 * the observable contract, not the rationale.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  enableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence,
  clearIndexedDbPersistence,
  enableNetwork,
  disableNetwork,
  waitForPendingWrites,
} from '../../src/firestore/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  setRules(sandbox, RULES);
  return { sandbox, db };
}

describe('real-app init sequence — offline/persistence/network family', () => {
  it('resolves the full init sequence and the app can still read/write after', async () => {
    const { db } = setup();

    await enableIndexedDbPersistence(db);
    await enableNetwork(db);
    await disableNetwork(db);
    await waitForPendingWrites(db);
    await enableNetwork(db);

    const ref = doc(db, 'notes/n1');
    await setDoc(ref, { text: 'hello' });
    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ text: 'hello' });
  });
});

describe('enableIndexedDbPersistence', () => {
  it('resolves (persistence is already the sandbox default)', async () => {
    const { db } = setup();
    await expect(enableIndexedDbPersistence(db)).resolves.toBeUndefined();
  });

  it('rejects with failed-precondition when called after Firestore has started', async () => {
    const { db } = setup();
    const ref = doc(db, 'notes/n1');
    await setDoc(ref, { text: 'first' });
    await expect(enableIndexedDbPersistence(db)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

describe('enableMultiTabIndexedDbPersistence', () => {
  it('resolves (the sandbox has no separate multi-tab mode to opt into)', async () => {
    const { db } = setup();
    await expect(enableMultiTabIndexedDbPersistence(db)).resolves.toBeUndefined();
  });

  it('rejects with failed-precondition after the service has started', async () => {
    const { db } = setup();
    await getDoc(doc(db, 'notes/started'));
    await expect(enableMultiTabIndexedDbPersistence(db)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

describe('clearIndexedDbPersistence', () => {
  it('resolves, mapped onto Sandbox.clearPersistence()', async () => {
    const { db } = setup();
    await expect(clearIndexedDbPersistence(db)).resolves.toBeUndefined();
  });

  it('is a no-op when persistence was never enabled — data survives', async () => {
    const { db } = setup();
    const ref = doc(db, 'notes/n1');
    await setDoc(ref, { text: 'still here' });
    await clearIndexedDbPersistence(db);
    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ text: 'still here' });
  });
});

describe('enableNetwork / disableNetwork', () => {
  it('disableNetwork resolves (no network to disable in the sandbox)', async () => {
    const { db } = setup();
    await expect(disableNetwork(db)).resolves.toBeUndefined();
  });

  it('enableNetwork resolves', async () => {
    const { db } = setup();
    await expect(enableNetwork(db)).resolves.toBeUndefined();
  });

  it('keeps write acknowledgements pending while exposing the local mutation', async () => {
    const { db } = setup();
    await disableNetwork(db);
    const ref = doc(db, 'notes/n1');
    let writeSettled = false;
    const write = setDoc(ref, { text: 'offline' }).then(() => {
      writeSettled = true;
    });
    let pendingSettled = false;
    const pending = waitForPendingWrites(db).then(() => {
      pendingSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writeSettled).toBe(false);
    expect(pendingSettled).toBe(false);
    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ text: 'offline' });

    await enableNetwork(db);
    await Promise.all([write, pending]);
    expect(writeSettled).toBe(true);
    expect(pendingSettled).toBe(true);
  });
});

describe('waitForPendingWrites', () => {
  it('resolves immediately when there are no pending writes', async () => {
    const { db } = setup();
    await expect(waitForPendingWrites(db)).resolves.toBeUndefined();
  });
});
