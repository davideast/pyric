/**
 * Every sandbox time the clock is supposed to own, asserted against the clock.
 *
 * This is the honesty test for the seam: it does not check that a clock method
 * returned what it was given, it checks that the sandbox's own state and
 * verdicts moved with it. A method whose name promises virtual time is only
 * shippable while this file passes.
 */
import { describe, it, expect } from 'bun:test';

import { initializeSandbox } from 'pyric/sandbox';
import { getClock, getInternalEnv } from 'pyric/sandbox/internal';
import {
  doc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from '../../src/firestore/index.js';
import {
  get as dbGet,
  getDatabase,
  ref as dbRef,
  sandbox as rtdbSandbox,
  serverTimestamp as rtdbServerTimestamp,
  set as dbSet,
} from '../../src/database/index.js';
import { getAuth } from '../../src/auth/instances.js';
import { signInAnonymously } from '../../src/auth/index.js';
import { getAdminStorageSandbox } from '../../src/storage/internal.js';
import { getMetadata, ref as storageRef, uploadBytes } from '../../src/storage/index.js';
import { getStorageSandbox } from '../../src/storage/service.js';

/** 2031-06-01T00:00:00Z, comfortably past any wall clock this suite runs on. */
const FUTURE = Date.UTC(2031, 5, 1);
/** 2020-01-01T00:00:00Z, comfortably before it. */
const PAST = Date.UTC(2020, 0, 1);

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

/**
 * Firestore rules that only allow a write before 2025. Under the wall clock the
 * gate is shut; pinning the clock to 2020 opens it.
 */
const TIME_GATED_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read: if true;
      allow write: if request.time < timestamp.date(2025, 1, 1);
    }
  }
}`;

const TIME_GATED_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
      allow write: if request.time < timestamp.date(2025, 1, 1);
    }
  }
}`;

let nextStorageDb = 1;

function storageOn(sandbox: ReturnType<typeof initializeSandbox>) {
  return getAdminStorageSandbox(sandbox, { dbName: `pyric-clock-seam:${nextStorageDb++}` });
}

describe('the sandbox clock drives Firestore', () => {
  it('stamps serverTimestamp() from the clock', async () => {
    const sandbox = initializeSandbox();
    getInternalEnv(sandbox).seed({ rules: OPEN_FIRESTORE_RULES, documents: {} });
    getClock(sandbox).set(FUTURE);

    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(db, 'things/a'), { at: serverTimestamp() });

    const stored = getInternalEnv(sandbox).snapshot()['things/a'];
    const at = stored?.['at'] as { toMillis(): number };
    expect(at.toMillis()).toBe(FUTURE);
  });

  it('follows an advance rather than the wall clock', async () => {
    const sandbox = initializeSandbox();
    getInternalEnv(sandbox).seed({ rules: OPEN_FIRESTORE_RULES, documents: {} });
    getClock(sandbox).set(FUTURE);
    getClock(sandbox).advance(90 * 60 * 1000);

    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(db, 'things/a'), { at: serverTimestamp() });

    const stored = getInternalEnv(sandbox).snapshot()['things/a'];
    const at = stored?.['at'] as { toMillis(): number };
    expect(at.toMillis()).toBe(FUTURE + 90 * 60 * 1000);
  });

  it('flips a request.time rule when the clock moves', async () => {
    const sandbox = initializeSandbox();
    getInternalEnv(sandbox).seed({ rules: TIME_GATED_FIRESTORE_RULES, documents: {} });
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    getClock(sandbox).set(FUTURE);
    await expect(setDoc(doc(db, 'things/a'), { v: 1 })).rejects.toThrow();

    getClock(sandbox).set(PAST);
    await setDoc(doc(db, 'things/a'), { v: 1 });
    expect(getInternalEnv(sandbox).snapshot()['things/a']).toEqual({ v: 1 });
  });

  it('carries the advanced time on a listener fired after the advance', async () => {
    const sandbox = initializeSandbox();
    getInternalEnv(sandbox).seed({ rules: OPEN_FIRESTORE_RULES, documents: {} });
    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

    const deliveries: number[] = [];
    const unsubscribeEvents = sandbox.onEvent((event) => {
      if (event.kind === 'snapshot_delivery') deliveries.push(event.at);
    });
    const unsubscribe = onSnapshot(doc(db, 'things/a'), () => {});

    getClock(sandbox).set(FUTURE);
    await setDoc(doc(db, 'things/a'), { v: 1 });
    await Bun.sleep(5);

    unsubscribe();
    unsubscribeEvents();
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries[deliveries.length - 1]).toBe(FUTURE);
  });
});

