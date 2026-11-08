import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore, getFirestore } from 'pyric/sandbox/admin-firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{id} {
      allow read, write: if request.auth != null;
    }
    match /items/{id} {
      allow read: if request.auth != null;
    }
    match /secretItems/{id} {
      allow read: if false;
    }
  }
}`;

describe('Firestore transaction query read-after-write ordering', () => {
  it('rejects tx.get(query) with failed-precondition after a write even when the query matches zero documents', async () => {
    const sandbox = initializeSandbox();
    try {
      const adminDb = getAdminFirestore(sandbox);
      getFirestore(sandbox.withAuth(null)).setRules(RULES);

      const userDb = getFirestore(sandbox.withAuth({ uid: 'user-1' }));
      let caught: { code?: string } | undefined;
      try {
        await userDb.runTransaction(async (tx) => {
          tx.set(userDb.doc('orders/o-1'), { ownerId: 'user-1', amount: 25 });
          await tx.get(userDb.collection('items'));
        });
      } catch (err) {
        caught = err as { code?: string };
      }

      expect(caught).toBeDefined();
      expect(caught?.code).toBe('failed-precondition');
      const persisted = await adminDb.doc('orders/o-1').get();
      expect(persisted.exists).toBe(false);
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });

  it('checks read-after-write before evaluating list security rules on tx.get(query)', async () => {
    const sandbox = initializeSandbox();
    try {
      const adminDb = getAdminFirestore(sandbox);
      await adminDb.doc('secretItems/s-1').set({ label: 'hidden' });
      getFirestore(sandbox.withAuth(null)).setRules(RULES);

      const userDb = getFirestore(sandbox.withAuth({ uid: 'user-1' }));
      let caught: { code?: string } | undefined;
      try {
        await userDb.runTransaction(async (tx) => {
          tx.set(userDb.doc('orders/o-2'), { ownerId: 'user-1', amount: 50 });
          await tx.get(userDb.collection('secretItems'));
        });
      } catch (err) {
        caught = err as { code?: string };
      }

      expect(caught).toBeDefined();
      expect(caught?.code).toBe('failed-precondition');
      const persisted = await adminDb.doc('orders/o-2').get();
      expect(persisted.exists).toBe(false);
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });
});
