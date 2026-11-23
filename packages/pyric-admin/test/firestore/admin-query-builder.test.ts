import { afterEach, describe, expect, it } from 'bun:test';
import { PyricDeferredApiError } from 'pyric/app/internal';
import { deleteApp, getApps } from '../../src/app/index.js';
import {
  AggregateField,
  FieldPath,
  Filter,
  getFirestore,
  Timestamp,
  type FirestoreDataConverter,
} from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

const activeHosts: Array<{ dispose(): void }> = [];

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  while (activeHosts.length > 0) {
    const host = activeHosts.pop();
    if (host !== undefined) {
      host.dispose();
    }
  }
});

interface CatalogItem {
  readonly code: string;
  readonly rank: number;
}

const catalogConverter: FirestoreDataConverter<CatalogItem> = {
  toFirestore(item: CatalogItem) {
    return { code: item.code.toUpperCase(), rank: item.rank };
  },
  fromFirestore(snap) {
    const raw = snap.data();
    return {
      code: String(raw.code).toLowerCase(),
      rank: Number(raw.rank) * 10,
    };
  },
};

describe.each([
  ['local', inProcessFirestoreArm],
  ['remote', sharedWorkerFirestoreArm],
] as const)('pyric-admin/firestore Query builder parity (%s arm)', (_armName, makeArm) => {
  it('composes cursors, FieldPath.documentId() DocumentReference bounds, offset, limit, limitToLast, count, select, and stream', async () => {
    const pair = makeArm();
    activeHosts.push(pair.host);
    const db = getFirestore(pair.app);
    const col = db.collection('catalog');

    await col.doc('a').set({ rank: 10, tier: 1, title: 'Alpha', meta: { tag: 't1', secret: 's1' } });
    await col.doc('b').set({ rank: 20, tier: 1, title: 'Beta', meta: { tag: 't2', secret: 's2' } });
    await col.doc('c').set({ rank: 30, tier: 2, title: 'Gamma', meta: { tag: 't3', secret: 's3' } });
    await col.doc('d').set({ rank: 40, tier: 2, title: 'Delta', meta: { tag: 't4', secret: 's4' } });

    const ordered = col.orderBy('rank', 'asc');
    expect((await ordered.startAt(20).endAt(30).get()).docs.map((d) => d.id)).toEqual(['b', 'c']);
    expect((await ordered.startAfter(10).endBefore(40).get()).docs.map((d) => d.id)).toEqual([
      'b',
      'c',
    ]);
    expect((await ordered.startAfter(10).limit(1).get()).docs.map((d) => d.id)).toEqual(['b']);

    const byDocId = col.orderBy(FieldPath.documentId());
    expect((await byDocId.startAfter('b').get()).docs.map((d) => d.id)).toEqual(['c', 'd']);
    expect((await byDocId.startAfter(col.doc('b')).endAt(col.doc('c')).get()).docs.map((d) => d.id)).toEqual([
      'c',
    ]);

    expect(() => byDocId.startAfter(db.doc('other/b'))).toThrow(/not part of the query result set/);
    expect(() => col.startAt(10)).toThrow(/Too many cursor values specified/);
    expect(() => ordered.startAt(10, 20)).toThrow(/Too many cursor values specified/);
    expect(() => ordered.startAt(10).where('tier', '==', 1)).toThrow(
      /Cannot specify a where\(\) filter after calling startAt/,
    );
    expect(() => ordered.startAt(10).orderBy('tier')).toThrow(
      /Cannot specify an orderBy\(\) constraint after calling startAt/,
    );

    expect((await ordered.offset(1).get()).docs.map((d) => d.id)).toEqual(['b', 'c', 'd']);
    expect((await ordered.offset(1).limit(2).get()).docs.map((d) => d.id)).toEqual(['b', 'c']);
    expect((await ordered.limit(2).offset(1).get()).docs.map((d) => d.id)).toEqual(['b', 'c']);
    expect((await ordered.limit(2).offset(2).offset(0).get()).docs.map((d) => d.id)).toEqual([
      'a',
      'b',
    ]);
    expect((await ordered.offset(1).limitToLast(2).get()).docs.map((d) => d.id)).toEqual([
      'b',
      'c',
    ]);
    expect((await ordered.limitToLast(2).offset(1).get()).docs.map((d) => d.id)).toEqual([
      'b',
      'c',
    ]);

    const totalCountSnap = await col.count().get();
    expect(totalCountSnap.data()).toEqual({ count: 4 });
    expect(totalCountSnap.readTime).toBeInstanceOf(Timestamp);
    expect(totalCountSnap.query).toBe(col);

    expect((await ordered.offset(1).count().get()).data()).toEqual({ count: 3 });
    expect((await ordered.offset(1).limit(2).count().get()).data()).toEqual({ count: 2 });
    expect((await ordered.offset(10).count().get()).data()).toEqual({ count: 0 });
    expect(
      (
        await ordered
          .offset(1)
          .limit(2)
          .aggregate({
            n: AggregateField.count(),
            sumRank: AggregateField.sum('rank'),
            avgRank: AggregateField.average('rank'),
          })
          .get()
      ).data(),
    ).toEqual({ n: 2, sumRank: 50, avgRank: 25 });

    let negOffsetCountErr: unknown;
    try {
      await ordered.offset(-1).count().get();
    } catch (err) {
      negOffsetCountErr = err;
    }
    expect((negOffsetCountErr as { code?: number } | undefined)?.code).toBe(3);

    const projected = await ordered.offset(1).limit(2).select('title', new FieldPath('meta', 'tag')).get();
    expect(projected.docs.map((d) => ({ id: d.id, data: d.data(), secret: d.get('meta.secret') ?? null }))).toEqual([
      { id: 'b', data: { title: 'Beta', meta: { tag: 't2' } }, secret: null },
      { id: 'c', data: { title: 'Gamma', meta: { tag: 't3' } }, secret: null },
    ]);

    const dataEvents: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const readable = ordered.startAt(20).limit(2).stream();
      readable.on('data', (docSnap: { id: string }) => {
        dataEvents.push(docSnap.id);
      });
      readable.on('end', () => resolve());
      readable.on('error', (err) => reject(err));
    });
    expect(dataEvents).toEqual(['b', 'c']);

    expect(() => ordered.limitToLast(1).stream()).toThrow(
      'Query results for queries that include limitToLast() constraints cannot be streamed. Use Query.get() instead.',
    );
  });

  it('tracks Query.isEqual and AggregateQuery.isEqual across cursors, replacements, converters, listDocuments, and deferred getPartitions', async () => {
    const pair = makeArm();
    activeHosts.push(pair.host);
    const db = getFirestore(pair.app);
    const col = db.collection('eqItems');

    const baseOrdered = col.orderBy('rank');
    expect(baseOrdered.startAfter(1).isEqual(baseOrdered.startAfter(1))).toBe(true);
    expect(baseOrdered.startAfter(1).isEqual(baseOrdered.startAfter(2))).toBe(false);
    expect(baseOrdered.startAt(1).isEqual(baseOrdered.startAfter(1))).toBe(false);
    expect(baseOrdered.startAt(1).startAfter(2).isEqual(baseOrdered.startAfter(2))).toBe(true);
    expect(baseOrdered.endBefore(9).endAt(5).isEqual(baseOrdered.endAt(5))).toBe(true);
    expect(col.limit(5).limit(2).isEqual(col.limit(2))).toBe(true);
    expect(col.offset(3).offset(1).isEqual(col.offset(1))).toBe(true);
    expect(col.offset(0).isEqual(col)).toBe(false);
    expect(col.select('a').select('b').isEqual(col.select('b'))).toBe(true);
    expect(col.where(Filter.and()).isEqual(col)).toBe(true);

    expect(col.where('rank', '>', 1).count().isEqual(col.where('rank', '>', 1).count())).toBe(true);
    expect(col.where('rank', '>', 1).count().isEqual(col.where('rank', '>', 2).count())).toBe(
      false,
    );
    expect(
      col
        .count()
        .isEqual(col.aggregate({ count: AggregateField.sum('rank') })),
    ).toBe(false);

    const typedCol = col.withConverter(catalogConverter);
    await typedCol.doc('real').set({ code: 'ItemA', rank: 3 });
    await db.doc('eqItems/phantom/nested/leaf').set({ v: 1 });

    const listed = await typedCol.listDocuments();
    expect(listed.map((r) => r.id)).toEqual(['phantom', 'real']);
    const phantomSnap = await listed[0]?.get();
    const realSnap = await listed[1]?.get();
    expect(phantomSnap?.exists).toBe(false);
    expect(realSnap?.exists).toBe(true);
    expect(realSnap?.data()).toEqual({ code: 'itema', rank: 30 });

    const droppedConvSnap = await typedCol.select('code').get();
    expect(droppedConvSnap.docs[0]?.data()).toEqual({ code: 'ITEMA' });

    const cg = db.collectionGroup('nested');
    expect(() => cg.getPartitions(2)).toThrow(PyricDeferredApiError);
    expect(() => cg.withConverter(catalogConverter).getPartitions(2)).toThrow(
      /CollectionGroup\.getPartitions is not implemented/,
    );

    expect('onSnapshot' in col).toBe(true);
    expect('onSnapshot' in col.doc('real')).toBe(true);
    expect('onSnapshot' in baseOrdered).toBe(true);
  });
});
