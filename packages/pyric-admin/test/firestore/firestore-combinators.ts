/**
 * Firestore-specific argument and grammar combinators composed on top of
 * `../argument-generator/argument-combinators.ts` (without modifying that
 * shared module).
 */

import {
  emitBoundedCollectionCandidates,
  emitPrefixedIdentifierCandidates,
  emitTypeWrongnessCandidates,
  makeCandidate,
  type CandidateValue,
} from '../argument-generator/argument-combinators.js';

export interface FirestoreQueryRuntimeHandle {
  where(field: unknown, op: unknown, value: unknown): FirestoreQueryRuntimeHandle;
  orderBy(field: unknown, direction?: unknown): FirestoreQueryRuntimeHandle;
  limit(n: unknown): FirestoreQueryRuntimeHandle;
  limitToLast(n: unknown): FirestoreQueryRuntimeHandle;
  get(): Promise<unknown>;
}

export interface FirestoreDialectRuntime {
  readonly db: {
    collection(path: unknown): FirestoreQueryRuntimeHandle & {
      doc(...args: unknown[]): { set(data: unknown, options?: unknown): Promise<unknown> };
      add(data: unknown): Promise<unknown>;
    };
    doc(path: unknown): {
      collection(path: unknown): unknown;
      get(): Promise<{ get(fieldPath: unknown): unknown }>;
      set(data: unknown, options?: unknown): Promise<unknown>;
      create(data: unknown): Promise<unknown>;
      update(...args: unknown[]): Promise<unknown>;
      delete(...args: unknown[]): Promise<unknown>;
    };
    collectionGroup(collectionId: unknown): FirestoreQueryRuntimeHandle;
    batch(): {
      create(ref: unknown, data: unknown): unknown;
      set(ref: unknown, data: unknown, options?: unknown): unknown;
      update(ref: unknown, ...args: unknown[]): unknown;
      delete(ref: unknown, ...args: unknown[]): unknown;
      commit(): Promise<unknown>;
    };
    runTransaction(
      fn: unknown,
      opts?: unknown,
    ): Promise<unknown>;
    getAll(...args: unknown[]): Promise<unknown>;
  };
  readonly FieldPath: new (...segments: unknown[]) => unknown;
  readonly documentId: () => unknown;
  readonly FieldValue: {
    serverTimestamp(): unknown;
    delete(): unknown;
    increment(...args: unknown[]): unknown;
    arrayUnion(...args: unknown[]): unknown;
    arrayRemove(...args: unknown[]): unknown;
  };
  readonly Timestamp: {
    new (seconds: number, nanoseconds: number): unknown;
    now(): unknown;
  };
  readonly existingDocPath: string;
  readonly nextAbsentDocPath: () => string;
}

export interface FirestoreDifferentialCase {
  readonly label: string;
  readonly invoke: (runtime: FirestoreDialectRuntime) => unknown;
  readonly allowDeferredWhenUpstreamAccepts?: boolean;
  readonly allowZeroLimitRejectionWhenUpstreamAccepts?: boolean;
  readonly allowCommittedBatchSecondCommitRejection?: boolean;
}

/**
 * Emits `databaseId` second-argument candidates for `getFirestore(app, databaseId)`
 * combining all 14 wrong-type boundary shapes with valid default/named strings.
 */
export function emitDatabaseIdCandidates(): CandidateValue[] {
  const identifierForms = emitPrefixedIdentifierCandidates({
    prefixes: ['', '(', 'reports-'],
    bodies: ['', 'default)', 'primary'],
  });
  return [...emitTypeWrongnessCandidates(), ...identifierForms];
}

/**
 * Emits `Firestore.getAll(...args)` argument-list candidates exercising
 * cardinality boundaries (`0, 1, 2, 10`), array-first-arg rejection, wrong
 * element types, and trailing `ReadOptions` `{ fieldMask }` shapes.
 */
export function emitGetAllInvocationCases(): FirestoreDifferentialCase[] {
  const cases: FirestoreDifferentialCase[] = [
    {
      label: 'getAll:0-args',
      invoke: (rt) => rt.db.getAll(),
      allowDeferredWhenUpstreamAccepts: true,
    },
    {
      label: 'getAll:array-first-arg',
      invoke: (rt) => rt.db.getAll([rt.db.doc(rt.existingDocPath)]),
      allowDeferredWhenUpstreamAccepts: true,
    },
  ];

  const boundedRefLists = emitBoundedCollectionCandidates({
    createValidElement: (idx) => `items/doc-${idx}`,
    maxLength: 5,
  });

  for (const candidate of boundedRefLists) {
    cases.push({
      label: `getAll:varargs[${candidate.label}]`,
      allowDeferredWhenUpstreamAccepts: true,
      invoke: (rt) => {
        const built = candidate.build();
        if (!Array.isArray(built)) {
          return rt.db.getAll(built);
        }
        const mapped = built.map((entry) => {
          if (typeof entry === 'string' && entry.startsWith('items/doc-')) {
            return rt.db.doc(entry);
          }
          return entry;
        });
        return rt.db.getAll(...mapped);
      },
    });
  }

  for (const maskCandidate of emitTypeWrongnessCandidates()) {
    cases.push({
      label: `getAll:readOptions.fieldMask=${maskCandidate.label}`,
      allowDeferredWhenUpstreamAccepts: true,
      invoke: (rt) =>
        rt.db.getAll(rt.db.doc(rt.existingDocPath), {
          fieldMask: maskCandidate.build(),
        }),
    });
  }

  cases.push(
    {
      label: 'getAll:readOptions.fieldMask=["title"]',
      allowDeferredWhenUpstreamAccepts: true,
      invoke: (rt) => rt.db.getAll(rt.db.doc(rt.existingDocPath), { fieldMask: ['title'] }),
    },
    {
      label: 'getAll:readOptions.fieldMask=["a..b"]',
      allowDeferredWhenUpstreamAccepts: true,
      invoke: (rt) => rt.db.getAll(rt.db.doc(rt.existingDocPath), { fieldMask: ['a..b'] }),
    },
  );

  return cases;
}

