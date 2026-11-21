import { afterEach, describe, expect, test } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import {
  FieldPath as UpstreamFieldPath,
  FieldValue as UpstreamFieldValue,
  getFirestore as getUpstreamFirestore,
} from 'firebase-admin/firestore';
import { deleteApp, getApps } from '../../src/app/index.js';
import {
  AggregateField,
  FieldPath,
  FieldValue,
  Filter,
  getFirestore,
  GrpcStatus,
  Timestamp,
  WriteResult,
} from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

class CustomDomainEntity {
  readonly kind = 'entity';
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  await Promise.all(getUpstreamApps().map((app) => deleteUpstreamApp(app).catch(() => undefined)));
});

async function captureError(fn: () => unknown): Promise<{ code?: unknown; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof Error) {
      return { code: (err as { code?: unknown }).code, message: err.message };
    }
    return { message: String(err) };
  }
}

describe.each([
  ['in-process', inProcessFirestoreArm],
  ['shared-worker remote', sharedWorkerFirestoreArm],
] as const)('pyric-admin/firestore SDK parity regressions (%s)', (_label, makeArm) => {
  test('#1980 & #1981: create, set, update, delete, and batch.commit resolve WriteResult(s) and surface numeric GrpcStatus codes', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const ref = db.doc('orders/ord-1');

    const createRes = await ref.create({ amount: 10 });
    expect(createRes).toBeInstanceOf(WriteResult);
    expect(createRes.writeTime).toBeInstanceOf(Timestamp);

    const dupCreateErr = await captureError(() => ref.create({ amount: 20 }));
    expect(dupCreateErr?.code).toBe(GrpcStatus.ALREADY_EXISTS);
    expect(typeof dupCreateErr?.code).toBe('number');

    const setRes = await ref.set({ amount: 25 });
    expect(setRes).toBeInstanceOf(WriteResult);
    expect(setRes.writeTime.toMillis()).toBeGreaterThanOrEqual(createRes.writeTime.toMillis());

    const updateRes = await ref.update({ amount: 30 });
    expect(updateRes).toBeInstanceOf(WriteResult);
    expect(updateRes.writeTime.toMillis()).toBeGreaterThanOrEqual(setRes.writeTime.toMillis());

    const deleteRes = await ref.delete();
    expect(deleteRes).toBeInstanceOf(WriteResult);
    expect(deleteRes.writeTime).toBeInstanceOf(Timestamp);

    const missingUpdateErr = await captureError(() => ref.update({ amount: 40 }));
    expect(missingUpdateErr?.code).toBe(GrpcStatus.NOT_FOUND);
    expect(typeof missingUpdateErr?.code).toBe('number');

    const batch = db.batch();
    batch
      .create(db.doc('orders/b-1'), { amount: 1 })
      .set(db.doc('orders/b-2'), { amount: 2 })
      .update(db.doc('orders/b-2'), { amount: 3 })
      .delete(db.doc('orders/b-1'));
    const batchResults = await batch.commit();
    expect(batchResults).toHaveLength(4);
    for (const item of batchResults) {
      expect(item).toBeInstanceOf(WriteResult);
      expect(item.writeTime).toBeInstanceOf(Timestamp);
    }

    const badDbIdErr = await captureError(() => getFirestore(app, 123 as unknown as string));
    expect(badDbIdErr?.code).toBe(GrpcStatus.INVALID_ARGUMENT);

    // BulkWriter onWriteError forwards numeric GrpcStatus codes instead of generic UNKNOWN (2)
    await db.doc('orders/bw-dup').set({ v: 1 });
    const observedBwCodes: number[] = [];
    const bw = db.bulkWriter();
    bw.onWriteError((bwErr) => {
      observedBwCodes.push(bwErr.code);
      return false;
    });
    const bwDupErr = await captureError(() => bw.create(db.doc('orders/bw-dup'), { v: 2 }));
    const bwMissingErr = await captureError(() => bw.update(db.doc('orders/bw-missing'), { v: 2 }));
    await bw.close();
    expect(bwDupErr?.code).toBe(GrpcStatus.ALREADY_EXISTS);
    expect(bwMissingErr?.code).toBe(GrpcStatus.NOT_FOUND);
    expect(observedBwCodes).toEqual([
      GrpcStatus.ALREADY_EXISTS as number,
      GrpcStatus.NOT_FOUND as number,
    ]);
  });

  test('#1974: enforces exists and lastUpdateTime preconditions across doc, WriteBatch, and Transaction paths', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const ref = db.doc('accounts/acc-1');

    // Missing doc delete({ exists: true }) -> 5 NOT_FOUND
    const delMissingErr = await captureError(() => ref.delete({ exists: true }));
    expect(delMissingErr?.code).toBe(GrpcStatus.NOT_FOUND);

    // Missing doc delete({ exists: false }) -> succeeds
    const delAbsentOk = await ref.delete({ exists: false });
    expect(delAbsentOk).toBeInstanceOf(WriteResult);

    const created = await ref.create({ balance: 100 });
    const t1 = created.writeTime;
    const updated = await ref.update({ balance: 150 }, { lastUpdateTime: t1 });
    const t2 = updated.writeTime;

    // Stale lastUpdateTime on doc.update and doc.delete -> 9 FAILED_PRECONDITION
    const staleDocUpdate = await captureError(() => ref.update({ balance: 999 }, { lastUpdateTime: t1 }));
    expect(staleDocUpdate?.code).toBe(GrpcStatus.FAILED_PRECONDITION);
    const staleDocDelete = await captureError(() => ref.delete({ lastUpdateTime: t1 }));
    expect(staleDocDelete?.code).toBe(GrpcStatus.FAILED_PRECONDITION);
    expect((await ref.get()).data()).toEqual({ balance: 150 });

    // WriteBatch atomic rollback on stale lastUpdateTime & missing exists:true
    const guardRef = db.doc('accounts/guard');
    await guardRef.set({ intact: true });

    const staleBatch = db.batch();
    staleBatch.set(guardRef, { intact: false });
    staleBatch.update(ref, { balance: 0 }, { lastUpdateTime: t1 });
    const staleBatchErr = await captureError(() => staleBatch.commit());
    expect(staleBatchErr?.code).toBe(GrpcStatus.FAILED_PRECONDITION);
    expect((await guardRef.get()).data()).toEqual({ intact: true });

    const missingDelBatch = db.batch();
    missingDelBatch.set(guardRef, { intact: false });
    missingDelBatch.delete(db.doc('accounts/never'), { exists: true });
    const missingDelBatchErr = await captureError(() => missingDelBatch.commit());
    expect(missingDelBatchErr?.code).toBe(GrpcStatus.NOT_FOUND);
    expect((await guardRef.get()).data()).toEqual({ intact: true });

    // Intra-batch create followed by update({ exists: true }) on same doc
    const intraRef = db.doc('accounts/intra');
    await db
      .batch()
      .create(intraRef, { step: 1 })
      .update(intraRef, { step: 2 }, { exists: true })
      .commit();
    expect((await intraRef.get()).data()).toEqual({ step: 2 });

    // Transaction stale lastUpdateTime & missing delete({ exists: true })
    const staleTxErr = await captureError(() =>
      db.runTransaction(async (tx) => {
        await tx.get(ref);
        tx.set(guardRef, { intact: false });
        tx.delete(ref, { lastUpdateTime: t1 });
      }),
    );
    expect(staleTxErr?.code).toBe(GrpcStatus.FAILED_PRECONDITION);
    expect((await guardRef.get()).data()).toEqual({ intact: true });
    expect((await ref.get()).data()).toEqual({ balance: 150 });

    // Matching lastUpdateTime t2 succeeds inside transaction
    await db.runTransaction(async (tx) => {
      await tx.get(ref);
      tx.update(ref, { balance: 200 }, { lastUpdateTime: t2 });
    });
    expect((await ref.get()).data()).toEqual({ balance: 200 });
  });

  test('#1975: read-only transactions refuse all write methods and read point-in-time state at readTime', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const refA = db.doc('reports/r-a');
    const refB = db.doc('reports/r-b');
    const refC = db.doc('reports/r-c');
    const subRef = db.doc('departments/eng/entries/e-1');

    const beforeAll = Timestamp.now();
    await new Promise((r) => setTimeout(r, 5));

    const wA1 = await refA.set({ total: 10, active: true });
    const wB1 = await refB.set({ total: 20, active: true });
    const wSub1 = await subRef.set({ tag: 'v1' });
    const t1 = wSub1.writeTime;
    expect(t1.toMillis()).toBeGreaterThanOrEqual(wA1.writeTime.toMillis());
    expect(t1.toMillis()).toBeGreaterThanOrEqual(wB1.writeTime.toMillis());

    await new Promise((r) => setTimeout(r, 5));

    await refA.update({ total: 99 });
    await refB.delete();
    const wC2 = await refC.create({ total: 30, active: true });
    const wSub2 = await subRef.update({ tag: 'v2' });
    const t2 = wSub2.writeTime;
    expect(t2.toMillis()).toBeGreaterThanOrEqual(wC2.writeTime.toMillis());

    // 1. Writes inside readOnly transactions (with and without readTime) are refused
    for (const opts of [{ readOnly: true }, { readOnly: true, readTime: t1 }]) {
      for (const writeCall of [
        (tx: FirebaseFirestore.Transaction) => tx.create(db.doc('reports/ro-create'), { total: 1 }),
        (tx: FirebaseFirestore.Transaction) => tx.set(refA, { total: 0 }),
        (tx: FirebaseFirestore.Transaction) => tx.update(refA, { total: 0 }),
        (tx: FirebaseFirestore.Transaction) => tx.delete(refA),
      ]) {
        const err = await captureError(() =>
          db.runTransaction(async (tx) => {
            writeCall(tx as unknown as FirebaseFirestore.Transaction);
          }, opts as never),
        );
        expect(err?.code).toBe(GrpcStatus.INVALID_ARGUMENT);
        expect(err?.message).toBe('Firestore read-only transactions cannot execute writes.');
      }
    }
    expect((await refA.get()).data()).toEqual({ total: 99, active: true });

    // 2. readTime before any writes sees empty state
    const snapshotBefore = await db.runTransaction(
      async (tx) => {
        const sA = await tx.get(refA);
        const qSnap = await tx.get(db.collection('reports'));
        return { aExists: sA.exists, count: qSnap.size };
      },
      { readOnly: true, readTime: beforeAll } as never,
    );
    expect(snapshotBefore).toEqual({ aExists: false, count: 0 });

    // 3. readTime at t1 reads historical doc, query, collectionGroup, and getAll state at t1
    const snapshotAtT1 = await db.runTransaction(
      async (tx) => {
        const sA = await tx.get(refA);
        const qActive = await tx.get(
          db.collection('reports').where('active', '==', true).orderBy('total', 'asc'),
        );
        const cgV1 = await tx.get(db.collectionGroup('entries').where('tag', '==', 'v1'));
        const cgV2 = await tx.get(db.collectionGroup('entries').where('tag', '==', 'v2'));
        const all = await (
          tx as unknown as {
            getAll: (...args: unknown[]) => Promise<Array<{ id: string; exists: boolean; data(): unknown }>>;
          }
        ).getAll(refA, refB, refC, { fieldMask: ['total'] });
        return {
          aData: sA.data(),
          aReadTimeMatches: (sA as unknown as { readTime: Timestamp }).readTime.isEqual(t1),
          queryIds: qActive.docs.map((d) => d.id),
          cgV1Ids: cgV1.docs.map((d) => d.id),
          cgV2Ids: cgV2.docs.map((d) => d.id),
          allSummary: all.map((s) => ({ id: s.id, exists: s.exists, data: s.data() ?? null })),
        };
      },
      { readOnly: true, readTime: t1 } as never,
    );
    expect(snapshotAtT1).toEqual({
      aData: { total: 10, active: true },
      aReadTimeMatches: true,
      queryIds: ['r-a', 'r-b'],
      cgV1Ids: ['e-1'],
      cgV2Ids: [],
      allSummary: [
        { id: 'r-a', exists: true, data: { total: 10 } },
        { id: 'r-b', exists: true, data: { total: 20 } },
        { id: 'r-c', exists: false, data: null },
      ],
    });

    // 4. readTime at t2 reads post-update state
    const snapshotAtT2 = await db.runTransaction(
      async (tx) => {
        const qActive = await tx.get(
          db.collection('reports').where('active', '==', true).orderBy('total', 'asc'),
        );
        return qActive.docs.map((d) => ({ id: d.id, total: d.data().total }));
      },
      { readOnly: true, readTime: t2 } as never,
    );
    expect(snapshotAtT2).toEqual([
      { id: 'r-c', total: 30 },
      { id: 'r-a', total: 99 },
    ]);
  });

  test('#1979: committed WriteBatch refuses post-commit writes and refuses a second commit without double-applying increments', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const counterRef = db.doc('counters/c-1');
    await counterRef.set({ count: 10 });

    const batch = db.batch();
    batch.update(counterRef, { count: FieldValue.increment(5) });
    const firstCommit = await batch.commit();
    expect(firstCommit).toHaveLength(1);
    expect((await counterRef.get()).data()).toEqual({ count: 15 });

    for (const postWrite of [
      () => batch.create(db.doc('counters/c-2'), { count: 1 }),
      () => batch.set(counterRef, { count: 0 }),
      () => batch.update(counterRef, { count: 99 }),
      () => batch.delete(counterRef),
    ]) {
      const writeErr = await captureError(postWrite);
      expect(writeErr?.code).toBe(GrpcStatus.FAILED_PRECONDITION);
      expect(writeErr?.message).toBe('Cannot modify a WriteBatch that has been committed.');
    }

    const secondCommitErr = await captureError(() => batch.commit());
    expect(secondCommitErr?.code).toBe(GrpcStatus.FAILED_PRECONDITION);
    expect(secondCommitErr?.message).toBe('Cannot modify a WriteBatch that has been committed.');
    expect((await counterRef.get()).data()).toEqual({ count: 15 });
  });

  test('#1976 & #1977: refuses all 16 invalid write shapes and invalid query constraints with firebase-admin messages', async () => {
    const upApp = initializeUpstreamApp(
      { projectId: 'demo-parity' },
      `up-parity-${Math.random().toString(36).slice(2)}`,
    );
    const upDb = getUpstreamFirestore(upApp);
    const { app } = makeArm();
    const pyDb = getFirestore(app);
    await pyDb.doc('items/seed').set({ keep: true });

    const writeCases: Array<{
      readonly label: string;
      readonly runUpstream: () => unknown;
      readonly runPyric: () => unknown;
    }> = [
      {
        label: 'undefined top-level field',
        runUpstream: () => upDb.doc('items/seed').set({ a: undefined }),
        runPyric: () => pyDb.doc('items/seed').set({ a: undefined }),
      },
      {
        label: 'undefined nested field',
        runUpstream: () => upDb.doc('items/seed').set({ nested: { b: undefined } }),
        runPyric: () => pyDb.doc('items/seed').set({ nested: { b: undefined } }),
      },
      {
        label: 'undefined array element',
        runUpstream: () => upDb.doc('items/seed').set({ arr: [undefined] }),
        runPyric: () => pyDb.doc('items/seed').set({ arr: [undefined] }),
      },
      {
        label: 'non-object document (string)',
        runUpstream: () => upDb.doc('items/seed').set('not-an-object' as never),
        runPyric: () => pyDb.doc('items/seed').set('not-an-object' as never),
      },
      {
        label: 'non-object document (array)',
        runUpstream: () => upDb.doc('items/seed').set([1, 2] as never),
        runPyric: () => pyDb.doc('items/seed').set([1, 2] as never),
      },
      {
        label: 'root class instance',
        runUpstream: () => upDb.doc('items/seed').set(new CustomDomainEntity() as never),
        runPyric: () => pyDb.doc('items/seed').set(new CustomDomainEntity() as never),
      },
      {
        label: 'nested class instance',
        runUpstream: () => upDb.doc('items/seed').set({ entity: new CustomDomainEntity() }),
        runPyric: () => pyDb.doc('items/seed').set({ entity: new CustomDomainEntity() }),
      },
      {
        label: 'root Map',
        runUpstream: () => upDb.doc('items/seed').set(new Map([['a', 1]]) as never),
        runPyric: () => pyDb.doc('items/seed').set(new Map([['a', 1]]) as never),
      },
      {
        label: 'nested Map',
        runUpstream: () => upDb.doc('items/seed').set({ m: new Map([['a', 1]]) }),
        runPyric: () => pyDb.doc('items/seed').set({ m: new Map([['a', 1]]) }),
      },
      {
        label: 'function field',
        runUpstream: () => upDb.doc('items/seed').set({ fn: () => 1 }),
        runPyric: () => pyDb.doc('items/seed').set({ fn: () => 1 }),
      },
      {
        label: 'serverTimestamp() inside array',
        runUpstream: () => upDb.doc('items/seed').set({ arr: [UpstreamFieldValue.serverTimestamp()] }),
        runPyric: () => pyDb.doc('items/seed').set({ arr: [FieldValue.serverTimestamp()] }),
      },
      {
        label: 'update({}) empty map',
        runUpstream: () => upDb.doc('items/seed').update({}),
        runPyric: () => pyDb.doc('items/seed').update({}),
      },
      {
        label: 'update conflicting field paths a and a.b (map)',
        runUpstream: () => upDb.doc('items/seed').update({ a: 1, 'a.b': 2 }),
        runPyric: () => pyDb.doc('items/seed').update({ a: 1, 'a.b': 2 }),
      },
      {
        label: 'update conflicting field paths a and a.b (varargs)',
        runUpstream: () => upDb.doc('items/seed').update('a', 1, 'a.b', 2),
        runPyric: () => pyDb.doc('items/seed').update('a', 1, 'a.b', 2),
      },
      {
        label: 'arrayUnion(undefined)',
        runUpstream: () => upDb.doc('items/seed').set({ a: UpstreamFieldValue.arrayUnion(undefined) }),
        runPyric: () => pyDb.doc('items/seed').set({ a: FieldValue.arrayUnion(undefined) }),
      },
      {
        label: 'arrayUnion([1]) nested array',
        runUpstream: () => upDb.doc('items/seed').set({ a: UpstreamFieldValue.arrayUnion([1]) }),
        runPyric: () => pyDb.doc('items/seed').set({ a: FieldValue.arrayUnion([1]) }),
      },
    ];

    for (const item of writeCases) {
      const uErr = await captureError(item.runUpstream);
      const pErr = await captureError(item.runPyric);
      expect(uErr).not.toBeNull();
      expect(pErr).not.toBeNull();
      expect(pErr?.code).toBe(GrpcStatus.INVALID_ARGUMENT);
      expect(pErr?.message).toBe(uErr?.message ?? '');
    }

    // Nested array literal in document field (rejected by server wire check in production)
    const nestedArrErr = await captureError(() => pyDb.doc('items/seed').set({ a: [[1]] }));
    expect(nestedArrErr?.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect((await pyDb.doc('items/seed').get()).data()).toEqual({ keep: true });

    // #1977: Synchronous query construction rejections matching firebase-admin messages
    const queryCases: Array<{
      readonly label: string;
      readonly runUpstream: () => unknown;
      readonly runPyric: () => unknown;
    }> = [
      {
        label: 'where > null',
        runUpstream: () => upDb.collection('items').where('a', '>', null),
        runPyric: () => pyDb.collection('items').where('a', '>', null),
      },
      {
        label: 'where < NaN',
        runUpstream: () => upDb.collection('items').where('a', '<', Number.NaN),
        runPyric: () => pyDb.collection('items').where('a', '<', Number.NaN),
      },
      {
        label: 'limit(1.5)',
        runUpstream: () => upDb.collection('items').limit(1.5),
        runPyric: () => pyDb.collection('items').limit(1.5),
      },
      {
        label: 'limitToLast(1.5)',
        runUpstream: () => upDb.collection('items').limitToLast(1.5),
        runPyric: () => pyDb.collection('items').limitToLast(1.5),
      },
      {
        label: 'documentId with slash on collection',
        runUpstream: () => upDb.collection('items').where(UpstreamFieldPath.documentId(), '==', 'a/b'),
        runPyric: () => pyDb.collection('items').where(FieldPath.documentId(), '==', 'a/b'),
      },
      {
        label: 'Filter.where documentId with slash on collection',
        runUpstream: () =>
          upDb.collection('items').where(
            Filter.where(FieldPath.documentId(), '==', 'a/b') as never,
          ),
        runPyric: () =>
          pyDb.collection('items').where(Filter.where(FieldPath.documentId(), '==', 'a/b')),
      },
    ];

    for (const qItem of queryCases) {
      let syncThrew = false;
      let pyCode: unknown;
      let pyMsg = '';
      try {
        qItem.runPyric();
      } catch (err) {
        syncThrew = true;
        pyCode = (err as { code?: unknown }).code;
        if (err instanceof Error) pyMsg = err.message;
      }
      expect(syncThrew).toBe(true);
      expect(pyCode).toBe(GrpcStatus.INVALID_ARGUMENT);
      if (qItem.label !== 'Filter.where documentId with slash on collection') {
        const uErr = await captureError(qItem.runUpstream);
        expect(pyMsg).toBe(uErr?.message ?? '');
      }
    }

    // Aggregate query bounds (0 and > 5 aggregations refused)
    const zeroAggErr = await captureError(() => pyDb.collection('items').aggregate({}).get());
    expect(zeroAggErr?.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    const sixAggErr = await captureError(() =>
      pyDb
        .collection('items')
        .aggregate({
          a1: AggregateField.count(),
          a2: AggregateField.sum('x'),
          a3: AggregateField.average('x'),
          a4: AggregateField.count(),
          a5: AggregateField.sum('y'),
          a6: AggregateField.average('y'),
        })
        .get(),
    );
    expect(sixAggErr?.code).toBe(GrpcStatus.INVALID_ARGUMENT);
  });
});
