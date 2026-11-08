import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getAdminFirestore,
  getFirestore as getAdminCompatFirestore,
  onSnapshot as adminOnSnapshot,
} from 'pyric/sandbox/admin-firestore';
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  setDoc,
} from 'pyric/firestore';
import { computeAggregate } from '../../src/firestore/sandbox/admin-compat/query-aggregate.js';
import { getInternalEnv } from 'pyric/sandbox/internal';

const STRICT_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow read, write: if request.auth != null && request.auth.uid == 'owner-1';
    }
  }
}`;

describe('Firestore onSnapshot observer binding, partial observers, and relative path segment validation', () => {
  it('binds observer.next and observer.error to the observer object in pyric/firestore onSnapshot', async () => {
    const sandbox = initializeSandbox();
    try {
      getAdminCompatFirestore(sandbox.withAuth(null)).setRules(STRICT_RULES);
      const ownerDb = getFirestore(sandbox.withAuth({ uid: 'owner-1' }));
      const guestDb = getFirestore(sandbox.withAuth({ uid: 'guest-1' }));
      await setDoc(doc(ownerDb, 'items/i1'), { title: 'alpha' });

      const nextReceivers: unknown[] = [];
      const nextObserver = {
        tag: 'client-next-obs',
        next(this: unknown) {
          nextReceivers.push(this);
        },
      };
      const unsubNext = onSnapshot(doc(ownerDb, 'items/i1'), nextObserver);
      await new Promise<void>((r) => queueMicrotask(r));
      unsubNext();
      expect(nextReceivers).toEqual([nextObserver]);

      const errorReceivers: unknown[] = [];
      const errorCodes: unknown[] = [];
      const errorObserver = {
        tag: 'client-err-obs',
        error(this: unknown, err: unknown) {
          errorReceivers.push(this);
          errorCodes.push((err as { code?: string })?.code);
        },
      };
      const unsubErr = onSnapshot(doc(guestDb, 'items/i1'), errorObserver);
      await new Promise<void>((r) => queueMicrotask(r));
      unsubErr();
      expect(errorCodes).toEqual(['permission-denied']);
      expect(errorReceivers).toEqual([errorObserver]);
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });

  it('binds observer methods and accepts { complete() {} } partial observers in pyric/sandbox/admin-firestore onSnapshot', async () => {
    const sandbox = initializeSandbox();
    try {
      getAdminCompatFirestore(sandbox.withAuth(null)).setRules(STRICT_RULES);
      const adminDb = getAdminFirestore(sandbox);
      const ownerCompat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'owner-1' }));
      const guestCompat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'guest-1' }));
      await adminDb.doc('items/i1').set({ title: 'beta' });

      const nextReceivers: unknown[] = [];
      const nextObs = {
        tag: 'admin-next-obs',
        next(this: unknown) {
          nextReceivers.push(this);
        },
      };
      const unsubNext = adminOnSnapshot(ownerCompat.doc('items/i1'), nextObs);
      await new Promise<void>((r) => queueMicrotask(r));
      unsubNext();
      expect(nextReceivers).toEqual([nextObs]);

      const errReceivers: unknown[] = [];
      const errObs = {
        tag: 'admin-err-obs',
        error(this: unknown) {
          errReceivers.push(this);
        },
      };
      const unsubErr = adminOnSnapshot(guestCompat.doc('items/i1'), errObs);
      await new Promise<void>((r) => queueMicrotask(r));
      unsubErr();
      expect(errReceivers).toEqual([errObs]);

      // Partial observer with only `complete` is accepted in both direct and options-first forms
      const unsubCompleteDirect = adminOnSnapshot(ownerCompat.doc('items/i1'), {
        complete() {},
      });
      expect(typeof unsubCompleteDirect).toBe('function');
      unsubCompleteDirect();

      const unsubCompleteOptions = adminOnSnapshot(
        ownerCompat.doc('items/i1'),
        { includeMetadataChanges: false },
        { complete() {} },
      );
      expect(typeof unsubCompleteOptions).toBe('function');
      unsubCompleteOptions();
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });

  it('validates odd/even segment parity on docRef.collection() and collRef.doc() across admin-firestore and pyric/firestore', () => {
    const sandbox = initializeSandbox();
    try {
      const compatDb = getAdminCompatFirestore(sandbox.withAuth({ uid: 'owner-1' }));
      const clientDb = getFirestore(sandbox.withAuth({ uid: 'owner-1' }));

      // Valid multi-segment relative paths still work
      expect(compatDb.doc('items/i1').collection('notes/n1/replies').path).toBe('items/i1/notes/n1/replies');
      expect(compatDb.collection('items').doc('i1/notes/n1').path).toBe('items/i1/notes/n1');
      expect(collection(doc(clientDb, 'items/i1'), 'notes/n1/replies').path).toBe('items/i1/notes/n1/replies');
      expect(doc(collection(clientDb, 'items'), 'i1/notes/n1').path).toBe('items/i1/notes/n1');

      // Invalid segment parity or empty segment throws code === 'invalid-argument'
      const invalidCases: Array<() => unknown> = [
        () => compatDb.collection(''),
        () => compatDb.doc(''),
        () => compatDb.doc('items/i1').collection('notes/n1'),
        () => compatDb.collection('items').doc('i1/notes'),
        () => collection(clientDb, ''),
        () => doc(clientDb, ''),
        () => collection(doc(clientDb, 'items/i1'), 'notes/n1'),
        () => doc(collection(clientDb, 'items'), 'i1/notes'),
      ];

      for (const invoke of invalidCases) {
        let caught: unknown;
        try {
          invoke();
        } catch (e) {
          caught = e;
        }
        expect((caught as { code?: string })?.code).toBe('invalid-argument');
      }

      // Object.hasOwn guard in aggregateFieldValue ignores inherited prototype numbers
      const protoBacked = Object.assign(Object.create({ inheritedScore: 99, nested: { inherited: 77 } }), {
        ownScore: 12,
      }) as Record<string, unknown>;
      expect(computeAggregate({ kind: 'sum', field: 'inheritedScore' }, [{ data: protoBacked }])).toBe(0);
      expect(computeAggregate({ kind: 'sum', field: 'nested.inherited' }, [{ data: protoBacked }])).toBe(0);
      expect(computeAggregate({ kind: 'sum', field: 'ownScore' }, [{ data: protoBacked }])).toBe(12);
    } finally {
      getInternalEnv(sandbox).dispose();
    }
  });
});
