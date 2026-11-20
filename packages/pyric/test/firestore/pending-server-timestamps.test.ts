import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  collection,
  deleteDoc,
  doc,
  disableNetwork,
  enableNetwork,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  type DocumentSnapshot,
  type QuerySnapshot,
} from 'pyric/firestore';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if request.auth != null; }
    match /denied/{id} { allow read, write: if false; }
  }
}`;

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

describe('pending serverTimestamp options and offline client overlay', () => {
  it('projects nested serverTimestamp fields across none, estimate, and previous before settlement', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox.withAuth({ uid: 'u1' }));
    const ref = doc(db, 'items/item-1');
    await setDoc(ref, { meta: { updatedAt: 'initial' }, title: 'alpha' });

    const seen: Array<{
      pending: boolean;
      fromCache: boolean;
      none: unknown;
      estimateIsTimestamp: boolean;
      previous: unknown;
    }> = [];

    const stop = onSnapshot(ref, { includeMetadataChanges: true }, (raw) => {
      const snap = raw as DocumentSnapshot;
      const noneData = snap.data() as { meta?: { updatedAt?: unknown } } | undefined;
      const estimateData = snap.data({ serverTimestamps: 'estimate' }) as { meta?: { updatedAt?: unknown } } | undefined;
      const previousData = snap.data({ serverTimestamps: 'previous' }) as { meta?: { updatedAt?: unknown } } | undefined;
      seen.push({
        pending: snap.metadata.hasPendingWrites,
        fromCache: snap.metadata.fromCache,
        none: noneData?.meta?.updatedAt,
        estimateIsTimestamp: estimateData?.meta?.updatedAt instanceof Timestamp,
        previous: previousData?.meta?.updatedAt,
      });
    });

    await flushMicrotasks();
    await updateDoc(ref, { 'meta.updatedAt': serverTimestamp() });
    await flushMicrotasks();
    stop();
    sandbox.dispose();

    expect(seen).toEqual([
      { pending: false, fromCache: true, none: 'initial', estimateIsTimestamp: false, previous: 'initial' },
      { pending: false, fromCache: false, none: 'initial', estimateIsTimestamp: false, previous: 'initial' },
      { pending: true, fromCache: false, none: null, estimateIsTimestamp: true, previous: 'initial' },
      { pending: false, fromCache: false, none: expect.any(Timestamp), estimateIsTimestamp: true, previous: expect.any(Timestamp) },
    ]);
  });

  it('queues rules-denied offline writes locally and rejects on enableNetwork', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox.withAuth({ uid: 'u1' }));
    const deniedRef = doc(db, 'denied/doc-1');
    const events: string[] = [];

    const stop = onSnapshot(
      deniedRef,
      { includeMetadataChanges: true },
      (raw) => {
        const snap = raw as DocumentSnapshot & { exists(): boolean };
        events.push(`snap:${String(snap.exists())}:${String(snap.metadata.hasPendingWrites)}:${String(snap.metadata.fromCache)}`);
      },
      (err) => {
        const code = (err as { code?: string }).code ?? 'unknown';
        events.push(`err:${code}`);
      },
    );
    await disableNetwork(db);

    let outcome = 'pending';
    const write = setDoc(deniedRef, { title: 'blocked' }).then(
      () => { outcome = 'resolved'; },
      (err: { code?: string }) => { outcome = `rejected:${String(err.code)}`; },
    );

    await flushMicrotasks();
    expect(outcome).toBe('pending');
    expect(events).toEqual(['snap:false:false:true', 'snap:true:true:true']);

    await enableNetwork(db);
    await write;
    await flushMicrotasks();
    stop();
    sandbox.dispose();

    expect(outcome).toBe('rejected:permission-denied');
    expect(events).toEqual([
      'snap:false:false:true',
      'snap:true:true:true',
      'err:permission-denied',
    ]);
  });

  it('preserves settled serverTimestamp values in removed query docChanges', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const db = getFirestore(sandbox.withAuth({ uid: 'u1' }));
    const itemRef = doc(db, 'items/item-2');
    await setDoc(itemRef, { meta: { stamped: serverTimestamp() }, n: 1 });

    const removedStamps: unknown[] = [];
    const stop = onSnapshot(collection(db, 'items'), (raw) => {
      const snap = raw as QuerySnapshot;
      for (const change of snap.docChanges()) {
        if (change.type === 'removed') {
          const data = change.doc.data() as { meta?: { stamped?: unknown } };
          removedStamps.push(data.meta?.stamped);
        }
      }
    });

    await flushMicrotasks();
    await deleteDoc(itemRef);
    await flushMicrotasks();
    stop();
    sandbox.dispose();

    expect(removedStamps).toHaveLength(1);
    expect(removedStamps[0]).toBeInstanceOf(Timestamp);
  });
});
