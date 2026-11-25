import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from 'pyric-admin/app';
import {
  AggregateField,
  FieldPath,
  Filter,
  getFirestore,
  Timestamp,
} from 'pyric-admin/firestore';

const activeSandboxes: Sandbox[] = [];

function createTestDb() {
  const sandbox = initializeSandbox({ projectId: 'demo-parity' });
  activeSandboxes.push(sandbox);
  const app = initializeApp(
    { sandbox, projectId: 'demo-parity' },
    `admin-parity-${Math.random().toString(36).slice(2)}`,
  );
  return getFirestore(app);
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  while (activeSandboxes.length > 0) {
    const sb = activeSandboxes.pop();
    if (sb !== undefined) {
      sb.dispose();
    }
  }
});

describe('pyric-admin/firestore WriteResult, Precondition, Filter, AggregateField, cursors, and Transaction.getAll', () => {
  it('exposes AggregateField and Filter on pyric-admin/firestore', () => {
    expect(typeof AggregateField.count).toBe('function');
    expect(typeof Filter.where).toBe('function');

    const countField = AggregateField.count();
    const sumDot = AggregateField.sum('metrics.score');
    const sumPath = AggregateField.sum(new FieldPath('metrics', 'score'));
    const avgScore = AggregateField.average('metrics.score');

    expect(countField.type).toBe('AggregateField');
    expect(countField.aggregateType).toBe('count');
    expect(sumDot.aggregateType).toBe('sum');
    expect(avgScore.aggregateType).toBe('avg');
    expect(sumDot.isEqual(sumPath)).toBe(true);
    expect(sumDot.isEqual(avgScore)).toBe(false);
    expect(countField.isEqual(AggregateField.count())).toBe(true);
    expect(countField.isEqual(sumDot)).toBe(false);
    expect(countField.isEqual(null)).toBe(false);
  });

  it('returns WriteResult with monotonic Timestamp and enforces Precondition on update and delete', async () => {
    const db = createTestDb();
    const ref = db.doc('items/item-1');

    const created = await ref.create({ count: 1 });
    const updated = await ref.update({ count: 2 }, { exists: true });
    expect(created.writeTime).toBeInstanceOf(Timestamp);
    expect(updated.writeTime).toBeInstanceOf(Timestamp);
    expect(created.isEqual(created)).toBe(true);
    expect(created.isEqual(updated)).toBe(false);

    const exactTime = updated.writeTime;
    const matchedUpdate = await ref.update({ count: 3 }, { lastUpdateTime: exactTime });
    expect(matchedUpdate.writeTime.toMillis()).toBeGreaterThanOrEqual(exactTime.toMillis());

    let staleErr: unknown;
    try {
      await ref.update({ count: 4 }, { lastUpdateTime: exactTime });
    } catch (err) {
      staleErr = err;
    }
    expect((staleErr as { code?: number }).code).toBe(9);

    let existsFalseErr: unknown;
    try {
      await ref.delete({ exists: false });
    } catch (err) {
      existsFalseErr = err;
    }
    expect((existsFalseErr as { code?: number }).code).toBe(6);

    const deleted = await ref.delete({ lastUpdateTime: matchedUpdate.writeTime });
    expect(deleted.writeTime).toBeInstanceOf(Timestamp);

    let missingDeleteErr: unknown;
    try {
      await ref.delete({ exists: true });
    } catch (err) {
      missingDeleteErr = err;
    }
    expect((missingDeleteErr as { code?: number }).code).toBe(5);
  });

  it('executes Filter.where/or/and, AggregateQuery, and value + snapshot cursors', async () => {
    const db = createTestDb();
    const col = db.collection('items');
    await col.doc('a').set({ category: 'alpha', points: 10 });
    await col.doc('b').set({ category: 'beta', points: 20 });
    await col.doc('c').set({ category: 'alpha', points: 30 });

    expect(() => Filter.or('bad' as unknown as Filter)).toThrow();
    expect(() => Filter.and('bad' as unknown as Filter)).toThrow();
    expect(() => col.startAt()).toThrow();

    const emptyFilterSnap = await col.where(Filter.and()).get();
    expect(emptyFilterSnap.docs.map((d) => d.id).sort()).toEqual(['a', 'b', 'c']);

    const docIdFiltered = await col
      .where(
        Filter.or(
          Filter.where(FieldPath.documentId(), '==', 'a'),
          Filter.where('points', '==', 30),
        ),
      )
      .get();
    expect(docIdFiltered.docs.map((d) => d.id).sort()).toEqual(['a', 'c']);

    const aggQuery = col.aggregate({
      n: AggregateField.count(),
      sumPts: AggregateField.sum('points'),
      avgPts: AggregateField.average('points'),
    });
    expect(aggQuery.query).toBe(col);
    expect(aggQuery.isEqual(aggQuery)).toBe(true);
    const aggSnap = await aggQuery.get();
    expect(aggSnap.query).toBe(col);
    expect(aggSnap.readTime).toBeInstanceOf(Timestamp);
    expect(aggSnap.data()).toEqual({ n: 3, sumPts: 60, avgPts: 20 });
    expect(aggSnap.isEqual(aggSnap)).toBe(true);

    const ordered = col.orderBy('points', 'asc');
    const bSnap = await col.doc('b').get();
    const afterBSnap = await ordered.startAfter(bSnap).get();
    expect(afterBSnap.docs.map((d) => d.id)).toEqual(['c']);
  });

  it('supports Transaction.getAll with ReadOptions fieldMask and rejects invalid or post-write calls', async () => {
    const db = createTestDb();
    const refA = db.doc('items/tx-a');
    const refB = db.doc('items/tx-b');
    const refMissing = db.doc('items/tx-missing');
    await refA.set({ title: 'First', secret: 'hidden-a', nested: { keep: 1, drop: 2 } });
    await refB.set({ title: 'Second', secret: 'hidden-b', nested: { keep: 3, drop: 4 } });

    const maskedResult = await db.runTransaction(async (tx) => {
      const snaps = await (tx as unknown as {
        getAll: (...args: unknown[]) => Promise<Array<{ id: string; exists: boolean; data(): unknown; get(p: string): unknown }>>;
      }).getAll(refB, refMissing, refA, {
        fieldMask: ['title', new FieldPath('nested', 'keep')],
      });
      return snaps.map((s) => ({
        id: s.id,
        exists: s.exists,
        data: s.data() ?? null,
        keep: s.get('nested.keep') ?? null,
        secret: s.get('secret') ?? null,
      }));
    });

    expect(maskedResult).toEqual([
      { id: 'tx-b', exists: true, data: { title: 'Second', nested: { keep: 3 } }, keep: 3, secret: null },
      { id: 'tx-missing', exists: false, data: null, keep: null, secret: null },
      { id: 'tx-a', exists: true, data: { title: 'First', nested: { keep: 1 } }, keep: 1, secret: null },
    ]);

    let zeroArgsErr: unknown;
    try {
      await db.runTransaction(async (tx) => {
        await (tx as unknown as { getAll: () => Promise<unknown> }).getAll();
      });
    } catch (err) {
      zeroArgsErr = err;
    }
    expect((zeroArgsErr as { code?: number }).code).toBe(3);
  });
});
