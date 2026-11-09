import { afterEach, describe, expect, test } from 'bun:test';
import { deleteApp, getApps } from '../../src/app/index.js';
import { FieldPath, getFirestore, onSnapshot } from '../../src/firestore/index.js';
import { inProcessFirestoreArm, sharedWorkerFirestoreArm } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each([
  ['in-process', inProcessFirestoreArm],
  ['shared-worker remote', sharedWorkerFirestoreArm],
])('pyric-admin/firestore FieldPath in Query.where() and Query.orderBy() ($0)', (_label, makeArm) => {
  test('filters and orders nested fields and FieldPath.documentId() identically across arms', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);

    await db.doc('items/i1').set({ meta: { rank: 2, tag: 'keep' } });
    await db.doc('items/i2').set({ meta: { rank: 1, tag: 'keep' } });
    await db.doc('items/i3').set({ meta: { rank: 3, tag: 'skip' } });

    const whereSnap = await db
      .collection('items')
      .where(new FieldPath('meta', 'tag'), '==', 'keep')
      .get();
    expect(whereSnap.docs.map((d) => d.id)).toEqual(['i1', 'i2']);

    const orderSnap = await db
      .collection('items')
      .orderBy(new FieldPath('meta', 'rank'), 'asc')
      .get();
    expect(orderSnap.docs.map((d) => d.id)).toEqual(['i2', 'i1', 'i3']);

    const combinedSnap = await db
      .collection('items')
      .where(new FieldPath('meta', 'tag'), '==', 'keep')
      .orderBy(new FieldPath('meta', 'rank'), 'asc')
      .get();
    expect(combinedSnap.docs.map((d) => d.id)).toEqual(['i2', 'i1']);

    const docIdWhereSnap = await db
      .collection('items')
      .where(FieldPath.documentId(), '==', 'i2')
      .get();
    expect(docIdWhereSnap.docs.map((d) => d.id)).toEqual(['i2']);

    const docIdOrderSnap = await db
      .collection('items')
      .orderBy(FieldPath.documentId(), 'desc')
      .get();
    expect(docIdOrderSnap.docs.map((d) => d.id)).toEqual(['i3', 'i2', 'i1']);

    const streamedIds: string[][] = [];
    const unsub = onSnapshot(
      db.collection('items').where(new FieldPath('meta', 'tag'), '==', 'keep').orderBy(new FieldPath('meta', 'rank'), 'asc'),
      (snap) => {
        streamedIds.push(snap.docs.map((d) => d.id));
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    unsub();
    expect(streamedIds[0]).toEqual(['i2', 'i1']);
  });

  test('distinguishes literal-dot FieldPath segments from nested dotted string paths in where, applyFilter, orderBy, and snapshot cursors', async () => {
    const { app } = makeArm();
    const db = getFirestore(app);

    await db.doc('records/literal-1').set({
      'a.b': 20,
      a: { b: 999 },
      meta: { 'x.y': 'second', x: { y: 'nested' } },
    });
    await db.doc('records/literal-2').set({
      'a.b': 10,
      meta: { 'x.y': 'first' },
    });
    await db.doc('records/nested-only').set({
      a: { b: 20 },
      meta: { x: { y: 'second' } },
    });

    const literalWhere = await db
      .collection('records')
      .where(new FieldPath('a.b'), '==', 20)
      .get();
    expect(literalWhere.docs.map((d) => d.id)).toEqual(['literal-1']);

    const nestedStringWhere = await db
      .collection('records')
      .where('a.b', '==', 20)
      .get();
    expect(nestedStringWhere.docs.map((d) => d.id)).toEqual(['nested-only']);

    const multiSegLiteralWhere = await db
      .collection('records')
      .where(new FieldPath('meta', 'x.y'), '==', 'second')
      .get();
    expect(multiSegLiteralWhere.docs.map((d) => d.id)).toEqual(['literal-1']);

    const applyFilterSnap = await db
      .collection('records')
      .applyFilter({
        kind: 'or',
        filters: [
          { kind: 'where', field: new FieldPath('a.b'), op: '==', value: 10 },
          { kind: 'where', field: new FieldPath('meta', 'x.y'), op: '==', value: 'second' },
        ],
      })
      .orderBy(new FieldPath('a.b'), 'asc')
      .get();
    expect(applyFilterSnap.docs.map((d) => d.id)).toEqual(['literal-2', 'literal-1']);

    const pivotSnap = await db.doc('records/literal-2').get();
    const afterPivot = await db
      .collection('records')
      .orderBy(new FieldPath('a.b'), 'asc')
      .startCursorFromSnapshot(pivotSnap, false)
      .get();
    expect(afterPivot.docs.map((d) => d.id)).toEqual(['literal-1']);

    const upToPivot = await db
      .collection('records')
      .orderBy(new FieldPath('a.b'), 'asc')
      .endCursorFromSnapshot(pivotSnap, true)
      .get();
    expect(upToPivot.docs.map((d) => d.id)).toEqual(['literal-2']);
  });

  test('rejects malformed string field paths with invalid-argument in where, orderBy, and applyFilter', () => {
    const { app } = makeArm();
    const db = getFirestore(app);
    const coll = db.collection('records');

    for (const invalidPath of ['', '.a', 'a.', 'a..b', 'a*b', 'a[0]']) {
      expect(() => coll.where(invalidPath, '==', 1)).toThrow(
        expect.objectContaining({ code: 'invalid-argument' }),
      );
      expect(() => coll.orderBy(invalidPath, 'asc')).toThrow(
        expect.objectContaining({ code: 'invalid-argument' }),
      );
      expect(() =>
        coll.applyFilter({ kind: 'where', field: invalidPath, op: '==', value: 1 }),
      ).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    }
  });
});
