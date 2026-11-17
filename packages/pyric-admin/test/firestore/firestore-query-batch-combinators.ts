/**
 * Generative argument combinators for Admin Firestore `Query` constraints
 * (`where`, `orderBy`, `limit`, `limitToLast`) and `WriteBatch` / `runTransaction`.
 */

import {
  emitTypeWrongnessCandidates,
  makeCandidate,
  type CandidateValue,
} from '../argument-generator/argument-combinators.js';
import type {
  FirestoreDialectRuntime,
  FirestoreDifferentialCase,
} from './firestore-combinators.js';

class CustomQueryBox {
  readonly kind = 'custom';
}

const VALID_WHERE_OPS = [
  '<',
  '<=',
  '==',
  '!=',
  '>=',
  '>',
  '=',
  'in',
  'not-in',
  'array-contains',
  'array-contains-any',
] as const;

export function emitQueryConstraintCases(): FirestoreDifferentialCase[] {
  const cases: FirestoreDifferentialCase[] = [];

  // 1. where(field, ...) field-path validation
  const fieldCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('a..b', () => 'a..b'),
    makeCandidate('.a', () => '.a'),
    makeCandidate('a*b', () => 'a*b'),
    makeCandidate('count', () => 'count'),
  ];
  for (const fieldCand of fieldCandidates) {
    cases.push({
      label: `where(field=${fieldCand.label}, "==", 1)`,
      invoke: (rt) => rt.db.collection('items').where(fieldCand.build(), '==', 1).get(),
    });
  }

  // 2. where(..., op, 1) invalid operator candidates
  const invalidOpCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('===', () => '==='),
    makeCandidate('<>', () => '<>'),
    makeCandidate('LIKE', () => 'LIKE'),
  ];
  for (const opCand of invalidOpCandidates) {
    cases.push({
      label: `where("count", op=${opCand.label}, 1)`,
      invoke: (rt) => rt.db.collection('items').where('count', opCand.build(), 1).get(),
    });
  }

  // 3. Operator x Operand Cartesian matrix
  const operandShapes: Array<{ label: string; build: (rt: FirestoreDialectRuntime) => unknown }> = [
    { label: 'num-1', build: () => 1 },
    { label: 'str', build: () => 'Seeded' },
    { label: 'null', build: () => null },
    { label: 'NaN', build: () => Number.NaN },
    { label: 'undefined', build: () => undefined },
    { label: 'empty-array', build: () => [] },
    { label: 'arr-1', build: () => [1] },
    { label: 'nested-arr-2', build: () => [[1]] },
    { label: 'nested-arr-3', build: () => [[[1]]] },
    { label: 'arr-len-10', build: () => Array.from({ length: 10 }, (_, idx) => idx) },
    { label: 'arr-len-11', build: () => Array.from({ length: 11 }, (_, idx) => idx) },
    { label: 'arr-len-30', build: () => Array.from({ length: 30 }, (_, idx) => idx) },
    { label: 'arr-len-31', build: () => Array.from({ length: 31 }, (_, idx) => idx) },
    { label: 'arr-with-null', build: () => [null] },
    { label: 'arr-with-NaN', build: () => [Number.NaN] },
    { label: 'arr-with-undefined', build: () => [undefined] },
    { label: 'FieldValue.delete', build: (rt) => rt.FieldValue.delete() },
    { label: 'FieldValue.serverTimestamp', build: (rt) => rt.FieldValue.serverTimestamp() },
    { label: 'FieldValue.increment', build: (rt) => rt.FieldValue.increment(1) },
    { label: 'FieldPath', build: (rt) => new rt.FieldPath('count') },
    { label: 'CustomBox', build: () => new CustomQueryBox() },
    { label: 'invalid-Date', build: () => new Date(Number.NaN) },
    { label: 'valid-Date', build: () => new Date(0) },
    { label: 'bigint-1n', build: () => 1n },
    { label: 'empty-key-map', build: () => ({ '': 1 }) },
    { label: 'user-map-__type-serverTimestamp', build: () => ({ __type: 'serverTimestamp' }) },
    { label: 'user-map-__type-deleteField', build: () => ({ __type: 'deleteField' }) },
    { label: 'user-map-__type-increment', build: () => ({ __type: 'increment', value: 'v1' }) },
  ];

  for (const op of VALID_WHERE_OPS) {
    for (const operand of operandShapes) {
      cases.push({
        label: `where("count", "${op}", ${operand.label})`,
        invoke: (rt) => rt.db.collection('items').where('count', op, operand.build(rt)).get(),
      });
    }
  }

  // 4. FieldPath.documentId() & "__name__" on collection vs collectionGroup
  const docIdOps = [
    '==',
    '=',
    '!=',
    '<',
    'in',
    'not-in',
    'array-contains',
    'array-contains-any',
  ] as const;
  const docIdOperands: Array<{ label: string; build: (rt: FirestoreDialectRuntime) => unknown }> = [
    { label: '"d1"', build: () => 'd1' },
    { label: '"items/d1"', build: () => 'items/d1' },
    { label: '"items/d1/sub"', build: () => 'items/d1/sub' },
    { label: '"items/d1/sub/d2"', build: () => 'items/d1/sub/d2' },
    { label: '""', build: () => '' },
    { label: '"items//d1"', build: () => 'items//d1' },
    { label: '123', build: () => 123 },
    { label: 'null', build: () => null },
    { label: '[]', build: () => [] },
    { label: '["d1"]', build: () => ['d1'] },
    { label: '["items/d1"]', build: () => ['items/d1'] },
    { label: '["d1", 123]', build: () => ['d1', 123] },
    { label: 'doc("items/d1")', build: (rt) => rt.db.doc('items/d1') },
    { label: 'doc("other/d1")', build: (rt) => rt.db.doc('other/d1') },
    { label: 'doc("items/d1/sub/d2")', build: (rt) => rt.db.doc('items/d1/sub/d2') },
  ];

  for (const op of docIdOps) {
    for (const operand of docIdOperands) {
      cases.push({
        label: `col.where(documentId(), "${op}", ${operand.label})`,
        invoke: (rt) =>
          rt.db.collection('items').where(rt.documentId(), op, operand.build(rt)).get(),
      });
      cases.push({
        label: `colGroup.where(documentId(), "${op}", ${operand.label})`,
        invoke: (rt) =>
          rt.db.collectionGroup('items').where(rt.documentId(), op, operand.build(rt)).get(),
      });
    }
  }

  cases.push({
    label: 'col.where("__name__", "==", "a/b")',
    invoke: (rt) => rt.db.collection('items').where('__name__', '==', 'a/b').get(),
  });

  // 5. orderBy(field, direction)
  for (const fieldCand of fieldCandidates) {
    cases.push({
      label: `orderBy(field=${fieldCand.label})`,
      invoke: (rt) => rt.db.collection('items').orderBy(fieldCand.build()).get(),
    });
  }
  const directionCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('asc', () => 'asc'),
    makeCandidate('desc', () => 'desc'),
    makeCandidate('ASC', () => 'ASC'),
    makeCandidate('DESC', () => 'DESC'),
    makeCandidate('Asc', () => 'Asc'),
    makeCandidate('dEsC', () => 'dEsC'),
    makeCandidate('ascending', () => 'ascending'),
  ];
  for (const dirCand of directionCandidates) {
    cases.push({
      label: `orderBy("count", dir=${dirCand.label})`,
      invoke: (rt) => {
        if (dirCand.label === 'undefined') {
          return rt.db.collection('items').orderBy('count').get();
        }
        return rt.db.collection('items').orderBy('count', dirCand.build()).get();
      },
    });
  }

  // 6. limit(n) & limitToLast(n)
  const limitCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('-5', () => -5),
    makeCandidate('-1', () => -1),
    makeCandidate('1.5', () => 1.5),
    makeCandidate('Infinity', () => Number.POSITIVE_INFINITY),
    makeCandidate('-Infinity', () => Number.NEGATIVE_INFINITY),
  ];
  for (const limCand of limitCandidates) {
    const isZero = limCand.label === '0';
    cases.push({
      label: `limit(get=${limCand.label})`,
      allowZeroLimitRejectionWhenUpstreamAccepts: isZero,
      invoke: (rt) => rt.db.collection('items').limit(limCand.build()).get(),
    });
    cases.push({
      label: `limitToLast(noOrderBy=${limCand.label})`,
      invoke: (rt) => rt.db.collection('items').limitToLast(limCand.build()).get(),
    });
    cases.push({
      label: `limitToLast(withOrderBy=${limCand.label})`,
      allowZeroLimitRejectionWhenUpstreamAccepts: isZero,
      invoke: (rt) =>
        rt.db.collection('items').orderBy('count').limitToLast(limCand.build()).get(),
    });
  }

  return cases;
}

