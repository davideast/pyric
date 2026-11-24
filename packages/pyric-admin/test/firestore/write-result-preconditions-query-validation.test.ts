/**
 * Regression suite for `#1980` (`WriteResult` on `set`, `create`, `update`,
 * `delete`, `batch.commit`), `#1974` (`exists` and `lastUpdateTime` write
 * preconditions across doc, `WriteBatch`, `Transaction`, `BulkWriter`, and
 * cross-SDK Web `pyric/firestore` mutations), and `#1977` (synchronous query
 * construction validation matched differentially against `firebase-admin`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  initializeApp as initializeUpstreamApp,
  type App as UpstreamApp,
} from 'firebase-admin/app';
import {
  FieldPath as UpstreamFieldPath,
  Filter as UpstreamFilter,
  Timestamp as UpstreamTimestamp,
  getFirestore as getUpstreamFirestore,
  type Firestore as UpstreamFirestore,
} from 'firebase-admin/firestore';
import { deleteDoc, doc as webDoc, getFirestore as getWebFirestore, setDoc, updateDoc } from 'pyric/firestore';
import type { Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, type PyricAdminApp } from 'pyric-admin/app';
import {
  FieldPath,
  Filter,
  GrpcStatus,
  Timestamp,
  WriteResult,
  getAdminFirestore,
  getFirestore,
  onSnapshot,
  type AggregateQuery,
  type AggregateQuerySnapshot,
  type CollectionGroup,
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Precondition,
  type Query,
  type ReadOnlyTransactionOptions,
  type ReadOptions,
  type ReadWriteTransactionOptions,
  type Transaction,
  type WriteBatch,
} from 'pyric-admin/firestore';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

type ArmKind = 'local' | 'remote';

const activeSandboxes: Sandbox[] = [];

function openArm(kind: ArmKind, rules?: string): { app: PyricAdminApp; host: Sandbox; db: Firestore } {
  let pair: { app: PyricAdminApp; host: Sandbox };
  if (kind === 'local') {
    pair = inProcessFirestoreArm(rules);
  } else {
    pair = sharedWorkerFirestoreArm(rules);
  }
  activeSandboxes.push(pair.host);
  return { app: pair.app, host: pair.host, db: getFirestore(pair.app) };
}

function captureSyncError(fn: () => unknown): { threw: boolean; code?: unknown; message?: string } {
  try {
    fn();
    return { threw: false };
  } catch (err) {
    if (err instanceof Error) {
      return {
        threw: true,
        code: (err as { code?: unknown }).code,
        message: err.message,
      };
    }
    return { threw: true, message: String(err) };
  }
}

async function captureAsyncError(
  fn: () => Promise<unknown>,
): Promise<{ rejected: boolean; code?: unknown; message?: string }> {
  try {
    await fn();
    return { rejected: false };
  } catch (err) {
    if (err instanceof Error) {
      return {
        rejected: true,
        code: (err as { code?: unknown }).code,
        message: err.message,
      };
    }
    return { rejected: true, message: String(err) };
  }
}

let upstreamApp: UpstreamApp | undefined;
let upstreamDb: UpstreamFirestore;

beforeAll(() => {
  upstreamApp = initializeUpstreamApp(
    { projectId: 'demo-admin-parity-oracle' },
    `upstream-oracle-${Date.now().toString(36)}`,
  );
  upstreamDb = getUpstreamFirestore(upstreamApp);
});

afterAll(async () => {
  if (upstreamApp !== undefined) {
    await deleteUpstreamApp(upstreamApp).catch(() => undefined);
  }
});

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  while (activeSandboxes.length > 0) {
    const sb = activeSandboxes.pop();
    if (sb !== undefined) {
      sb.dispose();
    }
  }
});

describe('#1980, #1974, #1977 pyric-admin/firestore parity across local and remote arms', () => {
  for (const armKind of ['local', 'remote'] as const) {
    describe(`${armKind} arm`, () => {
      it('#1980: resolves WriteResult with monotonic Timestamp and nominal isEqual across set, create, update, delete, batch.commit, and typed handles', async () => {
        const { db, host } = openArm(armKind);
        const col: CollectionReference = db.collection('write_results');
        const cg: CollectionGroup = db.collectionGroup('write_results');
        const q: Query = col.where('v', '>=', 0);
        const agg: AggregateQuery = q.count();
        const ref: DocumentReference = col.doc('d1');

        const created: WriteResult = await ref.create({ v: 1, tag: 'init' });
        expect(created).toBeInstanceOf(WriteResult);
        expect(created.writeTime).toBeInstanceOf(Timestamp);
        expect(created.isEqual(created)).toBe(true);
        expect(created.isEqual(new WriteResult(created.writeTime))).toBe(true);
        expect(created.isEqual({ writeTime: created.writeTime } as unknown as WriteResult)).toBe(false);

        const snapAfterCreate = await ref.get();
        expect(snapAfterCreate.updateTime?.isEqual(created.writeTime)).toBe(true);

        const setReplaced: WriteResult = await ref.set({ v: 2, extra: 'x' });
        expect(setReplaced).toBeInstanceOf(WriteResult);
        expect(setReplaced.writeTime.toMillis()).toBeGreaterThanOrEqual(created.writeTime.toMillis());
        expect(setReplaced.isEqual(created)).toBe(false);

        const setMerged: WriteResult = await ref.set({ merged: true }, { merge: true });
        expect(setMerged).toBeInstanceOf(WriteResult);

        const updatedMap: WriteResult = await ref.update({ v: 3 });
        expect(updatedMap).toBeInstanceOf(WriteResult);

        const updatedVararg: WriteResult = await ref.update('v', 4, 'extra', 'y');
        expect(updatedVararg).toBeInstanceOf(WriteResult);

        const deletedExisting: WriteResult = await ref.delete();
        expect(deletedExisting).toBeInstanceOf(WriteResult);

        const deletedMissing: WriteResult = await ref.delete();
        expect(deletedMissing).toBeInstanceOf(WriteResult);

        const batch: WriteBatch = db.batch();
        expect(await db.batch().commit()).toEqual([]);

        const refA = col.doc('b1');
        const refB = col.doc('b2');
        batch.create(refA, { v: 10 });
        batch.set(refB, { v: 20 });
        batch.update(refA, { v: 11 });
        batch.delete(col.doc('b-missing'));
        const batchResults: WriteResult[] = await batch.commit();
        expect(batchResults).toHaveLength(4);
        const firstBatchResult = batchResults[0];
        expect(firstBatchResult).toBeInstanceOf(WriteResult);
        if (firstBatchResult !== undefined) {
          for (const entry of batchResults) {
            expect(entry).toBeInstanceOf(WriteResult);
            expect(entry.isEqual(firstBatchResult)).toBe(true);
          }
        }

        const aggSnap: AggregateQuerySnapshot = await agg.get();
        expect(aggSnap.data().count).toBe(2);
        expect((await cg.get()).size).toBe(2);

        const observedIds: string[] = [];
        const unsub = onSnapshot(refA, (liveSnap: DocumentSnapshot) => {
          if (liveSnap.exists()) {
            observedIds.push(liveSnap.id);
          }
        });
        unsub();

        if (armKind === 'local') {
          const ctxDb = getFirestore(host.withAuth({ uid: 'u1' }));
          const adminLensDb = getAdminFirestore(host);
          const ctxWrite = await ctxDb.doc('ctx_items/c1').set({ ok: true });
          const adminLensWrite = await adminLensDb.doc('ctx_items/c1').update({ ok: false });
          expect(ctxWrite).toBeInstanceOf(WriteResult);
          expect(adminLensWrite).toBeInstanceOf(WriteResult);
        }
      });

      it('#1974: enforces exists and lastUpdateTime preconditions on direct update/delete, BulkWriter, and across Web SDK mutations', async () => {
        const { db, host } = openArm(armKind);
        const ref = db.doc('precond_docs/p1');

        const missingUpdate = await captureAsyncError(() => ref.update({ v: 1 }, { exists: true }));
        expect(missingUpdate.rejected).toBe(true);
        expect(missingUpdate.code).toBe(GrpcStatus.NOT_FOUND);

        const missingDelete = await captureAsyncError(() => ref.delete({ exists: true }));
        expect(missingDelete.rejected).toBe(true);
        expect(missingDelete.code).toBe(GrpcStatus.NOT_FOUND);

        const absentDeleteOk = await ref.delete({ exists: false });
        expect(absentDeleteOk).toBeInstanceOf(WriteResult);

        const cRes = await ref.create({ v: 1 });
        const t1 = cRes.writeTime;

        const existsFalseOnExisting = await captureAsyncError(() => ref.delete({ exists: false }));
        expect(existsFalseOnExisting.rejected).toBe(true);
        expect(existsFalseOnExisting.code).toBe(GrpcStatus.ALREADY_EXISTS);

        const webDb = getWebFirestore(host);
        await setDoc(webDoc(webDb, 'precond_docs/p1'), { v: 99, source: 'web-set' });

        const staleAfterWebSet = await captureAsyncError(() =>
          ref.update({ v: 2 }, { lastUpdateTime: t1 }),
        );
        expect(staleAfterWebSet.rejected).toBe(true);
        expect(staleAfterWebSet.code).toBe(GrpcStatus.FAILED_PRECONDITION);
        expect((await ref.get()).data()).toEqual({ v: 99, source: 'web-set' });

        const snapAfterWebSet = await ref.get();
        const t2 = snapAfterWebSet.updateTime;
        expect(t2).toBeDefined();
        if (t2 === undefined) {
          throw new Error('Expected updateTime on existing snapshot');
        }
        expect(t2.isEqual(t1)).toBe(false);

        const matchedPrecond: Precondition = { lastUpdateTime: t2 };
        const adminUpdateRes = await ref.update({ v: 100 }, matchedPrecond);
        const t3 = adminUpdateRes.writeTime;

        await updateDoc(webDoc(webDb, 'precond_docs/p1'), { v: 101 });
        const staleDeleteAfterWebUpdate = await captureAsyncError(() =>
          ref.delete({ lastUpdateTime: t3 }),
        );
        expect(staleDeleteAfterWebUpdate.rejected).toBe(true);
        expect(staleDeleteAfterWebUpdate.code).toBe(GrpcStatus.FAILED_PRECONDITION);
        expect((await ref.get()).data()).toEqual({ v: 101, source: 'web-set' });

        await deleteDoc(webDoc(webDb, 'precond_docs/p1'));
        const deleteMissingWithExistsTrue = await captureAsyncError(() =>
          ref.delete({ exists: true }),
        );
        expect(deleteMissingWithExistsTrue.rejected).toBe(true);
        expect(deleteMissingWithExistsTrue.code).toBe(GrpcStatus.NOT_FOUND);

        const bw = db.bulkWriter();
        const bwCreate = await bw.create(db.doc('precond_docs/bw1'), { k: 1 });
        const bwStaleErr = await captureAsyncError(() =>
          bw.delete(db.doc('precond_docs/bw1'), {
            lastUpdateTime: new Timestamp(bwCreate.writeTime.seconds + 10, 0),
          }),
        );
        expect(bwStaleErr.rejected).toBe(true);
        expect(bwStaleErr.code).toBe(GrpcStatus.FAILED_PRECONDITION);
        await bw.delete(db.doc('precond_docs/bw1'), { lastUpdateTime: bwCreate.writeTime });
        await bw.close();
      });

      it('#1974: enforces preconditions atomically in WriteBatch and across intra-tx sequences + concurrent retries in runTransaction', async () => {
        const { db, host } = openArm(armKind);
        const keepRef = db.doc('batch_tx/keep');
        const created = await keepRef.create({ count: 10 });

        const failingBatch = db.batch();
        failingBatch.set(db.doc('batch_tx/uncommitted'), { ok: true });
        failingBatch.update(
          keepRef,
          { count: 11 },
          { lastUpdateTime: new Timestamp(created.writeTime.seconds + 50, 0) },
        );
        const batchFail = await captureAsyncError(() => failingBatch.commit());
        expect(batchFail.rejected).toBe(true);
        expect(batchFail.code).toBe(GrpcStatus.FAILED_PRECONDITION);
        expect((await db.doc('batch_tx/uncommitted').get()).exists).toBe(false);
        expect((await keepRef.get()).data()).toEqual({ count: 10 });

        const seqBatch = db.batch();
        const tempBatchRef = db.doc('batch_tx/seq_batch');
        seqBatch.set(tempBatchRef, { step: 1 });
        seqBatch.delete(tempBatchRef, { exists: true });
        const seqBatchRes = await seqBatch.commit();
        expect(seqBatchRes).toHaveLength(2);
        expect((await tempBatchRef.get()).exists).toBe(false);

        const txSeqRef = db.doc('batch_tx/seq_tx');
        const rwOpts: ReadWriteTransactionOptions = { maxAttempts: 3 };
        await db.runTransaction(async (tx: Transaction) => {
          const initial = await tx.get(txSeqRef);
          expect(initial.exists).toBe(false);
          tx.set(txSeqRef, { temp: true });
          tx.delete(txSeqRef, { exists: true });
        }, rwOpts);
        expect((await txSeqRef.get()).exists).toBe(false);

        const doubleTxFail = await captureAsyncError(() =>
          db.runTransaction(async (tx: Transaction) => {
            const snap = await tx.get(keepRef);
            expect(snap.updateTime).toBeDefined();
            tx.update(keepRef, { count: 12 });
            tx.update(keepRef, { count: 13 }, { lastUpdateTime: snap.updateTime });
          }),
        );
        expect(doubleTxFail.rejected).toBe(true);
        expect(doubleTxFail.code).toBe(GrpcStatus.FAILED_PRECONDITION);
        expect((await keepRef.get()).data()).toEqual({ count: 10 });

        let attempts = 0;
        const readOpts: ReadOptions = { fieldMask: ['count'] };
        await db.runTransaction(async (tx: Transaction) => {
          attempts += 1;
          const snaps = await tx.getAll(keepRef, readOpts);
          const snap = snaps[0];
          if (snap === undefined || snap.updateTime === undefined) {
            throw new Error('Expected snapshot with updateTime');
          }
          if (attempts === 1) {
            const webDb = getWebFirestore(host);
            await updateDoc(webDoc(webDb, 'batch_tx/keep'), { count: 25 });
          }
          const baseCount = Number(snap.data()?.count ?? 0);
          tx.update(keepRef, { count: baseCount + 1 }, { lastUpdateTime: snap.updateTime });
        }, rwOpts);
        expect(attempts).toBe(2);
        expect((await keepRef.get()).data()).toEqual({ count: 26 });

        const roOpts: ReadOnlyTransactionOptions = { readOnly: true };
        const finalCount = await db.runTransaction(async (tx) => {
          const snap = await tx.get(keepRef);
          return snap.data()?.count;
        }, roOpts);
        expect(finalCount).toBe(26);
      });

      it('#1974 & #1980: supports succeeding writes and preconditions on rules-enforced getFirestore(ctx) when read rules are denied', async () => {
        const writeOnlyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /write_only/{id} { allow read: if false; allow write: if true; }
  }
}`;
        const { app, db, host } = openArm(armKind, writeOnlyRules);
        await db.doc('write_only/existing').set({ secret: 1 });

        let targetSandbox: Sandbox = host;
        if (armKind === 'remote') {
          const remoteSb = (app as unknown as { sandbox?: Sandbox }).sandbox;
          if (remoteSb !== undefined) targetSandbox = remoteSb;
        }
        const writerDb = getFirestore(targetSandbox.withAuth({ uid: 'writer' }));
        const existingErr = await captureAsyncError(() =>
          writerDb.doc('write_only/existing').delete({ exists: false }),
        );
        expect(existingErr.rejected).toBe(true);
        expect(existingErr.code).toBe('already-exists');

        const missingErr = await captureAsyncError(() =>
          writerDb.doc('write_only/missing').delete({ exists: true }),
        );
        expect(missingErr.rejected).toBe(true);
        expect(missingErr.code).toBe('not-found');

        const wRef = writerDb.doc('write_only/w1');
        const wr1 = await wRef.set({ secret: 1 });
        expect(wr1).toBeInstanceOf(WriteResult);
        const wr2 = await wRef.update({ secret: 2 }, { lastUpdateTime: wr1.writeTime });
        expect(wr2).toBeInstanceOf(WriteResult);
        expect((await db.doc('write_only/w1').get()).data()).toEqual({ secret: 2 });

        const staleWriteOnly = await captureAsyncError(() =>
          wRef.update({ secret: 3 }, { lastUpdateTime: wr1.writeTime }),
        );
        expect(staleWriteOnly.rejected).toBe(true);
        expect(staleWriteOnly.code).toBe('failed-precondition');

        const wr3 = await wRef.delete({ lastUpdateTime: wr2.writeTime });
        expect(wr3).toBeInstanceOf(WriteResult);
        expect((await db.doc('write_only/w1').get()).exists).toBe(false);

        const wBatch = writerDb.batch();
        wBatch.create(writerDb.doc('write_only/wb1'), { batchOk: true });
        expect(await wBatch.commit()).toHaveLength(1);
        expect((await db.doc('write_only/wb1').get()).data()).toEqual({ batchOk: true });
      });

      it('#1974 & #1977: matches firebase-admin@13.10.0 synchronously on query construction and precondition argument validation', () => {
        const { db } = openArm(armKind);
        const uCol = () => upstreamDb.collection('items');
        const pCol = () => db.collection('items');

        const queryCases: ReadonlyArray<readonly [string, () => unknown, () => unknown]> = [
          ['where(a, >, null)', () => uCol().where('a', '>', null), () => pCol().where('a', '>', null)],
          ['where(a, >=, null)', () => uCol().where('a', '>=', null), () => pCol().where('a', '>=', null)],
          ['where(a, <, null)', () => uCol().where('a', '<', null), () => pCol().where('a', '<', null)],
          ['where(a, <=, null)', () => uCol().where('a', '<=', null), () => pCol().where('a', '<=', null)],
          ['where(a, array-contains, null)', () => uCol().where('a', 'array-contains', null), () => pCol().where('a', 'array-contains', null)],
          ['where(a, <, NaN)', () => uCol().where('a', '<', Number.NaN), () => pCol().where('a', '<', Number.NaN)],
          ['where(a, >, NaN)', () => uCol().where('a', '>', Number.NaN), () => pCol().where('a', '>', Number.NaN)],
          ['where(a, array-contains, NaN)', () => uCol().where('a', 'array-contains', Number.NaN), () => pCol().where('a', 'array-contains', Number.NaN)],
          ['where(a, ==, null) allowed', () => uCol().where('a', '==', null), () => pCol().where('a', '==', null)],
          ['where(a, !=, NaN) allowed', () => uCol().where('a', '!=', Number.NaN), () => pCol().where('a', '!=', Number.NaN)],
          ['where(a, in, [null, NaN]) allowed', () => uCol().where('a', 'in', [null, Number.NaN]), () => pCol().where('a', 'in', [null, Number.NaN])],
          [
            'Filter.where lazy construction',
            () => UpstreamFilter.where(123 as unknown as string, '==', null),
            () => Filter.where(123 as unknown as string, '==', null),
          ],
          [
            'col.where(Filter.or(Filter.where(a, >, null)))',
            () => uCol().where(UpstreamFilter.or(UpstreamFilter.where('a', '>', null))),
            () => pCol().where(Filter.or(Filter.where('a', '>', null))),
          ],
          ['limit(1.5)', () => uCol().limit(1.5), () => pCol().limit(1.5)],
          ['limit(NaN)', () => uCol().limit(Number.NaN), () => pCol().limit(Number.NaN)],
          ['limit(Infinity)', () => uCol().limit(Number.POSITIVE_INFINITY), () => pCol().limit(Number.POSITIVE_INFINITY)],
          ['limitToLast(1.5)', () => uCol().limitToLast(1.5), () => pCol().limitToLast(1.5)],
          ['offset(1.5)', () => uCol().offset(1.5), () => pCol().offset(1.5)],
          [
            'where(FieldPath.documentId(), ==, a/b)',
            () => uCol().where(UpstreamFieldPath.documentId(), '==', 'a/b'),
            () => pCol().where(FieldPath.documentId(), '==', 'a/b'),
          ],
          ['where(__name__, >, a/b)', () => uCol().where('__name__', '>', 'a/b'), () => pCol().where('__name__', '>', 'a/b')],
          [
            'where(documentId(), in, [ok, a/b])',
            () => uCol().where(UpstreamFieldPath.documentId(), 'in', ['ok', 'a/b']),
            () => pCol().where(FieldPath.documentId(), 'in', ['ok', 'a/b']),
          ],
          [
            'orderBy(documentId()).startAt(a/b)',
            () => uCol().orderBy(UpstreamFieldPath.documentId()).startAt('a/b'),
            () => pCol().orderBy(FieldPath.documentId()).startAt('a/b'),
          ],
          [
            'collectionGroup where(documentId(), ==, single-segment)',
            () => upstreamDb.collectionGroup('items').where(UpstreamFieldPath.documentId(), '==', 'only-one'),
            () => db.collectionGroup('items').where(FieldPath.documentId(), '==', 'only-one'),
          ],
          [
            'startAt(1).where(a, >, null) cursor-first error precedence',
            () => uCol().orderBy('a').startAt(1).where('a', '>', null),
            () => pCol().orderBy('a').startAt(1).where('a', '>', null),
          ],
          [
            'doc.delete non-boolean exists precondition',
            () => { void upstreamDb.doc('items/d1').delete({ exists: 'yes' as unknown as boolean }); },
            () => { void db.doc('items/d1').delete({ exists: 'yes' as unknown as boolean }); },
          ],
          [
            'doc.update map exists:false precondition',
            () => { void upstreamDb.doc('items/d1').update({ a: 1 }, { exists: false as unknown as true }); },
            () => { void db.doc('items/d1').update({ a: 1 }, { exists: false }); },
          ],
          [
            'doc.update vararg exists:false precondition',
            () => { void upstreamDb.doc('items/d1').update('a', 1, { exists: false as unknown as true }); },
            () => { void db.doc('items/d1').update('a', 1, { exists: false }); },
          ],
          [
            'batch.delete conflicting exists + lastUpdateTime preconditions',
            () => upstreamDb.batch().delete(upstreamDb.doc('items/d1'), { exists: true, lastUpdateTime: new UpstreamTimestamp(1, 0) }),
            () => db.batch().delete(db.doc('items/d1'), { exists: true, lastUpdateTime: new Timestamp(1, 0) }),
          ],
        ];

        for (const [label, upstreamFn, pyricFn] of queryCases) {
          const up = captureSyncError(upstreamFn);
          const py = captureSyncError(pyricFn);
          expect({ label, threw: py.threw, message: py.message }).toEqual({
            label,
            threw: up.threw,
            message: up.message,
          });
          if (py.threw) {
            expect(py.code).toBe(GrpcStatus.INVALID_ARGUMENT);
          }
        }

        const compatApplyErr = captureSyncError(() =>
          db.collection('items').applyFilter({ kind: 'where', field: 'a', op: '>', value: null }),
        );
        expect(compatApplyErr.threw).toBe(true);
        expect(compatApplyErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);

        const compatCursorErr = captureSyncError(() =>
          db.collection('items').orderBy(FieldPath.documentId()).startCursor(['a/b'], true),
        );
        expect(compatCursorErr.threw).toBe(true);
        expect(compatCursorErr.code).toBe(GrpcStatus.INVALID_ARGUMENT);
      });
    });
  }
});
