import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  Bytes,
  GeoPoint,
  Timestamp,
  collection as sbxCollection,
  collectionGroup as sbxCollectionGroup,
  doc as sbxDoc,
  documentId as sbxDocumentId,
  endBefore as sbxEndBefore,
  getDoc as sbxGetDoc,
  getDocs as sbxGetDocs,
  getFirestore as sbxGetFirestore,
  limit as sbxLimit,
  limitToLast as sbxLimitToLast,
  orderBy as sbxOrderBy,
  query as sbxQuery,
  setDoc as sbxSetDoc,
  startAt as sbxStartAt,
  vector,
  where as sbxWhere,
} from 'pyric/firestore';
import { setRules } from 'pyric/sandbox/firestore';
import { connectClientToHost, makeHostCtx } from './integration-support.js';
import * as wc from '../../../src/serve/worker/client.js';

const OPEN_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if true;',
  '    }',
  '  }',
  '}',
].join('\n');

function captureSyncErrorCode(fn: () => unknown): string {
  try {
    fn();
    return 'did-not-throw';
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string') {
      return code;
    }
    return String((err as Error)?.name ?? 'thrown');
  }
}

describe('served worker client synchronous query constraint parity', () => {
  test('rejects non-array operands for in, not-in, and array-contains-any synchronously at query()', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const sbxDb = sbxGetFirestore(sandbox);

    const ctx = await makeHostCtx();
    setRules(ctx.sandbox, OPEN_RULES);
    const { db: workerDb } = connectClientToHost(ctx, 'worker://query-sync-parity-1');

    try {
      for (const badOp of ['in', 'not-in', 'array-contains-any'] as const) {
        const sbxCode = captureSyncErrorCode(() =>
          sbxQuery(
            sbxCollectionGroup(sbxDb, 'items'),
            sbxWhere(sbxDocumentId(), badOp, 'rooms/r1/items/i1' as unknown as unknown[]),
          ),
        );
        const workerCode = captureSyncErrorCode(() =>
          wc.query(
            wc.collectionGroup(workerDb, 'items'),
            wc.where(sbxDocumentId(), badOp, 'rooms/r1/items/i1'),
          ),
        );
        expect(sbxCode).toBe('invalid-argument');
        expect(workerCode).toBe(sbxCode);
      }
    } finally {
      ctx.sandbox.dispose();
      sandbox.dispose();
    }
  });

  test('rejects snapshot cursors missing an explicit orderBy field on onSnapshot and getDocs without coercing undefined to null', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const sbxDb = sbxGetFirestore(sandbox);

    const ctx = await makeHostCtx();
    setRules(ctx.sandbox, OPEN_RULES);
    const { db: workerDb } = connectClientToHost(ctx, 'worker://query-sync-parity-2');

    try {
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i1'), { meta: { count: null } });
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i3'), { flag: true, label: 'only-top' });
      const sbxSnap = await sbxGetDoc(sbxDoc(sbxDb, 'items/i3'));

      await wc.setDoc(wc.doc(workerDb, 'items/i1'), { meta: { count: null } });
      await wc.setDoc(wc.doc(workerDb, 'items/i3'), { flag: true, label: 'only-top' });
      const workerSnap = await wc.getDoc(wc.doc(workerDb, 'items/i3'));

      const sbxCode = captureSyncErrorCode(() =>
        sbxQuery(
          sbxCollection(sbxDb, 'items'),
          sbxOrderBy('meta.count', 'desc'),
          sbxEndBefore(sbxSnap),
        ),
      );
      const workerListenCode = captureSyncErrorCode(() => {
        const built = wc.query(
          wc.collection(workerDb, 'items'),
          wc.orderBy('meta.count', 'desc'),
          wc.endBefore(workerSnap),
        );
        wc.onSnapshot(built, () => {});
      });
      expect(sbxCode).toBe('invalid-argument');
      expect(workerListenCode).toBe(sbxCode);

      let workerReadCode = 'did-not-throw';
      try {
        await wc.getDocs(
          wc.query(
            wc.collection(workerDb, 'items'),
            wc.orderBy('meta.count', 'desc'),
            wc.endBefore(workerSnap),
          ),
        );
      } catch (err) {
        workerReadCode = String((err as { code?: unknown })?.code ?? 'thrown');
      }
      expect(workerReadCode).toBe('invalid-argument');
    } finally {
      ctx.sandbox.dispose();
      sandbox.dispose();
    }
  });

  test('rejects invalid orderBy direction, non-finite limits, undefined operands, and non-string documentId cursors synchronously', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const sbxDb = sbxGetFirestore(sandbox);

    const ctx = await makeHostCtx();
    setRules(ctx.sandbox, OPEN_RULES);
    const { db: workerDb } = connectClientToHost(ctx, 'worker://query-sync-parity-3');

    try {
      expect(
        captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.orderBy('n', 'sideways' as 'asc')),
        ),
      ).toBe(
        captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxOrderBy('n', 'sideways' as 'asc')),
        ),
      );

      expect(
        captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.limit(Number.NaN)),
        ),
      ).toBe(
        captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxLimit(Number.NaN)),
        ),
      );

      expect(
        captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.limitToLast(Number.POSITIVE_INFINITY)),
        ),
      ).toBe(
        captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxLimitToLast(Number.POSITIVE_INFINITY)),
        ),
      );

      expect(
        captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.where('n', '==', undefined)),
        ),
      ).toBe(
        captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxWhere('n', '==', undefined)),
        ),
      );

      expect(
        captureSyncErrorCode(() =>
          wc.query(
            wc.collection(workerDb, 'items'),
            wc.orderBy(sbxDocumentId(), 'asc'),
            wc.startAt(123),
          ),
        ),
      ).toBe(
        captureSyncErrorCode(() =>
          sbxQuery(
            sbxCollection(sbxDb, 'items'),
            sbxOrderBy(sbxDocumentId(), 'asc'),
            sbxStartAt(123),
          ),
        ),
      );
    } finally {
      ctx.sandbox.dispose();
      sandbox.dispose();
    }
  });

  test('matches operator-specific nested-array validation including array-valued in and not-in candidates', async () => {
    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const sbxDb = sbxGetFirestore(sandbox);

    const ctx = await makeHostCtx();
    setRules(ctx.sandbox, OPEN_RULES);
    const { db: workerDb } = connectClientToHost(ctx, 'worker://query-sync-parity-4');

    try {
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i1'), { tags: ['a', 'b'] });
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i2'), { tags: ['a'] });
      await sbxSetDoc(sbxDoc(sbxDb, 'items/i3'), { tags: ['c'] });

      await wc.setDoc(wc.doc(workerDb, 'items/i1'), { tags: ['a', 'b'] });
      await wc.setDoc(wc.doc(workerDb, 'items/i2'), { tags: ['a'] });
      await wc.setDoc(wc.doc(workerDb, 'items/i3'), { tags: ['c'] });

      const cases: ReadonlyArray<readonly [Parameters<typeof sbxWhere>[1], unknown]> = [
        ['in', [['a', 'b'], ['c']]],
        ['not-in', [['a'], []]],
        ['in', [[['a']]]],
        ['==', [['a']]],
        ['==', { nested: [['a']] }],
        ['==', [{ nested: ['a'] }]],
        ['array-contains', [['a']]],
        ['array-contains-any', [['a']]],
      ];

      for (const [op, operand] of cases) {
        const sbxCode = captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxWhere('tags', op, operand)),
        );
        const workerCode = captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.where('tags', op, operand)),
        );
        expect(workerCode).toBe(sbxCode);
      }

      const sbxInSnap = await sbxGetDocs(
        sbxQuery(sbxCollection(sbxDb, 'items'), sbxWhere('tags', 'in', [['a', 'b'], ['c']])),
      );
      const workerInSnap = await wc.getDocs(
        wc.query(wc.collection(workerDb, 'items'), wc.where('tags', 'in', [['a', 'b'], ['c']])),
      );
      expect(workerInSnap.docs.map((d) => d.id)).toEqual(sbxInSnap.docs.map((d) => d.id));
      expect(workerInSnap.docs.map((d) => d.id)).toEqual(['i1', 'i3']);

      const sbxNotInSnap = await sbxGetDocs(
        sbxQuery(sbxCollection(sbxDb, 'items'), sbxWhere('tags', 'not-in', [['a'], []])),
      );
      const workerNotInSnap = await wc.getDocs(
        wc.query(wc.collection(workerDb, 'items'), wc.where('tags', 'not-in', [['a'], []])),
      );
      expect(workerNotInSnap.docs.map((d) => d.id)).toEqual(sbxNotInSnap.docs.map((d) => d.id));
      expect(workerNotInSnap.docs.map((d) => d.id)).toEqual(['i1', 'i3']);
    } finally {
      ctx.sandbox.dispose();
      sandbox.dispose();
    }
  });

  test('rejects non-plain custom class operands synchronously while allowing Firestore value wrappers', async () => {
    class CustomOperand {
      readonly label = 'custom';
    }

    const sandbox = initializeSandbox();
    setRules(sandbox, OPEN_RULES);
    const sbxDb = sbxGetFirestore(sandbox);

    const ctx = await makeHostCtx();
    setRules(ctx.sandbox, OPEN_RULES);
    const { db: workerDb } = connectClientToHost(ctx, 'worker://query-sync-parity-5');

    try {
      const invalidOperands: readonly unknown[] = [
        new CustomOperand(),
        { nested: new CustomOperand() },
        new Map([['a', 1]]),
        new Set(['a']),
        /pattern/,
        new Date('invalid'),
      ];

      for (const bad of invalidOperands) {
        const sbxWhereCode = captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxWhere('v', '==', bad)),
        );
        const workerWhereCode = captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.where('v', '==', bad)),
        );
        expect(sbxWhereCode).toBe('invalid-argument');
        expect(workerWhereCode).toBe(sbxWhereCode);

        const sbxCursorCode = captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxOrderBy('v'), sbxStartAt(bad)),
        );
        const workerCursorCode = captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.orderBy('v'), wc.startAt(bad)),
        );
        expect(sbxCursorCode).toBe('invalid-argument');
        expect(workerCursorCode).toBe(sbxCursorCode);
      }

      const nullProtoMap = Object.assign(Object.create(null) as Record<string, unknown>, { flag: true });
      const validPairs: ReadonlyArray<readonly [unknown, unknown]> = [
        [Bytes.fromUint8Array(new Uint8Array([1, 2])), Bytes.fromUint8Array(new Uint8Array([1, 2]))],
        [new Uint8Array([3, 4]), new Uint8Array([3, 4])],
        [new GeoPoint(10, 20), new GeoPoint(10, 20)],
        [Timestamp.fromMillis(1_700_000_000_000), Timestamp.fromMillis(1_700_000_000_000)],
        [new Date(1_700_000_000_000), new Date(1_700_000_000_000)],
        [sbxDoc(sbxDb, 'items/i1'), wc.doc(workerDb, 'items/i1')],
        [vector([1, 2]), vector([1, 2])],
        [nullProtoMap, nullProtoMap],
      ];

      for (const [sbxVal, workerVal] of validPairs) {
        const sbxCode = captureSyncErrorCode(() =>
          sbxQuery(sbxCollection(sbxDb, 'items'), sbxWhere('v', '==', sbxVal)),
        );
        const workerCode = captureSyncErrorCode(() =>
          wc.query(wc.collection(workerDb, 'items'), wc.where('v', '==', workerVal)),
        );
        expect(sbxCode).toBe('did-not-throw');
        expect(workerCode).toBe(sbxCode);
      }
    } finally {
      ctx.sandbox.dispose();
      sandbox.dispose();
    }
  });
});
