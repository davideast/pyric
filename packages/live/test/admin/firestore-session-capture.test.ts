/**
 * Unit tests for `admin/firestore-session-capture.ts`: context, result, and
 * listener delivery session capture across `@google-cloud/firestore` document
 * and query reads, writes, `getAll`, and custom converters.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import {
  adminFirestoreDelivery,
  adminFirestoreResult,
  adminFirestoreSessionContext,
} from '../../src/admin/firestore-session-capture.js';

interface AdminFirestorePkg {
  Firestore: new (settings: { projectId: string }) => {
    doc(path: string): DocRefLike;
    collection(path: string): CollectionRefLike;
    terminate(): Promise<void>;
  };
  FieldPath: new (...segments: string[]) => unknown;
  FieldValue: {
    delete(): unknown;
  };
}

interface DocRefLike {
  path: string;
  id: string;
  withConverter(converter: unknown): DocRefLike;
}

interface QueryLike {
  where(field: string, op: string, value: unknown): QueryLike;
  select(...fields: string[]): QueryLike;
  withConverter(converter: unknown): QueryLike;
}

interface CollectionRefLike extends QueryLike {
  path: string;
}

const fromAdmin = createRequire(createRequire(import.meta.url).resolve('firebase-admin/firestore'));
const sdk = fromAdmin('@google-cloud/firestore') as AdminFirestorePkg;

function makeDocSnap(path: string, data: Record<string, unknown> | undefined, converter?: unknown) {
  const parts = path.split('/');
  const ref: Record<string, unknown> = {
    path,
    id: parts[parts.length - 1] ?? '',
  };
  if (converter !== undefined) ref['_converter'] = converter;
  return {
    exists: data !== undefined,
    ref,
    data: () => data,
  };
}

type FakeSite = Parameters<typeof adminFirestoreResult>[0];
type SessionCtx = ReturnType<typeof adminFirestoreSessionContext>;

function makeFakeSite(
  name: string,
  ctx: Partial<SessionCtx> & { subject?: unknown; path?: string },
): FakeSite {
  return {
    module: '@google-cloud/firestore',
    name,
    sdk: 'admin' as const,
    observer: () => undefined,
    ...ctx,
  };
}

describe('admin/firestore-session-capture', () => {
  test('skips converted Admin refs, queries, and snapshots as unsupported without invoking user converters', async () => {
    const db = new sdk.Firestore({ projectId: 'demo-converters' });
    let converterCalled = false;
    const customConverter = {
      toFirestore() {
        converterCalled = true;
        return {};
      },
      fromFirestore() {
        converterCalled = true;
        return {};
      },
    };
    try {
      const plainDoc = db.doc('items/one');
      const convertedDoc = plainDoc.withConverter(customConverter);
      const resetDoc = convertedDoc.withConverter(null);
      const convertedCol = db.collection('items').withConverter(customConverter);
      const convertedQuery = db.collection('items').where('n', '>', 0).withConverter(customConverter);

      expect(adminFirestoreSessionContext('DocumentReference.set', [{ a: 1 }], plainDoc, 'items/one').sessionData).toEqual({
        firestore: [{ kind: 'set', path: 'items/one', data: { a: 1 } }],
      });
      expect(adminFirestoreSessionContext('DocumentReference.set', [{ a: 1 }], convertedDoc, 'items/one').sessionData).toEqual({
        skipped: { unsupported: 1 },
      });
      expect(adminFirestoreSessionContext('DocumentReference.set', [{ a: 1 }], resetDoc, 'items/one').sessionData).toEqual({
        firestore: [{ kind: 'set', path: 'items/one', data: { a: 1 } }],
      });
      expect(adminFirestoreSessionContext('CollectionReference.add', [{ a: 1 }], convertedCol, 'items').sessionData).toEqual({
        skipped: { unsupported: 1 },
      });
      expect(adminFirestoreResult(makeFakeSite('Query.get', { subject: convertedQuery, path: 'items' }), { size: 1, docs: [] })).toEqual({
        billedDocuments: 1,
        sessionData: { skipped: { unsupported: 1 } },
      });
      expect(converterCalled).toBe(false);
    } finally {
      await db.terminate();
    }
  });

  test('captures DocumentReference create, set, update, delete, get, and CollectionReference.add', () => {
    const createCtx = adminFirestoreSessionContext('DocumentReference.create', [{ title: 'created' }], {}, 'items/a');
    expect(createCtx.sessionData).toEqual({
      firestore: [{ kind: 'set', path: 'items/a', data: { title: 'created' } }],
    });

    const mergeCtx = adminFirestoreSessionContext(
      'DocumentReference.set',
      [{ keep: 1, stale: sdk.FieldValue.delete() }, { merge: true }],
      {},
      'items/a',
    );
    expect(mergeCtx.sessionData).toEqual({
      firestore: [{ kind: 'set', path: 'items/a', data: { keep: 1 }, merge: true, deleteFields: ['stale'] }],
    });

    const updateCtx = adminFirestoreSessionContext(
      'DocumentReference.update',
      [new sdk.FieldPath('meta', 'rank'), 2, 'old', sdk.FieldValue.delete(), { exists: true }],
      {},
      'items/a',
    );
    expect(updateCtx.sessionData).toEqual({
      firestore: [{ kind: 'update', path: 'items/a', data: { 'meta.rank': 2 }, deleteFields: ['old'] }],
    });

    const deleteCtx = adminFirestoreSessionContext('DocumentReference.delete', [{ exists: true }], {}, 'items/a');
    expect(deleteCtx.sessionData).toEqual({
      firestore: [{ kind: 'delete', path: 'items/a' }],
    });

    const addCtx = adminFirestoreSessionContext('CollectionReference.add', [{ title: 'auto' }], {}, 'items');
    const addRes = adminFirestoreResult(makeFakeSite('CollectionReference.add', addCtx), { path: 'items/generated-1' });
    expect(addRes).toEqual({
      sessionData: {
        firestore: [{ kind: 'set', path: 'items/generated-1', data: { title: 'auto' } }],
      },
    });

    const getExisting = adminFirestoreResult(
      makeFakeSite('DocumentReference.get', { path: 'items/a' }),
      makeDocSnap('items/a', { n: 10 }),
    );
    expect(getExisting).toEqual({
      sessionData: { firestore: [{ kind: 'set', path: 'items/a', data: { n: 10 } }] },
    });

    const getMissing = adminFirestoreResult(
      makeFakeSite('DocumentReference.get', { path: 'items/missing' }),
      makeDocSnap('items/missing', undefined),
    );
    expect(getMissing).toEqual({
      sessionData: { firestore: [{ kind: 'delete', path: 'items/missing' }] },
    });
  });

  test('captures Query.get with billedDocuments and 250-doc truncation, and Query.onSnapshot via docChanges()', () => {
    const docs = Array.from({ length: 252 }, (_, idx) => makeDocSnap(`items/doc-${idx}`, { idx }));
    const queryRes = adminFirestoreResult(makeFakeSite('Query.get', { path: 'items' }), {
      size: docs.length,
      docs,
    });
    if (typeof queryRes === 'symbol') throw new Error('expected ResultReading');
    expect(queryRes.billedDocuments).toBe(252);
    expect(queryRes.sessionData?.firestore).toHaveLength(250);
    expect(queryRes.sessionData?.skipped).toEqual({ truncated: 2 });

    const heavyPayload = 'x'.repeat(200 * 1024);
    const heavyDocs = Array.from({ length: 4 }, (_, idx) => makeDocSnap(`items/heavy-${idx}`, { body: heavyPayload }));
    const heavyRes = adminFirestoreResult(makeFakeSite('Query.get', { path: 'items' }), {
      size: heavyDocs.length,
      docs: heavyDocs,
    });
    if (typeof heavyRes === 'symbol') throw new Error('expected ResultReading');
    expect(heavyRes.sessionData?.firestore).toHaveLength(2);
    expect(heavyRes.sessionData?.skipped).toEqual({ truncated: 2 });

    const delivery = adminFirestoreDelivery(makeFakeSite('Query.onSnapshot', { path: 'items' }), {
      docs: [makeDocSnap('items/a', { v: 1 })],
      docChanges: () => [
        { type: 'added', doc: makeDocSnap('items/a', { v: 1 }) },
        { type: 'modified', doc: makeDocSnap('items/b', { v: 2 }) },
        { type: 'removed', doc: makeDocSnap('items/c', { v: 3 }) },
      ],
    });
    expect(delivery).toEqual({
      firestore: [
        { kind: 'set', path: 'items/a', data: { v: 1 } },
        { kind: 'set', path: 'items/b', data: { v: 2 } },
        { kind: 'invalidate', path: 'items/c' },
      ],
    });

    const docDeliveryMissing = adminFirestoreDelivery(
      makeFakeSite('DocumentReference.onSnapshot', { path: 'items/gone' }),
      makeDocSnap('items/gone', undefined),
    );
    expect(docDeliveryMissing).toEqual({
      firestore: [{ kind: 'delete', path: 'items/gone' }],
    });
  });

  test('captures Firestore.getAll existing/missing docs and marks ReadOptions.fieldMask as unsupported', () => {
    const refA = { path: 'items/a' };
    const refMissing = { path: 'items/missing' };
    const getAllCtx = adminFirestoreSessionContext('Firestore.getAll', [refA, refMissing], {}, undefined);
    const getAllRes = adminFirestoreResult(makeFakeSite('Firestore.getAll', getAllCtx), [
      makeDocSnap('items/a', { ok: true }),
      makeDocSnap('items/missing', undefined),
    ]);
    expect(getAllRes).toEqual({
      sessionData: {
        firestore: [
          { kind: 'set', path: 'items/a', data: { ok: true } },
          { kind: 'delete', path: 'items/missing' },
        ],
      },
    });

    const maskedCtx = adminFirestoreSessionContext('Firestore.getAll', [refA, refMissing, { fieldMask: ['ok'] }], {}, undefined);
    expect(
      adminFirestoreResult(makeFakeSite('Firestore.getAll', maskedCtx), [
        makeDocSnap('items/a', { ok: true }),
        makeDocSnap('items/missing', undefined),
      ]),
    ).toEqual({
      sessionData: {
        firestore: [
          { kind: 'projection', path: 'items/a', fields: ['ok'], data: { ok: true } },
          { kind: 'delete', path: 'items/missing' },
        ],
        skipped: { unsupported: 1 },
      },
    });

    const emptyMaskCtx = adminFirestoreSessionContext('Firestore.getAll', [refA, { fieldMask: [] }], {}, undefined);
    expect(adminFirestoreResult(makeFakeSite('Firestore.getAll', emptyMaskCtx), [makeDocSnap('items/a', {})])).toEqual({
      sessionData: {
        firestore: [{ kind: 'projection', path: 'items/a', fields: [], data: {} }],
        skipped: { unsupported: 1 },
      },
    });

    // Literal-dot FieldPath segment in `fieldMask` cannot be represented as a dotted string -> invalidates returned doc fail-closed.
    const dotSegmentMaskCtx = adminFirestoreSessionContext(
      'Firestore.getAll',
      [refA, { fieldMask: [new sdk.FieldPath('a.b', 'c')] }],
      {},
      undefined,
    );
    expect(
      adminFirestoreResult(makeFakeSite('Firestore.getAll', dotSegmentMaskCtx), [makeDocSnap('items/a', { 'a.b': { c: 1 } })]),
    ).toEqual({
      sessionData: {
        firestore: [{ kind: 'invalidate', path: 'items/a' }],
        skipped: { unsupported: 1 },
      },
    });
  });

  test('reconciles Query.select() projections on Query.get and Query.onSnapshot without overwriting whole documents, purging docs whose server value changed (#3283)', async () => {
    const db = new sdk.Firestore({ projectId: 'demo-select-projection' });
    try {
      const projectedQuery = db.collection('items').select('title');
      const emptyProjectedQuery = db.collection('items').select();
      const dotSegmentQuery = db.collection('items').select(new sdk.FieldPath('a.b', 'c') as unknown as string);
      const partialSnap = {
        size: 2,
        query: projectedQuery,
        docs: [
          makeDocSnap('items/unchanged', { title: 'Original' }),
          makeDocSnap('items/changed', { title: 'Updated on server' }),
        ],
        docChanges: () => [
          { type: 'added', doc: makeDocSnap('items/unchanged', { title: 'Original' }) },
          { type: 'modified', doc: makeDocSnap('items/changed', { title: 'Updated on server' }) },
          { type: 'removed', doc: makeDocSnap('items/left-window', { title: 'Gone' }) },
        ],
      };

      expect(
        adminFirestoreResult(makeFakeSite('Query.get', { subject: projectedQuery, path: 'items' }), partialSnap),
      ).toEqual({
        billedDocuments: 2,
        sessionData: {
          firestore: [
            { kind: 'projection', path: 'items/unchanged', fields: ['title'], data: { title: 'Original' } },
            { kind: 'projection', path: 'items/changed', fields: ['title'], data: { title: 'Updated on server' } },
          ],
          skipped: { unsupported: 1 },
        },
      });

      expect(
        adminFirestoreResult(makeFakeSite('Query.get', { subject: emptyProjectedQuery, path: 'items' }), {
          size: 1,
          query: emptyProjectedQuery,
          docs: [makeDocSnap('items/a', {})],
        }),
      ).toEqual({
        billedDocuments: 1,
        sessionData: {
          firestore: [{ kind: 'projection', path: 'items/a', fields: [], data: {} }],
          skipped: { unsupported: 1 },
        },
      });

      expect(
        adminFirestoreResult(makeFakeSite('Query.get', { subject: dotSegmentQuery, path: 'items' }), {
          size: 1,
          query: dotSegmentQuery,
          docs: [makeDocSnap('items/a', { 'a.b': { c: 1 } })],
        }),
      ).toEqual({
        billedDocuments: 1,
        sessionData: {
          firestore: [{ kind: 'invalidate', path: 'items/a' }],
          skipped: { unsupported: 1 },
        },
      });

      expect(
        adminFirestoreDelivery(makeFakeSite('Query.onSnapshot', { subject: projectedQuery, path: 'items' }), partialSnap),
      ).toEqual({
        firestore: [
          { kind: 'projection', path: 'items/unchanged', fields: ['title'], data: { title: 'Original' } },
          { kind: 'projection', path: 'items/changed', fields: ['title'], data: { title: 'Updated on server' } },
          { kind: 'invalidate', path: 'items/left-window' },
        ],
        skipped: { unsupported: 1 },
      });

      expect(
        adminFirestoreDelivery(makeFakeSite('Query.onSnapshot', { path: 'items' }), partialSnap),
      ).toEqual({
        firestore: [
          { kind: 'projection', path: 'items/unchanged', fields: ['title'], data: { title: 'Original' } },
          { kind: 'projection', path: 'items/changed', fields: ['title'], data: { title: 'Updated on server' } },
          { kind: 'invalidate', path: 'items/left-window' },
        ],
        skipped: { unsupported: 1 },
      });

      // Empty projected result (`docs: []`) records `unsupported: 1` with zero `truncated` so unrelated cached docs stay intact.
      expect(
        adminFirestoreResult(makeFakeSite('Query.get', { subject: projectedQuery, path: 'items' }), {
          size: 0,
          query: projectedQuery,
          docs: [],
        }),
      ).toEqual({
        billedDocuments: 1,
        sessionData: { skipped: { unsupported: 1 } },
      });

      // > 250 returned docs on a projected `Query.select()` emits 250 `projection` ops AND `truncated: 2` so doc #251+ triggers collection fallback.
      const overCapDocs = Array.from({ length: 252 }, (_, idx) => makeDocSnap(`items/d-${idx}`, { title: `T${idx}` }));
      const overCapResult = adminFirestoreResult(makeFakeSite('Query.get', { subject: projectedQuery, path: 'items' }), {
        size: overCapDocs.length,
        query: projectedQuery,
        docs: overCapDocs,
      });
      expect(overCapResult.sessionData?.firestore).toHaveLength(250);
      expect(overCapResult.sessionData?.skipped).toEqual({ unsupported: 1, truncated: 2 });

      // Unenumerable snapshot containers (`docs` non-array, non-array `getAll` snapshots, or pathless doc item) record `truncated: 1`.
      expect(
        adminFirestoreResult(makeFakeSite('Query.get', { subject: projectedQuery, path: 'items' }), {
          size: 1,
          query: projectedQuery,
          docs: null,
        }).sessionData,
      ).toEqual({ skipped: { unsupported: 1, truncated: 1 } });

      expect(
        adminFirestoreResult(makeFakeSite('Query.get', { subject: projectedQuery, path: 'items' }), {
          size: 1,
          query: projectedQuery,
          docs: [{ exists: true, data: () => ({ title: 'No ref path' }) }],
        }).sessionData,
      ).toEqual({ skipped: { unsupported: 1, truncated: 1 } });

      const maskedGetAllCtx = adminFirestoreSessionContext(
        'Firestore.getAll',
        [db.doc('items/a'), { fieldMask: ['title'] }],
        {},
        undefined,
      );
      expect(adminFirestoreResult(makeFakeSite('Firestore.getAll', maskedGetAllCtx), 'not-an-array').sessionData).toEqual({
        skipped: { unsupported: 1, truncated: 1 },
      });
    } finally {
      await db.terminate();
    }
  });
});
