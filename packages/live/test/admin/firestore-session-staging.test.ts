/**
 * Unit tests for `admin/firestore-session-staging.ts`: bounded delta
 * collection plus `WriteBatch` and `Transaction` prototype staging (including
 * retry-attempt isolation and `ReadOptions.fieldMask` skips).
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import {
  addAdminQuerySnapshot,
  beginAdminTransactionSession,
  commitAdminBatchDelta,
  commitAdminTransactionDelta,
  hasAdminQueryProjection,
  patchAdminFirestoreTransaction,
  patchAdminFirestoreWriteBatch,
} from '../../src/admin/firestore-session-staging.js';
import { DeltaOps } from '../../src/firestore-session-capture.js';

interface AdminFirestorePkg {
  Firestore: new (settings: { projectId: string }) => {
    collection(path: string): {
      select(...fields: string[]): unknown;
      where(field: string, op: string, value: unknown): unknown;
    };
    terminate(): Promise<void>;
  };
}

const fromAdmin = createRequire(createRequire(import.meta.url).resolve('firebase-admin/firestore'));
const sdk = fromAdmin('@google-cloud/firestore') as AdminFirestorePkg;

function makeDocSnap(path: string, data: Record<string, unknown> | undefined) {
  const parts = path.split('/');
  return {
    exists: data !== undefined,
    ref: { path, id: parts[parts.length - 1] ?? '' },
    data: () => data,
  };
}

describe('admin/firestore-session-staging', () => {
  test('stages WriteBatch create, set, update, and delete ops and clears state on _reset()', () => {
    class FakeWriteBatch {
      create(_ref: unknown, _data: unknown) {
        return this;
      }
      set(_ref: unknown, _data: unknown, _opts?: unknown) {
        return this;
      }
      update(_ref: unknown, ..._rest: unknown[]) {
        return this;
      }
      delete(_ref: unknown, _prec?: unknown) {
        return this;
      }
      _reset() {}
    }
    patchAdminFirestoreWriteBatch(FakeWriteBatch.prototype);

    const batch = new FakeWriteBatch();
    batch.create({ path: 'items/temp' }, { n: 1 });
    batch._reset();
    expect(commitAdminBatchDelta(batch)).toBeUndefined();

    batch.create({ path: 'items/c1' }, { a: 1 });
    batch.set({ path: 'items/s1' }, { b: 2 }, { merge: true });
    batch.update({ path: 'items/u1' }, 'count', 3, { exists: true });
    batch.delete({ path: 'items/d1' });

    expect(commitAdminBatchDelta(batch)).toEqual({
      firestore: [
        { kind: 'set', path: 'items/c1', data: { a: 1 } },
        { kind: 'set', path: 'items/s1', data: { b: 2 }, merge: true },
        { kind: 'update', path: 'items/u1', data: { count: 3 } },
        { kind: 'delete', path: 'items/d1' },
      ],
    });
  });

  test('captures Transaction reads and writes per retry attempt, discarding failed attempts and skipping fieldMask', async () => {
    class FakeTransaction {
      async get(target: { path?: string; docs?: unknown[]; aggregate?: boolean }) {
        if (target.aggregate) return { data: () => ({ count: 5 }) };
        if (target.docs !== undefined) return { docs: target.docs };
        return makeDocSnap(target.path ?? 'items/x', { version: 1 });
      }
      async getAll(...args: unknown[]) {
        const refs = args.filter((entry) => typeof (entry as { path?: unknown }).path === 'string') as {
          path: string;
        }[];
        return refs.map((ref) => {
          if (ref.path.endsWith('missing')) return makeDocSnap(ref.path, undefined);
          return makeDocSnap(ref.path, { loaded: true });
        });
      }
      create(_ref: unknown, _data: unknown) {
        return this;
      }
      set(_ref: unknown, _data: unknown, _opts?: unknown) {
        return this;
      }
      update(_ref: unknown, ..._rest: unknown[]) {
        return this;
      }
      delete(_ref: unknown, _prec?: unknown) {
        return this;
      }
      async runTransactionOnce(updateFn: (tx: FakeTransaction) => Promise<unknown>) {
        return updateFn(this);
      }
    }
    patchAdminFirestoreTransaction(FakeTransaction.prototype);

    let attempts = 0;
    const updateCallback = async (tx: FakeTransaction) => {
      attempts += 1;
      if (attempts === 1) {
        await tx.get({ path: 'items/stale-attempt' });
        tx.set({ path: 'items/stale-write' }, { bad: true });
        throw new Error('ABORTED');
      }
      await tx.get({ path: 'items/read-doc' });
      await tx.get({ docs: [makeDocSnap('items/query-doc', { q: 1 })] });
      await tx.get({ _queryOptions: { projection: { fields: ['q'] } }, docs: [makeDocSnap('items/projected-doc', { q: 1 })] } as unknown as { docs: unknown[] });
      await tx.get({ aggregate: true });
      await tx.getAll({ path: 'items/batch-found' }, { path: 'items/batch-missing' });
      await tx.getAll({ path: 'items/masked' }, { fieldMask: ['loaded'] });
      tx.create({ path: 'items/tx-created' }, { c: 1 });
      tx.set({ path: 'items/tx-set' }, { s: 2 }, { merge: true });
      tx.update({ path: 'items/read-doc' }, { version: 2 });
      tx.delete({ path: 'items/tx-deleted' });
      return 'done';
    };

    const session = beginAdminTransactionSession(updateCallback);
    const tx = new FakeTransaction();
    await expect(tx.runTransactionOnce(updateCallback)).rejects.toThrow('ABORTED');
    await tx.runTransactionOnce(updateCallback);

    expect(commitAdminTransactionDelta(session)).toEqual({
      firestore: [
        { kind: 'set', path: 'items/read-doc', data: { version: 1 } },
        { kind: 'set', path: 'items/query-doc', data: { q: 1 } },
        { kind: 'set', path: 'items/batch-found', data: { loaded: true } },
        { kind: 'delete', path: 'items/batch-missing' },
        { kind: 'set', path: 'items/tx-created', data: { c: 1 } },
        { kind: 'set', path: 'items/tx-set', data: { s: 2 }, merge: true },
        { kind: 'update', path: 'items/read-doc', data: { version: 2 } },
        { kind: 'delete', path: 'items/tx-deleted' },
      ],
      skipped: { unsupported: 2 },
    });
  });

  test('detects real @google-cloud/firestore Query.select() projections including empty select()', async () => {
    const db = new sdk.Firestore({ projectId: 'demo-projections' });
    try {
      const col = db.collection('items');
      expect(hasAdminQueryProjection(col)).toBe(false);
      expect(hasAdminQueryProjection(col.where('active', '==', true))).toBe(false);
      expect(hasAdminQueryProjection(col.select('title'))).toBe(true);
      expect(hasAdminQueryProjection(col.select())).toBe(true);
      expect(hasAdminQueryProjection({ query: col.select('title') })).toBe(true);
    } finally {
      await db.terminate();
    }
  });

  test('captures QuerySnapshot docChanges as set and invalidate ops without authoritative delete (#2540 N2)', () => {
    const firstSnap = {
      docs: [
        makeDocSnap('tasks/t1', { status: 'open' }),
        makeDocSnap('tasks/t2', { status: 'open' }),
      ],
      docChanges: () => [
        { type: 'added', doc: makeDocSnap('tasks/t1', { status: 'open' }) },
        { type: 'added', doc: makeDocSnap('tasks/t2', { status: 'open' }) },
      ],
    };
    const initialOps = new DeltaOps();
    addAdminQuerySnapshot(initialOps, firstSnap, false);
    expect(initialOps.delta()).toEqual({
      firestore: [
        { kind: 'set', path: 'tasks/t1', data: { status: 'open' } },
        { kind: 'set', path: 'tasks/t2', data: { status: 'open' } },
      ],
    });

    const secondSnap = {
      docs: [makeDocSnap('tasks/t1', { status: 'open', pinned: true })],
      docChanges: () => [
        { type: 'modified', doc: makeDocSnap('tasks/t1', { status: 'open', pinned: true }) },
        { type: 'removed', doc: makeDocSnap('tasks/t2', { status: 'done' }) },
      ],
    };
    const deliveryOps = new DeltaOps();
    addAdminQuerySnapshot(deliveryOps, secondSnap, true);
    expect(deliveryOps.delta()).toEqual({
      firestore: [
        { kind: 'set', path: 'tasks/t1', data: { status: 'open', pinned: true } },
        { kind: 'invalidate', path: 'tasks/t2' },
      ],
    });
  });

  test('proves pre-commit Transaction rollbacks uncommitted only when commit hook and _writeBatch internals match, failing closed otherwise (#3283)', async () => {
    const { isProvenUncommittedSubject } = await import('../../src/session-data.js');

    // 1. Intact Transaction prototype (`runTransactionOnce` + `commit`) and expected `_writeBatch` (`typeof isEmpty === 'boolean'`):
    class IntactTransaction {
      _writeBatch: unknown = { isEmpty: true };
      create(_ref: unknown, _data: unknown) {
        this._writeBatch = { isEmpty: false };
        return this;
      }
      set(_ref: unknown, _data: unknown) {
        this._writeBatch = { isEmpty: false };
        return this;
      }
      update(_ref: unknown, ..._rest: unknown[]) {
        this._writeBatch = { isEmpty: false };
        return this;
      }
      delete(_ref: unknown) {
        this._writeBatch = { isEmpty: false };
        return this;
      }
      async commit() {
        throw new Error('UNAVAILABLE');
      }
      async runTransactionOnce(updateFn: (tx: IntactTransaction) => Promise<unknown>) {
        const out = await updateFn(this);
        await this.commit();
        return out;
      }
    }
    patchAdminFirestoreTransaction(IntactTransaction.prototype);

    // 1a. Callback throws before `commit()` ever runs -> proven uncommitted (`true`).
    const preCommitCb = async (tx: IntactTransaction) => {
      tx.update({ path: 'orders/ord-2' }, { status: 'rolled-back' });
      throw new Error('abort-tx');
    };
    const preCommitSession = beginAdminTransactionSession(preCommitCb);
    await expect(new IntactTransaction().runTransactionOnce(preCommitCb)).rejects.toThrow('abort-tx');
    expect(isProvenUncommittedSubject(preCommitSession)).toBe(true);

    // 1b. Callback resolves, `commit()` runs with non-empty `_writeBatch` and rejects -> ambiguous (`false`).
    const commitFailCb = async (tx: IntactTransaction) => {
      tx.set({ path: 'orders/ord-2' }, { status: 'maybe-written' });
      return 'done';
    };
    const commitFailSession = beginAdminTransactionSession(commitFailCb);
    await expect(new IntactTransaction().runTransactionOnce(commitFailCb)).rejects.toThrow('UNAVAILABLE');
    expect(isProvenUncommittedSubject(commitFailSession)).toBe(false);

    // 1c. Retry #1 enters `commit()` and fails ambiguously, then Retry #2 throws before `commit()` -> stays ambiguous (`false`).
    let retryCount = 0;
    const retryCb = async (tx: IntactTransaction) => {
      retryCount += 1;
      tx.set({ path: 'orders/ord-2' }, { attempt: retryCount });
      if (retryCount === 2) throw new Error('abort-on-retry');
      return 'try-commit';
    };
    const retrySession = beginAdminTransactionSession(retryCb);
    const retryTx = new IntactTransaction();
    await expect(retryTx.runTransactionOnce(retryCb)).rejects.toThrow('UNAVAILABLE');
    retryTx._writeBatch = { isEmpty: true };
    await expect(retryTx.runTransactionOnce(retryCb)).rejects.toThrow('abort-on-retry');
    expect(isProvenUncommittedSubject(retrySession)).toBe(false);

    // 1d. Reshaped `_writeBatch` (`undefined`, missing `isEmpty`, or non-boolean `isEmpty`) -> fails closed (`false`).
    for (const badBatch of [undefined, null, {}, { isEmpty: 'nope' }]) {
      const reshapedCb = async () => {
        throw new Error('abort-reshaped');
      };
      const reshapedSession = beginAdminTransactionSession(reshapedCb);
      const reshapedTx = new IntactTransaction();
      reshapedTx._writeBatch = badBatch;
      await expect(reshapedTx.runTransactionOnce(reshapedCb)).rejects.toThrow('abort-reshaped');
      expect(isProvenUncommittedSubject(reshapedSession)).toBe(false);
    }

    // 1e. Own instance `commit` property shadowing prototype wrapper -> fails closed (`false`).
    const shadowedCb = async () => {
      throw new Error('abort-shadowed');
    };
    const shadowedSession = beginAdminTransactionSession(shadowedCb);
    const shadowedTx = new IntactTransaction();
    Object.defineProperty(shadowedTx, 'commit', { value: async () => {} });
    await expect(shadowedTx.runTransactionOnce(shadowedCb)).rejects.toThrow('abort-shadowed');
    expect(isProvenUncommittedSubject(shadowedSession)).toBe(false);

    // 2. Prototype missing `commit` when `patchAdminFirestoreTransaction` runs -> fails closed (`false`).
    class CommitlessTransaction {
      _writeBatch = { isEmpty: true };
      async runTransactionOnce(updateFn: (tx: CommitlessTransaction) => Promise<unknown>) {
        return updateFn(this);
      }
    }
    patchAdminFirestoreTransaction(CommitlessTransaction.prototype);
    const noCommitHookCb = async () => {
      throw new Error('abort-no-commit-hook');
    };
    const noCommitHookSession = beginAdminTransactionSession(noCommitHookCb);
    await expect(new CommitlessTransaction().runTransactionOnce(noCommitHookCb)).rejects.toThrow('abort-no-commit-hook');
    expect(isProvenUncommittedSubject(noCommitHookSession)).toBe(false);

    // 3. `runTransactionOnce` never entered (e.g. renamed in future SDK) -> fails closed (`false`).
    const neverEnteredSession = beginAdminTransactionSession(async () => {});
    expect(isProvenUncommittedSubject(neverEnteredSession)).toBe(false);

    // 4. Throwing getters on `_writeBatch`, `_writeBatch.isEmpty`, or `_transactionIdPromise` fail closed (`false`)
    //    without blocking real `runTransactionOnce` / `commit` execution.
    const throwingBatchGetterCb = async () => {
      throw new Error('abort-after-throwing-batch-getter');
    };
    const throwingBatchSession = beginAdminTransactionSession(throwingBatchGetterCb);
    const throwingBatchTx = new IntactTransaction();
    Object.defineProperty(throwingBatchTx, '_writeBatch', {
      get() {
        throw new Error('getter-boom');
      },
    });
    await expect(throwingBatchTx.runTransactionOnce(throwingBatchGetterCb)).rejects.toThrow(
      'abort-after-throwing-batch-getter',
    );
    expect(isProvenUncommittedSubject(throwingBatchSession)).toBe(false);

    const throwingIsEmptyCb = async () => {
      throw new Error('abort-after-throwing-isEmpty');
    };
    const throwingIsEmptySession = beginAdminTransactionSession(throwingIsEmptyCb);
    const throwingIsEmptyTx = new IntactTransaction();
    const throwingBatchObj = {};
    Object.defineProperty(throwingBatchObj, 'isEmpty', {
      get() {
        throw new Error('isEmpty-boom');
      },
    });
    throwingIsEmptyTx._writeBatch = throwingBatchObj;
    await expect(throwingIsEmptyTx.runTransactionOnce(throwingIsEmptyCb)).rejects.toThrow(
      'abort-after-throwing-isEmpty',
    );
    expect(isProvenUncommittedSubject(throwingIsEmptySession)).toBe(false);

    let realCommitRan = false;
    class ThrowingCommitPropertyTransaction {
      _writeBatch: unknown = { isEmpty: true };
      async commit() {
        realCommitRan = true;
        throw new Error('real-commit-error');
      }
      async runTransactionOnce(updateFn: (tx: ThrowingCommitPropertyTransaction) => Promise<unknown>) {
        const out = await updateFn(this);
        await this.commit();
        return out;
      }
    }
    patchAdminFirestoreTransaction(ThrowingCommitPropertyTransaction.prototype);
    const throwingTxIdCb = async () => 'ready-to-commit';
    const throwingTxIdSession = beginAdminTransactionSession(throwingTxIdCb);
    const throwingTxIdInstance = new ThrowingCommitPropertyTransaction();
    Object.defineProperty(throwingTxIdInstance, '_transactionIdPromise', {
      get() {
        throw new Error('txId-getter-boom');
      },
    });
    await expect(throwingTxIdInstance.runTransactionOnce(throwingTxIdCb)).rejects.toThrow('real-commit-error');
    expect(realCommitRan).toBe(true);
    expect(isProvenUncommittedSubject(throwingTxIdSession)).toBe(false);
  });
});