export function emitBatchAndTransactionCases(): FirestoreDifferentialCase[] {
  const cases: FirestoreDifferentialCase[] = [];

  // 1. WriteBatch ref brand / wrong-type validation across create, set, update, delete
  const nonDocRefCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('spoof-ref-obj', () => ({ id: 'd1', path: 'items/d1' })),
  ];
  for (const refCand of nonDocRefCandidates) {
    cases.push({
      label: `batch.create(ref=${refCand.label})`,
      invoke: (rt) => rt.db.batch().create(refCand.build(), { ok: true }),
    });
    cases.push({
      label: `batch.set(ref=${refCand.label})`,
      invoke: (rt) => rt.db.batch().set(refCand.build(), { ok: true }),
    });
    cases.push({
      label: `batch.update(ref=${refCand.label})`,
      invoke: (rt) => rt.db.batch().update(refCand.build(), { ok: true }),
    });
    cases.push({
      label: `batch.delete(ref=${refCand.label})`,
      invoke: (rt) => rt.db.batch().delete(refCand.build()),
    });
  }

  cases.push(
    {
      label: 'batch.set(ref=CollectionReference)',
      invoke: (rt) => rt.db.batch().set(rt.db.collection('items'), { ok: true }),
    },
    {
      label: 'batch.update(1-arg missing data)',
      invoke: (rt) => rt.db.batch().update(rt.db.doc(rt.existingDocPath)),
    },
    {
      label: 'batch.commit(empty)',
      invoke: (rt) => rt.db.batch().commit(),
    },
    {
      label: 'batch.commit(valid set + update + delete)',
      invoke: (rt) => {
        const batch = rt.db.batch();
        batch.create(rt.db.doc(rt.nextAbsentDocPath()), { count: 1 });
        batch.set(rt.db.doc(rt.existingDocPath), { count: 2 }, { merge: true });
        batch.update(rt.db.doc(rt.existingDocPath), 'title', 'Updated');
        batch.delete(rt.db.doc('items/batch-del'));
        return batch.commit();
      },
    },
    {
      label: 'batch.set after commit()',
      invoke: async (rt) => {
        const batch = rt.db.batch();
        await batch.commit();
        batch.set(rt.db.doc(rt.existingDocPath), { count: 3 });
      },
    },
    {
      label: 'batch.commit() twice',
      invoke: async (rt) => {
        const batch = rt.db.batch();
        await batch.commit();
        return batch.commit();
      },
    },
    {
      label: 'batch.set({mergeFields:["title","title"]} exact-dup)',
      invoke: (rt) => {
        const batch = rt.db.batch();
        batch.set(rt.db.doc(rt.existingDocPath), { title: 'b' }, { mergeFields: ['title', 'title'] });
        return batch.commit();
      },
    },
    {
      label: 'batch.set({mergeFields:["nested","nested.flag"]} ancestor-descendant)',
      invoke: (rt) => {
        const batch = rt.db.batch();
        batch.set(
          rt.db.doc(rt.existingDocPath),
          { nested: { flag: true } },
          { mergeFields: ['nested', 'nested.flag'] },
        );
        return batch.commit();
      },
    },
  );

  // batch.set strict SetOptions (only undefined is omitted; null/false/0/"" throw!)
  for (const optCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `batch.set(options=${optCand.label})`,
      invoke: (rt) => {
        const batch = rt.db.batch();
        if (optCand.label === 'undefined') {
          batch.set(rt.db.doc(rt.existingDocPath), { title: 'b' });
        } else {
          batch.set(rt.db.doc(rt.existingDocPath), { title: 'b' }, optCand.build());
        }
        return batch.commit();
      },
    });
  }

  // batch.delete precondition shapes
  for (const preCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `batch.delete(precondition=${preCand.label})`,
      invoke: (rt) => {
        const batch = rt.db.batch();
        if (preCand.label === 'undefined') {
          batch.delete(rt.db.doc('items/bdel-0'));
        } else {
          batch.delete(rt.db.doc('items/bdel-1'), preCand.build());
        }
        return batch.commit();
      },
    });
  }

  // 2. runTransaction updateFunction & transactionOptions validation
  for (const fnCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `runTransaction(fn=${fnCand.label})`,
      invoke: (rt) => rt.db.runTransaction(fnCand.build()),
    });
  }

  cases.push(
    {
      label: 'runTransaction(sync non-Promise return)',
      invoke: (rt) => rt.db.runTransaction(() => 42),
    },
    {
      label: 'runTransaction(sync undefined return)',
      invoke: (rt) => rt.db.runTransaction(() => undefined),
    },
    {
      label: 'runTransaction(async valid return)',
      invoke: (rt) => rt.db.runTransaction(async () => 42),
    },
  );

  for (const optCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `runTransaction(opts=${optCand.label})`,
      invoke: (rt) => {
        if (optCand.label === 'undefined') {
          return rt.db.runTransaction(async () => 1);
        }
        return rt.db.runTransaction(async () => 1, optCand.build());
      },
    });
  }

  const maxAttemptsCandidates: CandidateValue[] = [
    ...emitTypeWrongnessCandidates(),
    makeCandidate('-1', () => -1),
    makeCandidate('1.5', () => 1.5),
    makeCandidate('5', () => 5),
    makeCandidate('Infinity', () => Number.POSITIVE_INFINITY),
  ];
  for (const maCand of maxAttemptsCandidates) {
    cases.push({
      label: `runTransaction({maxAttempts:${maCand.label}})`,
      invoke: (rt) => rt.db.runTransaction(async () => 1, { maxAttempts: maCand.build() }),
    });
  }

  for (const roCand of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `runTransaction({readOnly:${roCand.label}})`,
      invoke: (rt) => rt.db.runTransaction(async () => 1, { readOnly: roCand.build() }),
    });
  }

  cases.push(
    {
      label: 'runTransaction({readOnly:true, readTime:Timestamp.now()})',
      invoke: (rt) =>
        rt.db.runTransaction(async () => 1, {
          readOnly: true,
          readTime: rt.Timestamp.now(),
        }),
    },
    {
      label: 'runTransaction({readOnly:true, readTime:"bad"})',
      invoke: (rt) =>
        rt.db.runTransaction(async () => 1, {
          readOnly: true,
          readTime: 'bad',
        }),
    },
    {
      label: 'runTransaction(readOnly write attempt: set)',
      invoke: (rt) =>
        rt.db.runTransaction(
          async (tx: unknown) => {
            const typedTx = tx as { set: (r: unknown, d: unknown) => unknown };
            typedTx.set(rt.db.doc(rt.existingDocPath), { count: 9 });
          },
          { readOnly: true },
        ),
    },
    {
      label: 'runTransaction(readOnly write attempt: delete)',
      invoke: (rt) =>
        rt.db.runTransaction(
          async (tx: unknown) => {
            const typedTx = tx as { delete: (r: unknown) => unknown };
            typedTx.delete(rt.db.doc(rt.existingDocPath));
          },
          { readOnly: true },
        ),
    },
  );

  // 3. Transaction handle methods: tx.get, tx.create, tx.set, tx.update, tx.delete
  for (const targetCand of nonDocRefCandidates) {
    cases.push({
      label: `tx.get(target=${targetCand.label})`,
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { get: (t: unknown) => Promise<unknown> };
          return typedTx.get(targetCand.build());
        }),
    });
    cases.push({
      label: `tx.set(ref=${targetCand.label})`,
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { set: (r: unknown, d: unknown) => unknown };
          typedTx.set(targetCand.build(), { count: 5 });
        }),
    });
  }

  cases.push(
    {
      label: 'tx.get(valid docRef) + tx.set(falsy options=null)',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as {
            get: (t: unknown) => Promise<unknown>;
            set: (r: unknown, d: unknown, o?: unknown) => unknown;
          };
          const docRef = rt.db.doc(rt.existingDocPath);
          await typedTx.get(docRef);
          typedTx.set(docRef, { title: 'Seeded', count: 1, nested: { flag: true } }, null);
        }),
    },
    {
      label: 'tx.get(valid Query)',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { get: (t: unknown) => Promise<unknown> };
          return typedTx.get(rt.db.collection('items').where('count', '==', 1));
        }),
    },
    {
      label: 'tx.get(invalid limitToLast Query without orderBy)',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { get: (t: unknown) => Promise<unknown> };
          return typedTx.get(rt.db.collection('items').limitToLast(1));
        }),
    },
    {
      label: 'tx.read-after-write rejection',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as {
            get: (t: unknown) => Promise<unknown>;
            set: (r: unknown, d: unknown) => unknown;
          };
          const docRef = rt.db.doc(rt.existingDocPath);
          typedTx.set(docRef, { title: 'Seeded', count: 1, nested: { flag: true } });
          return typedTx.get(docRef);
        }),
    },
    {
      label: 'tx.update(1-arg missing data)',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { update: (r: unknown, ...a: unknown[]) => unknown };
          typedTx.update(rt.db.doc(rt.existingDocPath));
        }),
    },
    {
      label: 'tx.delete(invalid precondition)',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { delete: (r: unknown, p?: unknown) => unknown };
          typedTx.delete(rt.db.doc(rt.existingDocPath), 'bad');
        }),
    },
    {
      label: 'tx.set({mergeFields:["title","title"]} exact-dup)',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { set: (r: unknown, d: unknown, o?: unknown) => unknown };
          typedTx.set(
            rt.db.doc(rt.existingDocPath),
            { title: 't' },
            { mergeFields: ['title', 'title'] },
          );
        }),
    },
    {
      label: 'tx.set({mergeFields:["nested","nested.flag"]} ancestor-descendant)',
      invoke: (rt) =>
        rt.db.runTransaction(async (tx: unknown) => {
          const typedTx = tx as { set: (r: unknown, d: unknown, o?: unknown) => unknown };
          typedTx.set(
            rt.db.doc(rt.existingDocPath),
            { nested: { flag: true } },
            { mergeFields: ['nested', 'nested.flag'] },
          );
        }),
    },
  );

  return cases;
}
