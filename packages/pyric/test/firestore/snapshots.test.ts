import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  FieldPath,
  Timestamp,
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  type FirestoreDataConverter,
  type QuerySnapshot,
} from 'pyric/firestore';

interface TaskModel {
  readonly summary: string;
  readonly priority: number;
}

describe('Converter snapshots .get(field) across docSnap, qs.docs[i], onSnapshot, transactions, and fromFirestore (#1978)', () => {
  it('exposes .get(field) on docSnap, qs.docs[0], listener snapshots, tx.get, and fromFirestore snapshot', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const fromFirestoreObserved: Array<{ rawTitle: unknown; nestedPriority: unknown; dottedKey: unknown }> = [];

    const taskConverter: FirestoreDataConverter<TaskModel> = {
      toFirestore(model) {
        const m = model as TaskModel;
        return {
          rawTitle: m.summary,
          meta: { priority: m.priority },
          'literal.dot': 'dotted-val',
        };
      },
      fromFirestore(snapshot, options) {
        fromFirestoreObserved.push({
          rawTitle: snapshot.get('rawTitle', options),
          nestedPriority: snapshot.get('meta.priority', options),
          dottedKey: snapshot.get(new FieldPath('literal.dot'), options),
        });
        return {
          summary: String(snapshot.get('rawTitle', options)).toUpperCase(),
          priority: Number(snapshot.get('meta.priority', options)),
        };
      },
    };

    const typedTasks = collection(db, 'tasks').withConverter(taskConverter);
    const typedDocRef = doc(typedTasks, 't1');
    await setDoc(typedDocRef, { summary: 'ship parity', priority: 3 });

    // 1. Single-document converted snapshot + fromFirestore callback snapshot
    const docSnap = await getDoc(typedDocRef);
    expect(typeof docSnap.get).toBe('function');
    expect(docSnap.get('rawTitle')).toBe('ship parity');
    expect(docSnap.get('meta.priority')).toBe(3);
    expect(docSnap.get(new FieldPath('literal.dot'))).toBe('dotted-val');
    expect(docSnap.get('missing.field')).toBeUndefined();
    expect(docSnap.data()).toEqual({ summary: 'SHIP PARITY', priority: 3 });

    // 2. Query converted snapshot child (qs.docs[0]) + fromFirestore callback snapshot
    const querySnap = await getDocs(typedTasks);
    expect(querySnap.size).toBe(1);
    const firstChild = querySnap.docs[0];
    expect(firstChild).toBeDefined();
    if (firstChild !== undefined) {
      expect(typeof firstChild.get).toBe('function');
      expect(firstChild.get('rawTitle')).toBe('ship parity');
      expect(firstChild.get('meta.priority')).toBe(3);
      expect(firstChild.data()).toEqual({ summary: 'SHIP PARITY', priority: 3 });
    }

    // 3. Transaction read with converter
    const txObserved = await runTransaction(db, async (tx) => {
      const txSnap = await tx.get(typedDocRef);
      return {
        raw: txSnap.get('rawTitle'),
        converted: txSnap.data(),
      };
    });
    expect(txObserved).toEqual({
      raw: 'ship parity',
      converted: { summary: 'SHIP PARITY', priority: 3 },
    });

    // 4. Live listener (document and query) with converter
    const listenerDocField = await new Promise<unknown>((resolve, reject) => {
      const unsub = onSnapshot(
        typedDocRef,
        (snap) => {
          unsub();
          resolve((snap as typeof docSnap).get('rawTitle'));
        },
        reject,
      );
    });
    expect(listenerDocField).toBe('ship parity');

    const listenerQueryField = await new Promise<unknown>((resolve, reject) => {
      const unsub = onSnapshot(
        typedTasks,
        (snap) => {
          unsub();
          const qs = snap as QuerySnapshot<TaskModel>;
          resolve(qs.docs[0]?.get('meta.priority'));
        },
        reject,
      );
    });
    expect(listenerQueryField).toBe(3);

    expect(fromFirestoreObserved.length).toBeGreaterThanOrEqual(3);
    for (const entry of fromFirestoreObserved) {
      expect(entry).toEqual({
        rawTitle: 'ship parity',
        nestedPriority: 3,
        dottedKey: 'dotted-val',
      });
    }
  });

  it('forwards SnapshotOptions through converted docSnap.get(field, options) for pending server timestamps', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const untypedRef = doc(db, 'stamped/s1');
    const passthroughConverter: FirestoreDataConverter<{ ok: boolean }> = {
      toFirestore: () => ({ ok: true, createdAt: serverTimestamp() }),
      fromFirestore: (snap, options) => ({
        ok: snap.get('createdAt', options) instanceof Timestamp,
      }),
    };
    const typedRef = untypedRef.withConverter(passthroughConverter);

    await disableNetwork(db);
    const pendingWrite = setDoc(untypedRef, { ok: true, createdAt: serverTimestamp() });
    const offlineSnap = await getDoc(typedRef);
    expect(offlineSnap.get('createdAt')).toBeNull();
    expect(offlineSnap.get('createdAt', { serverTimestamps: 'estimate' })).toBeInstanceOf(Timestamp);
    expect(offlineSnap.data({ serverTimestamps: 'estimate' })).toEqual({ ok: true });

    await enableNetwork(db);
    await pendingWrite;
  });
});
