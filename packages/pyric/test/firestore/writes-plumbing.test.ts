import { describe, expect, it } from 'bun:test';
import { FirebaseError } from '../../src/app/index.ts';
import { initializeSandbox } from '../../src/sandbox/index.ts';
import {
  FieldValue,
  arrayRemove,
  arrayUnion,
  connectFirestoreEmulator,
  deleteField,
  doc,
  ensureFirestoreConfigured,
  executeWrite,
  getFirestore,
  increment,
  serverTimestamp,
  setDoc,
  terminate,
  updateDoc,
  vector,
} from '../../src/firestore/index.ts';

describe('Firestore low-level public write plumbing and FieldValue class', () => {
  it('makes sentinels instances of FieldValue with structural isEqual', () => {
    expect(deleteField() instanceof FieldValue).toBe(true);
    expect(serverTimestamp() instanceof FieldValue).toBe(true);
    expect(increment(2) instanceof FieldValue).toBe(true);
    expect(arrayUnion('a') instanceof FieldValue).toBe(true);
    expect(arrayRemove('a') instanceof FieldValue).toBe(true);
    expect(vector([1, 2]) instanceof FieldValue).toBe(false);

    expect(deleteField().isEqual(deleteField())).toBe(true);
    expect(deleteField().isEqual(serverTimestamp())).toBe(false);
    expect(increment(2).isEqual(increment(2))).toBe(true);
    expect(increment(Number.NaN).isEqual(increment(Number.NaN))).toBe(true);
    expect(increment(2).isEqual(increment(3))).toBe(false);
    expect(arrayUnion('a', 1).isEqual(arrayUnion('a', 1))).toBe(true);
    expect(arrayUnion('a', 1).isEqual(arrayUnion(1, 'a'))).toBe(false);
    expect(arrayUnion('a').isEqual(arrayRemove('a'))).toBe(false);
  });

  it('starts db on ensureFirestoreConfigured/executeWrite and throws synchronously after terminate', async () => {
    const sandbox = await initializeSandbox();
    try {
      const db = getFirestore(sandbox);
      const client = ensureFirestoreConfigured(db);
      expect(typeof client).toBe('object');
      expect(client).not.toBeNull();
      expect(() => connectFirestoreEmulator(db, '127.0.0.1', 8080)).toThrow(FirebaseError);

      await expect(executeWrite(db, [])).resolves.toBeUndefined();
      const ref = doc(db, 'items/plumbing-1');
      await setDoc(ref, { tags: ['alpha'] });
      expect(() => updateDoc(ref, { tags: arrayUnion(undefined) })).toThrow(FirebaseError);
      await terminate(db);

      expect(() => ensureFirestoreConfigured(db)).toThrow(FirebaseError);
      let syncThrew = false;
      try {
        void executeWrite(db, []);
      } catch (err) {
        syncThrew = err instanceof FirebaseError && err.code === 'failed-precondition';
      }
      expect(syncThrew).toBe(true);
    } finally {
      await sandbox.dispose();
    }
  });
});