describe('the sandbox clock drives the Realtime Database', () => {
  it('resolves ServerValue.TIMESTAMP from the clock', async () => {
    const sandbox = initializeSandbox();
    getClock(sandbox).set(FUTURE);

    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
    await dbSet(dbRef(db, 'rooms/one/at'), rtdbServerTimestamp());

    expect((await dbGet(dbRef(db, 'rooms/one/at'))).val()).toBe(FUTURE);
  });

  it('flips a now-gated rule when the clock moves', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    rtdbSandbox.setRules(db, {
      rules: { '.read': true, '.write': 'now < 1735689600000' },
    });

    getClock(sandbox).set(FUTURE);
    await expect(dbSet(dbRef(db, 'rooms/one'), { title: 'first' })).rejects.toThrow();

    getClock(sandbox).set(PAST);
    await dbSet(dbRef(db, 'rooms/one'), { title: 'first' });
    expect((await dbGet(dbRef(db, 'rooms/one'))).val()).toEqual({ title: 'first' });
  });
});

describe('the sandbox clock drives Storage', () => {
  it('stamps timeCreated and updated from the clock', async () => {
    const sandbox = initializeSandbox();
    const storage = storageOn(sandbox);
    getClock(sandbox).set(FUTURE);

    await uploadBytes(storageRef(storage, 'docs/hello.txt'), new Uint8Array([1, 2, 3]));
    const metadata = await getMetadata(storageRef(storage, 'docs/hello.txt'));

    expect(metadata.timeCreated).toBe(new Date(FUTURE).toISOString());
    expect(metadata.updated).toBe(new Date(FUTURE).toISOString());
  });

  it('flips a request.time rule when the clock moves', async () => {
    const sandbox = initializeSandbox();
    const db = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: `pyric-clock-seam:${nextStorageDb++}`,
      rules: TIME_GATED_STORAGE_RULES,
    });

    getClock(sandbox).set(FUTURE);
    await expect(
      uploadBytes(storageRef(db, 'docs/hello.txt'), new Uint8Array([1])),
    ).rejects.toThrow();

    getClock(sandbox).set(PAST);
    await uploadBytes(storageRef(db, 'docs/hello.txt'), new Uint8Array([1]));
    const metadata = await getMetadata(storageRef(db, 'docs/hello.txt'));
    expect(metadata.timeCreated).toBe(new Date(PAST).toISOString());
  });
});

describe('the sandbox clock drives auth token minting', () => {
  it('mints iat, auth_time, and exp from the clock', async () => {
    const sandbox = initializeSandbox();
    getClock(sandbox).set(FUTURE);

    const auth = getAuth(sandbox);
    const credential = await signInAnonymously(auth);
    const result = await credential.user.getIdTokenResult();

    const issuedSeconds = Math.floor(FUTURE / 1000);
    expect(result.claims['iat']).toBe(issuedSeconds);
    expect(result.claims['auth_time']).toBe(issuedSeconds);
    expect(result.claims['exp']).toBeGreaterThan(issuedSeconds);
    expect(result.issuedAtTime).toBe(new Date(FUTURE).toISOString());
  });

  it('follows the clock on a forced refresh', async () => {
    const sandbox = initializeSandbox();
    getClock(sandbox).set(FUTURE);

    const auth = getAuth(sandbox);
    const credential = await signInAnonymously(auth);
    getClock(sandbox).advance(24 * 60 * 60 * 1000);
    const refreshed = await credential.user.getIdTokenResult(true);

    expect(refreshed.claims['iat']).toBe(Math.floor((FUTURE + 24 * 60 * 60 * 1000) / 1000));
  });
});

describe('reset returns the sandbox to the wall clock', () => {
  it('stamps a wall-clock serverTimestamp after reset', async () => {
    const sandbox = initializeSandbox();
    getInternalEnv(sandbox).seed({ rules: OPEN_FIRESTORE_RULES, documents: {} });
    getClock(sandbox).set(FUTURE);
    getClock(sandbox).reset();

    const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(db, 'things/a'), { at: serverTimestamp() });

    const stored = getInternalEnv(sandbox).snapshot()['things/a'];
    const at = stored?.['at'] as { toMillis(): number };
    expect(Math.abs(at.toMillis() - Date.now())).toBeLessThan(1000);
  });
});
