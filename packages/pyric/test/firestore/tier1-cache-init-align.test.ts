/**
 * `pyric/firestore` tier-1 cache-init + get-from-* + log-level +
 * snapshot-sync family (issue #144, tier-1 pass).
 *
 * The anchor pattern is a real app's explicit-init call:
 *
 *   const db = initializeFirestore(app, {
 *     localCache: persistentLocalCache(persistentMultipleTabManager()),
 *   });
 *
 * Before this change, `initializeFirestore`, the six cache-factory
 * tokens, `getDocFromServer`/`getDocsFromServer`,
 * `getDocFromCache`/`getDocsFromCache`, `setLogLevel`, and
 * `onSnapshotsInSync` were not exported from `pyric/firestore` at
 * all — importing any of them from an app bundled under pyric would
 * fail at import time (a missing named export), crashing before the
 * app ever got to a read or write.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  getDocFromServer,
  getDocsFromServer,
  getDocFromCache,
  getDocsFromCache,
  initializeFirestore,
  persistentLocalCache,
  memoryLocalCache,
  persistentSingleTabManager,
  persistentMultipleTabManager,
  memoryEagerGarbageCollector,
  memoryLruGarbageCollector,
  setLogLevel,
  onSnapshotsInSync,
  collection,
  query,
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

describe('real-app init sequence — tier-1 cache-init + get-from-* family', () => {
  it('initializeFirestore(app, { localCache: persistentLocalCache(persistentMultipleTabManager()) }) no longer crashes and returns a usable Firestore', async () => {
    const { sandbox } = setup();
    const db = initializeFirestore(sandbox.withAuth({ uid: 'alice' }) as never, {
      localCache: persistentLocalCache(persistentMultipleTabManager()),
    });
    setRules(sandbox, RULES);

    const ref = doc(db, 'notes/n1');
    await setDoc(ref, { text: 'hello' });
    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ text: 'hello' });
  });

  it('initializeFirestore accepts persistentSingleTabManager + memory cache variants without crashing', () => {
    const { sandbox } = setup();
    expect(() =>
      initializeFirestore(sandbox as never, {
        localCache: persistentLocalCache(persistentSingleTabManager(undefined)),
      }),
    ).not.toThrow();
    expect(() =>
      initializeFirestore(sandbox as never, {
        localCache: memoryLocalCache({ garbageCollector: memoryEagerGarbageCollector() }),
      }),
    ).not.toThrow();
    expect(() =>
      initializeFirestore(sandbox as never, {
        localCache: memoryLocalCache({ garbageCollector: memoryLruGarbageCollector({ cacheSizeBytes: 1000000 }) }),
      }),
    ).not.toThrow();
  });
});

describe('cache-factory tokens', () => {
  it('return distinct, inert tagged objects that do not crash on construction or use', () => {
    const tabSingle = persistentSingleTabManager(undefined);
    const tabMultiple = persistentMultipleTabManager();
    const gcEager = memoryEagerGarbageCollector();
    const gcLru = memoryLruGarbageCollector();
    const persistent = persistentLocalCache({ tabManager: tabMultiple });
    const memory = memoryLocalCache({ garbageCollector: gcEager });

    expect(tabSingle).toBeTruthy();
    expect(tabMultiple).toBeTruthy();
    expect(gcEager).toBeTruthy();
    expect(gcLru).toBeTruthy();
    expect(persistent).toBeTruthy();
    expect(memory).toBeTruthy();
    // distinct identities — not the same object reused
    expect(tabSingle).not.toBe(tabMultiple);
    expect(gcEager).not.toBe(gcLru);
  });
});

describe('getDocFromServer / getDocsFromServer', () => {
  it('getDocFromServer returns the current authoritative doc (sandbox store is the source of truth)', async () => {
    const { db } = setup();
    const ref = doc(db, 'notes/n1');
    await setDoc(ref, { text: 'hello' });
    const snap = await getDocFromServer(ref);
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ text: 'hello' });
  });

  it('getDocsFromServer returns the current authoritative query results', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'notes/n1'), { text: 'hello' });
    const snap = await getDocsFromServer(query(collection(db, 'notes')));
    expect(snap.size).toBe(1);
  });
});

describe('getDocFromCache / getDocsFromCache', () => {
  it('getDocFromCache returns the doc and does NOT throw unavailable on what would be a cache miss in prod', async () => {
    const { db } = setup();
    const ref = doc(db, 'notes/never-written');
    // Real Firebase throws 'unavailable' here on a genuine cache miss;
    // pyric's local store always has the answer (or a non-existent
    // snapshot), so it never throws for that reason.
    const snap = await getDocFromCache(ref);
    expect(snap.exists()).toBe(false);
  });

  it('getDocsFromCache returns current query results without throwing', async () => {
    const { db } = setup();
    await setDoc(doc(db, 'notes/n1'), { text: 'hello' });
    const snap = await getDocsFromCache(query(collection(db, 'notes')));
    expect(snap.size).toBe(1);
  });
});

describe('setLogLevel', () => {
  it('accepts a log level without throwing (accepted no-op)', () => {
    expect(() => setLogLevel('debug')).not.toThrow();
    expect(() => setLogLevel('silent')).not.toThrow();
  });
});

describe('onSnapshotsInSync', () => {
  it('fires the callback after snapshot delivery settles, and unsubscribe stops further calls', async () => {
    const { db } = setup();
    let calls = 0;
    const unsubscribe = onSnapshotsInSync(db, () => {
      calls++;
    });

    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(calls).toBeGreaterThanOrEqual(1);

    unsubscribe();
    const callsAfterUnsub = calls;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(callsAfterUnsub);
  });

  it('accepts an observer object with a next() callback', async () => {
    const { db } = setup();
    let fired = false;
    const unsubscribe = onSnapshotsInSync(db, {
      next: () => {
        fired = true;
      },
    });
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(fired).toBe(true);
    unsubscribe();
  });
});
