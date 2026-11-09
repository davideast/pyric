import { describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  runTransaction,
  setDoc,
  writeBatch,
} from 'pyric/firestore';

async function isAllowed(operation: Promise<unknown>): Promise<boolean> {
  try {
    await operation;
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === 'permission-denied') return false;
    throw err;
  }
}

describe('Firestore transaction and atomic write security rules semantics', () => {
  it('evaluates request.time during runTransaction tx.get() against SandboxClock instead of host wall-clock time', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow get: if request.time > resource.data.unlocksAt;
    }
    match /items/{id} {
      allow get: if request.time < resource.data.expiresAt;
    }
  }
}`;

    const sb = initializeSandbox({ projectId: 'tx-get-sandbox-clock' });
    const adminDb = getAdminFirestore(sb);
    const boundary = new Date('2025-06-01T00:00:00Z');
    await setDoc(doc(adminDb, 'docs/doc-1'), { unlocksAt: boundary, value: 'future' });
    await setDoc(doc(adminDb, 'items/item-1'), { expiresAt: boundary, value: 'active' });
    setRules(sb, rules);

    getClock(sb).set(Date.parse('2025-01-01T00:00:00Z'));

    const db = getFirestore(sb.withAuth({ uid: 'user-1' }));
    expect(await isAllowed(getDoc(doc(db, 'docs/doc-1')))).toBe(false);
    expect(await isAllowed(getDoc(doc(db, 'items/item-1')))).toBe(true);

    expect(
      await isAllowed(
        runTransaction(db, async (tx) => {
          const snap = await tx.get(doc(db, 'docs/doc-1'));
          return snap.data();
        }),
      ),
    ).toBe(false);

    const activeData = await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'items/item-1'));
      return snap.data();
    });
    expect(activeData?.value).toBe('active');

    getClock(sb).set(Date.parse('2030-01-01T00:00:00Z'));
    const unlockedData = await runTransaction(db, async (tx) => {
      const snap = await tx.get(doc(db, 'docs/doc-1'));
      return snap.data();
    });
    expect(unlockedData?.value).toBe('future');
    expect(
      await isAllowed(
        runTransaction(db, async (tx) => {
          const snap = await tx.get(doc(db, 'items/item-1'));
          return snap.data();
        }),
      ),
    ).toBe(false);

    await sb.dispose();
  });

  it('evaluates atomic set followed by update on a new document as create against the net post-commit document', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow read: if true;
      allow create: if request.resource.data.ownerId == request.auth.uid;
      allow update: if resource.data.ownerId == request.auth.uid
        && request.resource.data.ownerId == request.auth.uid;
    }
  }
}`;

    const sb = initializeSandbox({ projectId: 'atomic-set-then-update-new-doc' });
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'user-1' }));

    const batch = writeBatch(db);
    const batchRef = doc(db, 'docs/batch-1');
    batch.set(batchRef, { ownerId: 'user-1', count: 1 });
    batch.update(batchRef, { count: 2 });
    await batch.commit();
    expect((await getDoc(batchRef)).data()).toEqual({ ownerId: 'user-1', count: 2 });

    const txRef = doc(db, 'docs/tx-1');
    await runTransaction(db, async (tx) => {
      tx.set(txRef, { ownerId: 'user-1', count: 1 });
      tx.update(txRef, { count: 2 });
    });
    expect((await getDoc(txRef)).data()).toEqual({ ownerId: 'user-1', count: 2 });

    // Net final document violating `allow create` must still be denied
    const badBatch = writeBatch(db);
    const badRef = doc(db, 'docs/bad-1');
    badBatch.set(badRef, { ownerId: 'user-1', count: 1 });
    badBatch.update(badRef, { ownerId: 'user-2' });
    expect(await isAllowed(badBatch.commit())).toBe(false);

    // Bare update on a missing document without an earlier set must still fail
    const missingBatch = writeBatch(db);
    missingBatch.update(doc(db, 'docs/missing-1'), { ownerId: 'user-1', count: 1 });
    expect(await isAllowed(missingBatch.commit())).toBe(false);

    await sb.dispose();
  });
});
