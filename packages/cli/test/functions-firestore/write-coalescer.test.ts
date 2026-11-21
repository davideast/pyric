import { describe, expect, test } from 'bun:test';
import {
  arrayRemove,
  arrayUnion,
  deleteDoc,
  deleteField,
  doc,
  getFirestore,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import {
  DocumentLifecycleTracker,
  classifyDocumentTransition,
  type FirestoreDocumentTransition,
} from '../../src/functions/firestore/document-change.js';
import {
  WriteGroupCoalescer,
  type CoalescedFirestoreWrite,
} from '../../src/functions/firestore/write-coalescer.js';

describe('write-coalescer atomic batch & transaction grouping', () => {
  test('coalesces multi-op batches and transactions per (groupId, document) in FIFO order', async () => {
    const commits: Array<CoalescedFirestoreWrite<{ actor: string }>> = [];
    const coalescer = new WriteGroupCoalescer<{ actor: string }>((commit) => {
      commits.push(commit);
    });
    const tBatch = { seconds: 500, nanoseconds: 0 };
    const tSingle = { seconds: 501, nanoseconds: 0 };

    coalescer.push({
      database: '(default)',
      document: 'orders/o1',
      before: null,
      after: { status: 'draft' },
      commitTime: tBatch,
      groupId: 'batch-1',
      meta: { actor: 'u1' },
    });
    coalescer.push({
      database: '(default)',
      document: 'orders/o2',
      before: null,
      after: { temp: true },
      commitTime: tBatch,
      groupId: 'batch-1',
      meta: { actor: 'u1' },
    });
    coalescer.push({
      database: '(default)',
      document: 'orders/o1',
      before: null,
      after: { status: 'submitted', items: 2 },
      commitTime: tBatch,
      groupId: 'batch-1',
      meta: { actor: 'u1' },
    });
    coalescer.push({
      database: '(default)',
      document: 'orders/o2',
      before: null,
      after: null,
      commitTime: tBatch,
      groupId: 'batch-1',
      meta: { actor: 'u1' },
    });

    coalescer.push({
      database: '(default)',
      document: 'orders/o3',
      before: { status: 'open' },
      after: { status: 'closed' },
      commitTime: tSingle,
      meta: { actor: 'admin' },
    });

    await Promise.resolve();

    expect(commits).toEqual([
      {
        database: '(default)',
        document: 'orders/o1',
        before: null,
        after: { status: 'submitted', items: 2 },
        commitTime: tBatch,
        meta: { actor: 'u1' },
      },
      {
        database: '(default)',
        document: 'orders/o2',
        before: null,
        after: null,
        commitTime: tBatch,
        meta: { actor: 'u1' },
      },
      {
        database: '(default)',
        document: 'orders/o3',
        before: { status: 'open' },
        after: { status: 'closed' },
        commitTime: tSingle,
        meta: { actor: 'admin' },
      },
    ]);

    const [first, second, third] = commits;
    if (!first || !second || !third) {
      throw new Error('Expected 3 coalesced commits');
    }
    expect(classifyDocumentTransition(first.before, first.after).kind).toBe('created');
    expect(classifyDocumentTransition(second.before, second.after).kind).toBe('noop');
    expect(classifyDocumentTransition(third.before, third.after).kind).toBe('updated');
  });

  test('drops buffered group writes cleanly when closed before microtask drain', async () => {
    const commits: CoalescedFirestoreWrite[] = [];
    const coalescer = new WriteGroupCoalescer((commit) => {
      commits.push(commit);
    });
    coalescer.push({
      database: '(default)',
      document: 'orders/o1',
      before: null,
      after: { status: 'draft' },
      commitTime: { seconds: 1, nanoseconds: 0 },
      groupId: 'tx-1',
    });
    coalescer.close();
    await Promise.resolve();
    expect(commits).toEqual([]);
  });

  test('integrates with live LocalSandbox writes for sentinels, merge, WriteBatch, and runTransaction', async () => {
    const sandbox = initializeSandbox();
    const transitions: FirestoreDocumentTransition[] = [];
    const tracker = new DocumentLifecycleTracker();
    const coalescer = new WriteGroupCoalescer((commit) => {
      const transition = tracker.applyWrite(
        commit.database,
        commit.document,
        commit.before,
        commit.after,
        commit.commitTime,
      );
      if (transition !== null) {
        transitions.push(transition);
      }
    });
    const unsub = sandbox.onEvent((event) => {
      if (event.kind !== 'write') return;
      coalescer.push({
        database: '(default)',
        document: event.path,
        before: event.priorState,
        after: event.nextState,
        commitTime: event.requestTime,
        groupId: event.groupId,
      });
    });

    try {
      const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
      const orderRef = doc(db, 'users/alice/orders/o1');

      // 1. Create with serverTimestamp()
      await setDoc(orderRef, {
        count: 1,
        tags: ['init'],
        temp: 'remove-me',
        createdAt: serverTimestamp(),
      });

      // 2. setDoc with { merge: true }, increment(), and arrayUnion()
      await setDoc(
        orderRef,
        {
          count: increment(4),
          tags: arrayUnion('merged'),
          mergedFlag: true,
        },
        { merge: true },
      );

      // 3. No-op merge write must be suppressed by DocumentLifecycleTracker
      await setDoc(orderRef, { mergedFlag: true }, { merge: true });

      // 4. updateDoc with arrayRemove() and deleteField()
      await updateDoc(orderRef, {
        tags: arrayRemove('init'),
        temp: deleteField(),
      });

      // 5. WriteBatch touching orderRef twice + creating & deleting ephemeralRef in same batch
      const ephemeralRef = doc(db, 'users/alice/orders/temp');
      const batch = writeBatch(db);
      batch.update(orderRef, { count: increment(5) });
      batch.update(orderRef, { status: 'batched' });
      batch.set(ephemeralRef, { draft: true });
      batch.delete(ephemeralRef);
      await batch.commit();

      // 6. runTransaction reading & updating orderRef, plus an aborted transaction that must not fire
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(orderRef);
        const current = Number(snap.data()?.count ?? 0);
        tx.update(orderRef, { count: current + 10 });
      });

      let abortedThrew = false;
      try {
        await runTransaction(db, async (tx) => {
          await tx.get(orderRef);
          tx.update(orderRef, { count: 999 });
          throw new Error('intentional abort');
        });
      } catch {
        abortedThrew = true;
      }
      expect(abortedThrew).toBe(true);

      // 7. Delete existing doc, then delete non-existent doc (no-op)
      await deleteDoc(orderRef);
      await deleteDoc(orderRef);

      coalescer.flush();
      await Promise.resolve();

      expect(transitions.map((item) => item.kind)).toEqual([
        'created',
        'updated',
        'updated',
        'updated',
        'updated',
        'deleted',
      ]);

      const [tCreate, tMerge, tDeleteField, tBatch, tTx, tDelete] = transitions;
      if (!tCreate || !tMerge || !tDeleteField || !tBatch || !tTx || !tDelete) {
        throw new Error('Expected 6 transitions');
      }

      expect(tCreate.after?.fields.count).toBe(1);
      expect(tMerge.before?.fields.count).toBe(1);
      expect(tMerge.after?.fields.count).toBe(5);
      expect(tMerge.after?.fields.tags).toEqual(['init', 'merged']);
      expect(tMerge.updateMask).toEqual(['count', 'mergedFlag', 'tags']);
      expect(tMerge.after?.createTime).toEqual(tCreate.after?.createTime);

      expect(tDeleteField.after?.fields.tags).toEqual(['merged']);
      expect(Object.hasOwn(tDeleteField.after?.fields ?? {}, 'temp')).toBe(false);
      expect(tDeleteField.updateMask).toEqual(['tags', 'temp']);

      expect(tBatch.before?.fields.count).toBe(5);
      expect(tBatch.after?.fields.count).toBe(10);
      expect(tBatch.after?.fields.status).toBe('batched');
      expect(tBatch.updateMask).toEqual(['count', 'status']);

      expect(tTx.before?.fields.count).toBe(10);
      expect(tTx.after?.fields.count).toBe(20);
      expect(tTx.updateMask).toEqual(['count']);

      expect(tDelete.before?.fields.count).toBe(20);
      expect(tDelete.after).toBeNull();
    } finally {
      unsub();
      coalescer.close();
      sandbox.dispose();
    }
  });
});
