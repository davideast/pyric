/**
 * Unit tests for `admin/firestore-session-staging.ts`: bounded delta
 * collection plus `WriteBatch` and `Transaction` prototype staging (including
 * retry-attempt isolation and `ReadOptions.fieldMask` skips).
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import {
  beginAdminTransactionSession,
  commitAdminBatchDelta,
  commitAdminTransactionDelta,
  hasAdminQueryProjection,
  patchAdminFirestoreTransaction,
  patchAdminFirestoreWriteBatch,
} from '../../src/admin/firestore-session-staging.js';

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
});
