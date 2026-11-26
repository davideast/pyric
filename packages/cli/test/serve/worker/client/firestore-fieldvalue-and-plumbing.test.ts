import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import { FieldValue, vector } from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { connectFirestoreEmulator } from '../../../../src/serve/worker/client/firestore-emulator.js';
import {
  ensureFirestoreConfigured,
  executeWrite,
  terminate,
} from '../../../../src/serve/worker/client/firestore-lifecycle.js';
import { getDoc } from '../../../../src/serve/worker/client/firestore-reads.js';
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteField,
  doc,
  increment,
  maximum,
  minimum,
  query,
  serverTimestamp,
  where,
} from '../../../../src/serve/worker/client/firestore-refs.js';
import {
  disableNetwork,
  enableNetwork,
} from '../../../../src/serve/worker/client/firestore-network.js';
import {
  runTransaction,
  setDoc,
  updateDoc,
  writeBatch,
} from '../../../../src/serve/worker/client/firestore-writes.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { restoreSharedWorker } from '../oracle-captures/support.ts';

restoreSharedWorker();

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

describe('worker client FieldValue sentinels and ensureFirestoreConfigured/executeWrite', () => {
  it('constructs FieldValue instances with structural isEqual and round-trips writes over the port', async () => {
    expect(deleteField() instanceof FieldValue).toBe(true);
    expect(serverTimestamp() instanceof FieldValue).toBe(true);
    expect(increment(4) instanceof FieldValue).toBe(true);
    expect(arrayUnion('alpha') instanceof FieldValue).toBe(true);
    expect(arrayRemove('alpha') instanceof FieldValue).toBe(true);
    expect(vector([1, 2]) instanceof FieldValue).toBe(false);

    expect(deleteField().isEqual(deleteField())).toBe(true);
    expect(deleteField().isEqual(serverTimestamp())).toBe(false);
    expect(increment(4).isEqual(increment(4))).toBe(true);
    expect(increment(Number.NaN).isEqual(increment(Number.NaN))).toBe(true);
    expect(increment(4).isEqual(increment(5))).toBe(false);
    expect(arrayUnion('alpha', 1).isEqual(arrayUnion('alpha', 1))).toBe(true);
    expect(arrayUnion('alpha', 1).isEqual(arrayUnion(1, 'alpha'))).toBe(false);
    expect(arrayUnion('alpha').isEqual(arrayRemove('alpha'))).toBe(false);

    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const { db } = connectClientToHost(host, 'worker://fv-roundtrip');
      const ref = doc(db, 'items/doc-1');
      await setDoc(ref, {
        count: 10,
        tags: ['alpha', 'beta'],
        obsolete: 'temp',
      });
      await updateDoc(ref, {
        count: increment(5),
        tags: arrayRemove('beta'),
        obsolete: deleteField(),
      });
      await updateDoc(ref, {
        tags: arrayUnion('gamma'),
      });
      expect(() => updateDoc(ref, { tags: arrayUnion(undefined) })).toThrow(FirebaseError);
      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({
        count: 15,
        tags: ['alpha', 'gamma'],
      });
    } finally {
      host.sandbox.dispose();
    }
  });

  it('enforces ensureFirestoreConfigured and executeWrite lifecycle preconditions synchronously', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const cfgClient = connectClientToHost(host, 'worker://plumbing-cfg').db;
      const clientObj = ensureFirestoreConfigured(cfgClient);
      expect(typeof clientObj).toBe('object');
      expect(clientObj).not.toBeNull();
      expect(() => connectFirestoreEmulator(cfgClient, '127.0.0.1', 8080)).toThrow(FirebaseError);

      const execClient = connectClientToHost(host, 'worker://plumbing-exec').db;
      await expect(executeWrite(execClient, [])).resolves.toBeUndefined();
      expect(() => connectFirestoreEmulator(execClient, '127.0.0.1', 8080)).toThrow(FirebaseError);

      await terminate(execClient);
      expect(() => ensureFirestoreConfigured(execClient)).toThrow(FirebaseError);
      let syncThrew = false;
      try {
        void executeWrite(execClient, []);
      } catch (err) {
        syncThrew = err instanceof FirebaseError && err.code === 'failed-precondition';
      }
      expect(syncThrew).toBe(true);
    } finally {
      host.sandbox.dispose();
    }
  });

  it('supports maximum(n) and minimum(n) sentinels across worker writes, offline staging, and placement validation', async () => {
    expect(maximum(7) instanceof FieldValue).toBe(true);
    expect(minimum(7) instanceof FieldValue).toBe(true);
    expect(maximum(7).isEqual(maximum(7))).toBe(true);
    expect(maximum(-0).isEqual(maximum(0))).toBe(true);
    expect(maximum(Number.NaN).isEqual(maximum(Number.NaN))).toBe(true);
    expect(maximum(7).isEqual(minimum(7))).toBe(false);
    expect(minimum(Number.NaN).isEqual(minimum(Number.NaN))).toBe(true);

    const host = await makeHostCtx();
    setRules(host.sandbox, OPEN_RULES);
    try {
      const { db } = connectClientToHost(host, 'worker://fv-minmax');
      const ref = doc(db, 'items/minmax-1');

      await setDoc(ref, {
        high: maximum(10),
        low: minimum(10),
        nonNum: 'hello',
        negZero: -0,
        posZero: 0,
      });
      await updateDoc(ref, {
        high: maximum(22),
        low: minimum(4),
        nonNum: minimum(-3),
        negZero: maximum(0),
        posZero: minimum(-0),
      });
      await updateDoc(ref, {
        high: maximum(15),
        low: minimum(9),
      });

      const snap1 = await getDoc(ref);
      const data1 = snap1.data() as Record<string, unknown>;
      expect(data1.high).toBe(22);
      expect(data1.low).toBe(4);
      expect(data1.nonNum).toBe(-3);
      expect(Object.is(data1.negZero, -0)).toBe(true);
      expect(Object.is(data1.posZero, 0)).toBe(true);

      // Offline projection + replay on reconnect.
      await disableNetwork(db);
      const offlinePending = updateDoc(ref, { high: maximum(50), low: minimum(1) });
      const offlineSnap = await getDoc(ref);
      expect(offlineSnap.data()).toMatchObject({ high: 50, low: 1 });
      await enableNetwork(db);
      await offlinePending;
      expect((await getDoc(ref)).data()).toMatchObject({ high: 50, low: 1 });

      // writeBatch + runTransaction over worker port.
      const batch = writeBatch(db);
      batch.update(ref, { high: maximum(60), low: minimum(2) });
      await batch.commit();
      await runTransaction(db, async (txn) => {
        const cur = await txn.get(ref);
        expect(cur.data()).toMatchObject({ high: 60, low: 1 });
        txn.update(ref, { high: maximum(55), low: minimum(-10), nanField: maximum(Number.NaN) });
      });
      const finalData = (await getDoc(ref)).data() as Record<string, unknown>;
      expect(finalData.high).toBe(60);
      expect(finalData.low).toBe(-10);
      expect(Number.isNaN(finalData.nanField)).toBe(true);

      // Synchronous placement and operand rejections on worker client.
      expect(() => writeBatch(db).set(ref, { arr: [maximum(5)] })).toThrow(FirebaseError);
      expect(() => writeBatch(db).update(ref, { arr: [minimum(5)] })).toThrow(FirebaseError);
      expect(() => writeBatch(db).set(ref, { arr: arrayUnion(maximum(5)) })).toThrow(FirebaseError);
      expect(() => writeBatch(db).set(ref, { arr: arrayRemove(minimum(5)) })).toThrow(FirebaseError);
      expect(() => updateDoc(ref, { high: maximum(undefined as unknown as number) })).toThrow(FirebaseError);
      expect(() => updateDoc(ref, { low: minimum('bad' as unknown as number) })).toThrow(FirebaseError);
      expect(() => query(collection(db, 'items'), where('high', '==', maximum(5)))).toThrow(FirebaseError);
    } finally {
      host.sandbox.dispose();
    }
  });
});