const PATH_PREFIX_FORMS = ['', '/', '//'] as const;
const PATH_BODY_FORMS = [
  '',
  'items',
  'items/',
  'items//',
  'items/d1',
  'items/d1/',
  'items//d1',
  'items/d1/sub',
  'items/d1//sub',
  'items/d1/sub/d2',
  '.',
  '..',
  '__reserved__',
  'items/.',
  'items/..',
  'items/__reserved__',
] as const;

export function emitResourcePathCandidates(): CandidateValue[] {
  const grammar = emitPrefixedIdentifierCandidates({
    prefixes: PATH_PREFIX_FORMS,
    bodies: PATH_BODY_FORMS,
  });
  return [...emitTypeWrongnessCandidates(), ...grammar];
}

export function emitStringFieldPathCandidates(): CandidateValue[] {
  const grammar = emitPrefixedIdentifierCandidates({
    prefixes: ['', '.', '..'],
    bodies: [
      '',
      'title',
      'nested.flag',
      'nested.',
      'nested..flag',
      'a*b',
      'a~b',
      'a/b',
      'a[0]',
      'a]b',
    ],
  });
  return [...emitTypeWrongnessCandidates(), ...grammar];
}

export function emitResourceAndFieldPathCases(): FirestoreDifferentialCase[] {
  const cases: FirestoreDifferentialCase[] = [];
  const pathCandidates = emitResourcePathCandidates();

  for (const candidate of pathCandidates) {
    cases.push({
      label: `db.collection(${candidate.label})`,
      invoke: (rt) => rt.db.collection(candidate.build()),
    });
    cases.push({
      label: `db.doc(${candidate.label})`,
      invoke: (rt) => rt.db.doc(candidate.build()),
    });
    cases.push({
      label: `db.doc(${candidate.label}).set`,
      invoke: (rt) => rt.db.doc(candidate.build()).set({ ok: true }),
    });
    cases.push({
      label: `col.doc(${candidate.label})`,
      invoke: (rt) => rt.db.collection('items').doc(candidate.build()),
    });
    cases.push({
      label: `doc.collection(${candidate.label})`,
      invoke: (rt) => rt.db.doc('items/d1').collection(candidate.build()),
    });
  }

  cases.push({
    label: 'col.doc(0-args)',
    invoke: (rt) => rt.db.collection('items').doc(),
  });

  const groupCandidates = [
    ...emitTypeWrongnessCandidates(),
    ...emitPrefixedIdentifierCandidates({
      prefixes: ['', '/'],
      bodies: ['', 'items', 'items/sub', '__reserved__', '.'],
    }),
  ];
  for (const candidate of groupCandidates) {
    cases.push({
      label: `db.collectionGroup(${candidate.label}).get`,
      invoke: (rt) => rt.db.collectionGroup(candidate.build()).get(),
    });
  }

  // FieldPath constructor segment combinators
  cases.push(
    {
      label: 'new FieldPath(0-args)',
      invoke: (rt) => new rt.FieldPath(),
    },
    {
      label: 'new FieldPath(["nested"])',
      invoke: (rt) => new rt.FieldPath(['nested']),
    },
  );

  const segmentTuples = emitBoundedCollectionCandidates({
    createValidElement: (idx) => `seg${idx}`,
    maxLength: 3,
    extraElementCandidates: () => [
      makeCandidate('literal-dot', () => 'a.b'),
      makeCandidate('special-chars', () => '*~/[]'),
      makeCandidate('backtick-slash', () => '`a\\b`'),
    ],
  });
  for (const tuple of segmentTuples) {
    cases.push({
      label: `new FieldPath(${tuple.label})`,
      invoke: (rt) => {
        const built = tuple.build();
        if (Array.isArray(built)) {
          return new rt.FieldPath(...built);
        }
        return new rt.FieldPath(built);
      },
    });
  }

  // DocumentSnapshot.get(fieldPath)
  for (const candidate of emitStringFieldPathCandidates()) {
    cases.push({
      label: `snap.get(${candidate.label})`,
      invoke: async (rt) => {
        const snap = await rt.db.doc(rt.existingDocPath).get();
        return snap.get(candidate.build());
      },
    });
  }
  cases.push({
    label: 'snap.get(FieldPath("nested", "flag"))',
    invoke: async (rt) => {
      const snap = await rt.db.doc(rt.existingDocPath).get();
      return snap.get(new rt.FieldPath('nested', 'flag'));
    },
  });

  return cases;
}
