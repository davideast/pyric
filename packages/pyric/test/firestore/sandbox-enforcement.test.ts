/**
 * Firestore sandbox enforcement regression suite (PR 1 of #1058):
 * - FS-ENF-1: Transaction reads (`tx.get`) enforce `get` security rules.
 *   Evidence: Firebase transactions docs
 *   (https://firebase.google.com/docs/firestore/manage-data/transactions)
 *   and `observations/firestore/firestore-transaction-rules-denied-error.json`.
 * - FS-ENF-2a: In-page `getDoc`, `getCountFromServer`, `getAggregateFromServer`,
 *   `writeBatch.commit`, and `runTransaction` reject with `FirebaseError`.
 *   Evidence: `observations/firestore/firestore-read-denied-error-code.json`,
 *   `observations/firestore/firestore-transaction-rules-denied-error.json`.
 * - FS-ENF-3a/3b/3c: Denied document `onSnapshot` translates `FirestoreSimError`
 *   to `SandboxError`/`FirebaseError` with `denialContext`; errored live listeners
 *   do not resurrect on session auth change; cross-document `exists()`/`get()`
 *   revocation cancels active listeners with `permission-denied`.
 *   Evidence: Firebase listen-error docs and `production/probe-fs-enf-result.json`.
 * - FS-ENF-5: Missing-document `update` in `writeBatch` and `runTransaction`
 *   evaluates `update` rules with projected post-update resource before failing
 *   with `not-found` (`observations/firestore/firestore-updatedoc-missing-error.json`),
 *   nested `deleteField()` fails with `invalid-argument`, and remote-arm
 *   `batch.set`/`tx.set` forward `SetOptions`.
 * - FS-ENF-7: `writeBatch` and `runTransaction` enforce the 20-lookup aggregate
 *   budget across the atomic group in addition to 10 per operation.
 *   Evidence: https://firebase.google.com/docs/firestore/security/rules-structure#security_rule_limits
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import { FirebaseError } from '../../src/app/index.js';
import {
  getFirestore as getAdminCompatFirestore,
  onSnapshot as adminOnSnapshot,
} from 'pyric/sandbox/admin-firestore';
import { createRemoteFirestore } from '../../src/sandbox/admin-firestore/remote/remote-firestore.js';
import type { WireWrite } from '../../src/sandbox/admin-firestore/remote/wire-types.js';
import {
  collection,
  count,
  deleteDoc,
  deleteField,
  doc,
  getAdminFirestore,
  getAggregateFromServer,
  getCountFromServer,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  setDoc,
  sum,
  updateDoc,
  writeBatch,
} from '../../src/firestore/index.js';

function settle(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FS-ENF-1: transaction reads enforce get security rules', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /secrets/{id} {
      allow read, write: if false;
    }
    match /public/{id} {
      allow read, write: if true;
    }
    match /gated/{id} {
      allow read: if exists(/databases/$(database)/documents/acl/allow);
      allow write: if true;
    }
    match /acl/{id} {
      allow read, write: if true;
    }
  }
}`;

  it('rejects tx.get on a denied document without exposing data or committing writes', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(RULES);
    compat.seed({ documents: { 'secrets/s1': { apiKey: 'top-secret' } } });

    const db = getFirestore(sandbox);
    let leakedData: unknown = null;
    let caughtError: unknown = null;

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(doc(db, 'secrets/s1'));
        leakedData = snap.data();
        tx.set(doc(db, 'public/leak'), { leaked: leakedData });
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(FirebaseError);
    expect((caughtError as FirebaseError).code).toBe('permission-denied');
    expect(leakedData).toBeNull();
    const leakSnap = await getDoc(doc(db, 'public/leak'));
    expect(leakSnap.exists()).toBe(false);
  });

  it('rejects a read-only transaction when tx.get is denied by rules', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(RULES);
    compat.seed({ documents: { 'secrets/s1': { apiKey: 'top-secret' } } });

    const db = getFirestore(sandbox);
    let caughtError: unknown = null;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(doc(db, 'secrets/s1'));
        return snap.data();
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(FirebaseError);
    expect((caughtError as FirebaseError).code).toBe('permission-denied');
  });

  it('still rejects the transaction if the callback catches and swallows a denied tx.get', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(RULES);
    compat.seed({ documents: { 'secrets/s1': { apiKey: 'top-secret' } } });

    const db = getFirestore(sandbox);
    let caughtError: unknown = null;
    try {
      await runTransaction(db, async (tx) => {
        try {
          await tx.get(doc(db, 'secrets/s1'));
        } catch {
          // Intentionally swallowed by caller
        }
        tx.set(doc(db, 'public/after-swallow'), { ok: true });
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(FirebaseError);
    expect((caughtError as FirebaseError).code).toBe('permission-denied');
    const publicSnap = await getDoc(doc(db, 'public/after-swallow'));
    expect(publicSnap.exists()).toBe(false);
  });

  it('re-verifies get rules at commit when ACL changes during an async transaction callback', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(RULES);
    compat.seed({
      documents: {
        'gated/g1': { secret: 'classified' },
        'acl/allow': { ok: true },
      },
    });

    const db = getFirestore(sandbox);
    let caughtError: unknown = null;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(doc(db, 'gated/g1'));
        expect(snap.exists()).toBe(true);
        await deleteDoc(doc(db, 'acl/allow'));
        tx.set(doc(db, 'public/from-gated'), { copied: snap.data() });
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(FirebaseError);
    expect((caughtError as FirebaseError).code).toBe('permission-denied');
    const copiedSnap = await getDoc(doc(db, 'public/from-gated'));
    expect(copiedSnap.exists()).toBe(false);
  });

  it('preserves admin bypass on getAdminFirestore transactions under deny-all rules', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth(null));
    compat.setRules(RULES);
    compat.seed({ documents: { 'secrets/s1': { apiKey: 'top-secret' } } });

    const adminDb = getAdminFirestore(sandbox);
    const value = await runTransaction(adminDb, async (tx) => {
      const snap = await tx.get(doc(adminDb, 'secrets/s1'));
      tx.set(doc(adminDb, 'secrets/s2'), { copied: snap.data()?.apiKey });
      return snap.data()?.apiKey;
    });

    expect(value).toBe('top-secret');
    const copied = await getDoc(doc(adminDb, 'secrets/s2'));
    expect(copied.data()).toEqual({ copied: 'top-secret' });
  });
});

describe('FS-ENF-2a: in-page pyric/firestore operations reject with FirebaseError', () => {
  // Evidence: observations/firestore/firestore-read-denied-error-code.json,
  // observations/firestore/firestore-transaction-rules-denied-error.json
  const DENY_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

  it('translates getDoc, getCountFromServer, getAggregateFromServer, writeBatch.commit, and runTransaction rejections to FirebaseError', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(DENY_ALL);
    compat.seed({ documents: { 'items/i1': { price: 10 } } });
    const db = getFirestore(sandbox);

    const operations: Array<[string, () => Promise<unknown>]> = [
      ['getDoc', () => getDoc(doc(db, 'items/i1'))],
      ['getDocs', () => getDocs(collection(db, 'items'))],
      ['getCountFromServer', () => getCountFromServer(collection(db, 'items'))],
      ['getAggregateFromServer', () => getAggregateFromServer(collection(db, 'items'), { total: sum('price'), n: count() })],
      ['setDoc', () => setDoc(doc(db, 'items/i2'), { price: 20 })],
      ['writeBatch.commit', () => {
        const b = writeBatch(db);
        b.set(doc(db, 'items/i2'), { price: 20 });
        return b.commit();
      }],
      ['runTransaction', () => runTransaction(db, async (tx) => {
        tx.set(doc(db, 'items/i2'), { price: 20 });
      })],
    ];

    for (const [label, op] of operations) {
      let caught: unknown = null;
      try {
        await op();
      } catch (error) {
        caught = error;
      }
      expect(caught, `${label} should reject with FirebaseError`).toBeInstanceOf(FirebaseError);
      const fbErr = caught as FirebaseError & { denialContext?: unknown };
      expect(fbErr.name).toBe('FirebaseError');
      expect(fbErr.code).toBe('permission-denied');
      expect(fbErr.denialContext).toBeDefined();
    }
  });
});

describe('FS-ENF-3a/3b/3c: listener error translation, termination on error, and cross-doc lookup revocation', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow read: if request.auth != null && request.auth.uid == 'alice';
      allow write: if true;
    }
    match /gatedExists/{id} {
      allow read: if exists(/databases/$(database)/documents/acl/allow);
      allow write: if true;
    }
    match /gatedGet/{id} {
      allow read: if get(/databases/$(database)/documents/acl/config).data.enabled == true;
      allow write: if true;
    }
    match /acl/{id} {
      allow read, write: if true;
    }
  }
}`;

  it('FS-ENF-3a: translates denied document onSnapshot errors to SandboxError and FirebaseError with denialContext', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth(null));
    compat.setRules(RULES);
    compat.seed({ documents: { 'docs/d1': { text: 'hello' } } });

    const compatErr = await new Promise<unknown>((resolve) => {
      adminOnSnapshot(compat.doc('docs/d1'), () => {}, (err) => resolve(err));
    });
    expect(compatErr).toBeInstanceOf(Error);
    expect(compatErr).toBeInstanceOf(SandboxError);
    expect((compatErr as SandboxError).code).toBe('permission-denied');
    expect((compatErr as SandboxError).denialContext).toBeDefined();

    const db = getFirestore(sandbox);
    const modularErr = await new Promise<unknown>((resolve) => {
      onSnapshot(doc(db, 'docs/d1'), () => {}, (err) => resolve(err));
    });
    expect(modularErr).toBeInstanceOf(Error);
    expect(modularErr).toBeInstanceOf(FirebaseError);
    expect((modularErr as FirebaseError).code).toBe('permission-denied');
    expect((modularErr as FirebaseError & { denialContext?: unknown }).denialContext).toBeDefined();
  });

  it('FS-ENF-3b: does not resurrect an errored live listener after signing in as an authorized user', async () => {
    // Evidence: https://firebase.google.com/docs/firestore/query-data/listen#handle_listen_errors
    // ("After an error, the listener will not receive any more events")
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth(null));
    compat.setRules(RULES);
    compat.seed({ documents: { 'docs/d1': { text: 'hello' } } });

    const db = getFirestore(sandbox);
    let deliveriesAfterError = 0;
    let errorCount = 0;
    onSnapshot(
      doc(db, 'docs/d1'),
      () => { deliveriesAfterError++; },
      () => { errorCount++; },
    );
    await settle();
    expect(errorCount).toBe(1);
    expect(deliveriesAfterError).toBe(0);

    sandbox.currentUser = { uid: 'alice' };
    await settle();
    expect(deliveriesAfterError).toBe(0);
    expect(errorCount).toBe(1);

    // Meanwhile, a live listener attached while authorized stays alive across
    // a deployRules hot-reload and still receives subsequent write deliveries.
    const liveSnapshots: unknown[] = [];
    const unsubLive = onSnapshot(doc(db, 'docs/d1'), (snap) => {
      liveSnapshots.push(snap.data());
    });
    await settle();
    expect(liveSnapshots).toEqual([{ text: 'hello' }]);
    compat.setRules(`${RULES}\n// hot-reload comment`);
    await setDoc(doc(db, 'docs/d1'), { text: 'after-deploy-rules' });
    await settle();
    expect(liveSnapshots).toEqual([{ text: 'hello' }, { text: 'after-deploy-rules' }]);
    unsubLive();
  });

  it('FS-ENF-3c: cancels an active doc or query listener with permission-denied when a cross-doc exists()/get() dependency is revoked', async () => {
    // Evidence: production/probe-fs-enf-result.json (active listener on gated/g1
    // cancelled with permission-denied ~30 ms after acl/allow is deleted).
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth(null));
    compat.setRules(RULES);
    compat.seed({
      documents: {
        'gatedExists/g1': { secret: 'one' },
        'gatedGet/g1': { secret: 'two' },
        'acl/allow': { ok: true },
        'acl/config': { enabled: true },
      },
    });

    const db = getFirestore(sandbox);
    const docSnaps: unknown[] = [];
    const docErrors: unknown[] = [];
    const querySnaps: unknown[] = [];
    const queryErrors: unknown[] = [];

    const unsubDoc = onSnapshot(
      doc(db, 'gatedExists/g1'),
      (snap) => docSnaps.push(snap.data()),
      (err) => docErrors.push(err),
    );
    const unsubQuery = onSnapshot(
      collection(db, 'gatedGet'),
      (snap) => querySnaps.push(snap.docs.map((d) => d.data())),
      (err) => queryErrors.push(err),
    );
    await settle();
    expect(docSnaps).toEqual([{ secret: 'one' }]);
    expect(querySnaps).toEqual([[{ secret: 'two' }]]);
    expect(docErrors).toHaveLength(0);
    expect(queryErrors).toHaveLength(0);

    await deleteDoc(doc(db, 'acl/allow'));
    await updateDoc(doc(db, 'acl/config'), { enabled: false });
    await settle();

    expect(docErrors).toHaveLength(1);
    expect(docErrors[0]).toBeInstanceOf(FirebaseError);
    expect((docErrors[0] as FirebaseError).code).toBe('permission-denied');

    expect(queryErrors).toHaveLength(1);
    expect(queryErrors[0]).toBeInstanceOf(FirebaseError);
    expect((queryErrors[0] as FirebaseError).code).toBe('permission-denied');

    unsubDoc();
    unsubQuery();
  });
});

describe('FS-ENF-5: atomic missing-doc update rules evaluation, nested deleteField, and remote SetOptions', () => {
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow create, read: if true;
      allow update: if request.resource.data.x == 1;
    }
  }
}`;

  it('evaluates update rules with projected post-update resource on missing docs and reports not-found when allowed', async () => {
    // Evidence: observations/firestore/firestore-updatedoc-missing-error.json
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(RULES);
    const db = getFirestore(sandbox);

    const singleErr = await updateDoc(doc(db, 'docs/missing-single'), { x: 1 }).catch((e) => e);
    const batchAllowed = writeBatch(db);
    batchAllowed.update(doc(db, 'docs/missing-batch'), { x: 1 });
    const batchErr = await batchAllowed.commit().catch((e) => e);
    const txErr = await runTransaction(db, async (tx) => {
      tx.update(doc(db, 'docs/missing-tx'), { x: 1 });
    }).catch((e) => e);

    expect((singleErr as FirebaseError).code).toBe('not-found');
    expect((batchErr as FirebaseError).code).toBe('not-found');
    expect((txErr as FirebaseError).code).toBe('not-found');

    const batchDenied = writeBatch(db);
    batchDenied.update(doc(db, 'docs/missing-denied'), { x: 2 });
    const deniedErr = await batchDenied.commit().catch((e) => e);
    expect((deniedErr as FirebaseError).code).toBe('permission-denied');
  });

  it('rejects nested deleteField() on a missing doc in writeBatch.update with invalid-argument', async () => {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(RULES);
    const db = getFirestore(sandbox);

    const b = writeBatch(db);
    b.update(doc(db, 'docs/missing-nested'), { arr: [deleteField()] });
    const err = await b.commit().catch((e) => e);
    expect(err).toBeInstanceOf(FirebaseError);
    expect((err as FirebaseError).code).toBe('invalid-argument');
  });

  it('forwards SetOptions ({ merge: true } and { mergeFields }) from remote batch.set and tx.set', async () => {
    const recordedOps: Array<{ method?: string; writes?: WireWrite[] }> = [];
    const fakeRemoteSandbox = {
      channel: {
        async op(payload: { method?: string; writes?: WireWrite[] }) {
          recordedOps.push(payload);
          return null;
        },
        subscribe() { return () => {}; },
      },
    };

    const remoteDb = createRemoteFirestore(fakeRemoteSandbox as never, { mode: 'admin' });
    const batch = remoteDb.batch();
    batch.set(remoteDb.doc('docs/b1'), { b: 2 }, { merge: true });
    batch.set(remoteDb.doc('docs/b2'), { b: 2, c: 3 }, { mergeFields: ['b'] });
    await batch.commit();

    await remoteDb.runTransaction(async (tx) => {
      tx.set(remoteDb.doc('docs/t1'), { b: 2 }, { merge: true });
      tx.set(remoteDb.doc('docs/t2'), { b: 2, c: 3 }, { mergeFields: ['b'] });
    });

    expect(recordedOps).toHaveLength(2);
    expect(recordedOps[0]?.writes?.[0]?.options).toEqual({ merge: true });
    expect(recordedOps[0]?.writes?.[1]?.options).toEqual({ mergeFields: ['b'] });
    expect(recordedOps[1]?.writes?.[0]?.options).toEqual({ merge: true });
    expect(recordedOps[1]?.writes?.[1]?.options).toEqual({ mergeFields: ['b'] });
  });
});

describe('FS-ENF-7: 20-lookup aggregate limit across writeBatch and runTransaction', () => {
  // Evidence: https://firebase.google.com/docs/firestore/security/rules-structure#security_rule_limits
  const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /groupA/{id} {
      allow read, write: if
        exists(/databases/$(database)/documents/Look/a1) &&
        exists(/databases/$(database)/documents/Look/a2) &&
        exists(/databases/$(database)/documents/Look/a3) &&
        exists(/databases/$(database)/documents/Look/a4) &&
        exists(/databases/$(database)/documents/Look/a5) &&
        exists(/databases/$(database)/documents/Look/a6) &&
        exists(/databases/$(database)/documents/Look/a7) &&
        exists(/databases/$(database)/documents/Look/a8);
    }
    match /groupB/{id} {
      allow read, write: if
        exists(/databases/$(database)/documents/Look/b1) &&
        exists(/databases/$(database)/documents/Look/b2) &&
        exists(/databases/$(database)/documents/Look/b3) &&
        exists(/databases/$(database)/documents/Look/b4) &&
        exists(/databases/$(database)/documents/Look/b5) &&
        exists(/databases/$(database)/documents/Look/b6) &&
        exists(/databases/$(database)/documents/Look/b7) &&
        exists(/databases/$(database)/documents/Look/b8);
    }
    match /groupC/{id} {
      allow read, write: if
        exists(/databases/$(database)/documents/Look/c1) &&
        exists(/databases/$(database)/documents/Look/c2) &&
        exists(/databases/$(database)/documents/Look/c3) &&
        exists(/databases/$(database)/documents/Look/c4) &&
        exists(/databases/$(database)/documents/Look/c5) &&
        exists(/databases/$(database)/documents/Look/c6) &&
        exists(/databases/$(database)/documents/Look/c7) &&
        exists(/databases/$(database)/documents/Look/c8);
    }
  }
}`;

  function seedLookupDocs() {
    const sandbox = initializeSandbox();
    const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
    compat.setRules(RULES);
    const docs: Record<string, { ok: boolean }> = {};
    for (const prefix of ['a', 'b', 'c']) {
      for (let i = 1; i <= 8; i++) {
        docs[`Look/${prefix}${i}`] = { ok: true };
      }
    }
    docs['groupA/d1'] = { ok: true };
    compat.seed({ documents: docs });
    return { sandbox, db: getFirestore(sandbox) };
  }

  it('denies a writeBatch whose distinct lookups across operations exceed 20 (3 × 8 = 24 > 20)', async () => {
    const { db } = seedLookupDocs();
    const batch = writeBatch(db);
    batch.set(doc(db, 'groupA/d1'), { x: 1 });
    batch.set(doc(db, 'groupB/d1'), { x: 1 });
    batch.set(doc(db, 'groupC/d1'), { x: 1 });

    const err = await batch.commit().catch((e) => e);
    expect(err).toBeInstanceOf(FirebaseError);
    expect((err as FirebaseError).code).toBe('permission-denied');
  });

  it('allows a writeBatch with <= 20 distinct lookups across operations (2 × 8 = 16 <= 20) or cached repeat lookups', async () => {
    const { db } = seedLookupDocs();
    const batch16 = writeBatch(db);
    batch16.set(doc(db, 'groupA/d1'), { x: 1 });
    batch16.set(doc(db, 'groupB/d1'), { x: 1 });
    await expect(batch16.commit()).resolves.toBeUndefined();

    const batchCached = writeBatch(db);
    batchCached.set(doc(db, 'groupA/d1'), { x: 2 });
    batchCached.set(doc(db, 'groupA/d2'), { x: 2 });
    batchCached.set(doc(db, 'groupA/d3'), { x: 2 });
    await expect(batchCached.commit()).resolves.toBeUndefined();
  });

  it('denies a runTransaction whose combined read + write rule lookups exceed 20', async () => {
    const { db } = seedLookupDocs();
    const err = await runTransaction(db, async (tx) => {
      await tx.get(doc(db, 'groupA/d1'));
      tx.set(doc(db, 'groupB/d1'), { x: 1 });
      tx.set(doc(db, 'groupC/d1'), { x: 1 });
    }).catch((e) => e);

    expect(err).toBeInstanceOf(FirebaseError);
    expect((err as FirebaseError).code).toBe('permission-denied');
  });
});
