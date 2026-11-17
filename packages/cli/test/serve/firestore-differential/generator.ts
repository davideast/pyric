/**
 * Synthesizes deterministic, multi-step Firestore differential sequences from
 * an integer seed.
 */

import { createPrng, type Prng } from './prng.js';
import {
  RULES_POOL,
  type BatchMutation,
  type ClaimScalar,
  type CursorSpec,
  type FieldPathSpec,
  type FilterSpec,
  type OrderSpec,
  type QueryFieldSpec,
  type QuerySourceSpec,
  type QuerySpec,
  type Sequence,
  type Step,
  type TxnScript,
  type ValueSpec,
} from './sequence.js';
import {
  DOC_PATHS,
  LABEL_POOL,
  randomDocumentData,
  randomScalarValue,
  randomSetMode,
  randomUpdates,
  TAG_POOL,
} from './value-generator.js';

export interface GenerateOptions {
  minSteps?: number;
  maxSteps?: number;
}

const ADD_DOC_COLLECTIONS: readonly string[] = [
  'orgs/o1/logs',
  'orgs/o2/logs',
];

const QUERY_SOURCES: readonly QuerySourceSpec[] = [
  { kind: 'collection', path: 'items' },
  { kind: 'collection', path: 'users' },
  { kind: 'collection', path: 'orgs/o1/docs' },
  { kind: 'collection', path: 'rooms/r1/items' },
  { kind: 'collection', path: 'metrics' },
  { kind: 'collectionGroup', collectionId: 'items' },
  { kind: 'collectionGroup', collectionId: 'docs' },
];

const QUERY_SCALAR_FIELDS: readonly FieldPathSpec[] = [
  'n',
  'label',
  'flag',
  'meta.count',
  { segments: ['meta.v1', 'flag'] },
];

function randomDb(rng: Prng): number {
  return rng.weighted([
    [6, 0],
    [2, 1],
    [2, 2],
  ]);
}

function collectionDocIdsFor(source: QuerySourceSpec): readonly string[] {
  if (source.kind === 'collection') {
    if (source.path === 'users') return ['alice', 'bob', 'carol'];
    if (source.path === 'orgs/o1/docs') return ['d1', 'd2'];
    if (source.path === 'rooms/r1/items') return ['i1', 'i2'];
    if (source.path === 'metrics') return ['m1', 'm2'];
    return ['i1', 'i2', 'i3', 'i4', 'i5'];
  }
  if (source.collectionId === 'docs') {
    return ['orgs/o1/docs/d1', 'orgs/o2/docs/d1'];
  }
  return ['items/i1', 'rooms/r1/items/i1'];
}

function randomLeafFilter(rng: Prng, source: QuerySourceSpec): FilterSpec {
  const kind = rng.int(0, 9);
  if (kind === 0) {
    return { kind: 'where', field: rng.pick(QUERY_SCALAR_FIELDS), op: '==', value: rng.pick([0, 1, 2, 3, true, false, 'active', null]) };
  }
  if (kind === 1) {
    return { kind: 'where', field: 'n', op: '!=', value: rng.pick([0, 2, null]) };
  }
  if (kind === 2) {
    return { kind: 'where', field: 'n', op: rng.pick(['<', '<=', '>', '>='] as const), value: rng.int(0, 8) };
  }
  if (kind === 3) {
    if (rng.chance(0.4)) {
      return {
        kind: 'where',
        field: 'tags',
        op: 'in',
        value: {
          $array: [
            { $array: [rng.pick(TAG_POOL), rng.pick(TAG_POOL)] },
            { $array: [rng.pick(TAG_POOL)] },
          ],
        },
      };
    }
    return {
      kind: 'where',
      field: 'label',
      op: 'in',
      value: { $array: [rng.pick(LABEL_POOL), rng.pick(LABEL_POOL)] },
    };
  }
  if (kind === 4) {
    if (rng.chance(0.4)) {
      return {
        kind: 'where',
        field: 'tags',
        op: 'not-in',
        value: {
          $array: [
            { $array: [rng.pick(TAG_POOL)] },
            { $array: [] },
          ],
        },
      };
    }
    return {
      kind: 'where',
      field: 'n',
      op: 'not-in',
      value: { $array: [rng.int(0, 4), rng.int(5, 9)] },
    };
  }
  if (kind === 5) {
    return { kind: 'where', field: 'tags', op: 'array-contains', value: rng.pick(TAG_POOL) };
  }
  if (kind === 6) {
    return {
      kind: 'where',
      field: 'tags',
      op: 'array-contains-any',
      value: { $array: [rng.pick(TAG_POOL), rng.pick(TAG_POOL)] },
    };
  }
  if (kind === 7) {
    const ids = collectionDocIdsFor(source);
    let idValue: ValueSpec = { $array: [ids[0] ?? 'i1'] };
    if (rng.chance(0.6)) {
      idValue = rng.pick(ids);
    }
    return {
      kind: 'where',
      field: { documentId: true },
      op: rng.pick(['==', '>=', 'in'] as const),
      value: idValue,
    };
  }
  if (kind === 8) {
    return { kind: 'where', field: 'meta.count', op: rng.pick(['==', '>=', '<='] as const), value: rng.int(0, 6) };
  }
  return {
    kind: 'where',
    field: 'extra',
    op: '==',
    value: randomScalarValue(rng),
  };
}

function randomFilter(rng: Prng, source: QuerySourceSpec): FilterSpec {
  if (rng.chance(0.72)) {
    return randomLeafFilter(rng, source);
  }
  const compositeKind: 'and' | 'or' = rng.chance(0.55) ? 'and' : 'or';
  return {
    kind: compositeKind,
    filters: [
      { kind: 'where', field: 'n', op: rng.pick(['==', '>=', '<='] as const), value: rng.int(0, 6) },
      { kind: 'where', field: 'flag', op: '==', value: rng.chance(0.5) },
    ],
  };
}

function randomCursor(rng: Prng, orders: readonly OrderSpec[], source: QuerySourceSpec): CursorSpec {
  if (source.kind === 'collection' && rng.chance(0.35)) {
    const docId = rng.pick(collectionDocIdsFor(source));
    return { mode: 'docSnap', path: `${source.path}/${docId}` };
  }
  const values: ValueSpec[] = orders.map((order) => {
    if (typeof order.field === 'object' && 'documentId' in order.field) {
      const ids = collectionDocIdsFor(source);
      return rng.pick(ids);
    }
    if (order.field === 'label') {
      return rng.pick(LABEL_POOL);
    }
    if (order.field === 'flag') {
      return rng.chance(0.5);
    }
    return rng.int(0, 8);
  });
  return { mode: 'values', values };
}

function randomQuerySpec(rng: Prng): QuerySpec {
  const source = rng.pick(QUERY_SOURCES);
  const spec: QuerySpec = { source };

  if (rng.chance(0.75)) {
    spec.filter = randomFilter(rng, source);
  }

  const orders: OrderSpec[] = [];
  if (rng.chance(0.7)) {
    const firstField: QueryFieldSpec = rng.pick([
      'n',
      'label',
      'meta.count',
      { documentId: true },
    ] as QueryFieldSpec[]);
    const firstDir: 'asc' | 'desc' = rng.chance(0.5) ? 'asc' : 'desc';
    orders.push({ field: firstField, dir: firstDir });
    const firstIsDocId = typeof firstField === 'object' && 'documentId' in firstField;
    if (!firstIsDocId && rng.chance(0.35)) {
      const secondField: QueryFieldSpec = firstField === 'n' ? 'label' : 'n';
      const secondDir: 'asc' | 'desc' = rng.chance(0.5) ? 'asc' : 'desc';
      orders.push({ field: secondField, dir: secondDir });
    }
    spec.orderBy = orders;
  }

  if (orders.length > 0 && rng.chance(0.4)) {
    const cursor = randomCursor(rng, orders, source);
    if (rng.chance(0.5)) {
      spec.startAt = cursor;
    } else {
      spec.startAfter = cursor;
    }
  }
  if (orders.length > 0 && rng.chance(0.3)) {
    const cursor = randomCursor(rng, orders, source);
    if (rng.chance(0.5)) {
      spec.endAt = cursor;
    } else {
      spec.endBefore = cursor;
    }
  }

  if (rng.chance(0.45)) {
    if (orders.length > 0 && rng.chance(0.35)) {
      spec.limitToLast = rng.int(1, 4);
    } else {
      spec.limit = rng.int(1, 5);
    }
  }

  return spec;
}

function randomBatchStep(rng: Prng): Step {
  const db = randomDb(rng);
  const target = rng.pick(DOC_PATHS);
  const pattern = rng.int(0, 3);
  const mutations: BatchMutation[] = [];

  if (pattern === 0) {
    const { style, updates } = randomUpdates(rng);
    mutations.push({
      kind: 'set',
      path: target,
      data: randomDocumentData(rng, false),
      mode: randomSetMode(rng),
    });
    mutations.push({ kind: 'update', path: target, style, updates });
  } else if (pattern === 1) {
    mutations.push({ kind: 'delete', path: target });
    mutations.push({
      kind: 'set',
      path: target,
      data: randomDocumentData(rng, false),
      mode: { kind: 'replace' },
    });
  } else {
    const count = rng.int(1, 4);
    for (let i = 0; i < count; i++) {
      const docPath = rng.pick(DOC_PATHS);
      const opKind = rng.int(0, 2);
      if (opKind === 0) {
        const mode = randomSetMode(rng);
        mutations.push({
          kind: 'set',
          path: docPath,
          data: randomDocumentData(rng, mode.kind !== 'replace'),
          mode,
        });
      } else if (opKind === 1) {
        const { style, updates } = randomUpdates(rng);
        mutations.push({ kind: 'update', path: docPath, style, updates });
      } else {
        mutations.push({ kind: 'delete', path: docPath });
      }
    }
  }

  const step: Step = { op: 'writeBatch', db, mutations };
  if (rng.chance(0.15)) {
    step.postCommitWrite = true;
  }
  return step;
}

function randomTransactionStep(rng: Prng): Step {
  const db = randomDb(rng);
  const firstPath = rng.pick(DOC_PATHS);
  let secondPath = rng.pick(DOC_PATHS);
  if (secondPath === firstPath) {
    secondPath = 'items/i2';
  }
  const script: TxnScript = rng.weighted([
    [4, 'conditionalIncrement'],
    [3, 'readTwoSwap'],
    [2, 'deleteThenSet'],
    [2, 'setThenUpdate'],
    [2, 'abortAfterWrites'],
    [1, 'readAfterWriteInvalid'],
  ]);
  const { updates } = randomUpdates(rng);
  return {
    op: 'runTransaction',
    db,
    paths: [firstPath, secondPath],
    script,
    auxData: randomDocumentData(rng, false),
    auxUpdates: updates,
  };
}

function randomClaims(rng: Prng): Record<string, ClaimScalar> | undefined {
  if (rng.chance(0.25)) {
    return undefined;
  }
  return {
    role: rng.pick(['admin', 'editor', 'viewer']),
    tier: rng.pick([1, 2, 3]),
    verified: rng.chance(0.7),
  };
}

export function generateSequence(seed: number, options: GenerateOptions = {}): Sequence {
  const rng = createPrng(seed);
  const minSteps = options.minSteps ?? 28;
  const maxSteps = options.maxSteps ?? 38;
  const stepCount = rng.int(minSteps, maxSteps);
  const initialRules = rng.weighted([
    [5, 0],
    [2, 1],
    [3, 2],
    [2, 3],
    [2, 4],
    [1, 5],
  ]);

  const activeListeners: number[] = [];
  let nextListenerId = 0;
  const steps: Step[] = [];

  for (let index = 0; index < stepCount; index++) {
    const kind = rng.weighted([
      [18, 'setDoc'],
      [12, 'updateDoc'],
      [6, 'deleteDoc'],
      [5, 'addDoc'],
      [10, 'writeBatch'],
      [10, 'runTransaction'],
      [8, 'getDoc'],
      [12, 'getDocs'],
      [6, 'listenDoc'],
      [6, 'listenQuery'],
      [4, 'unlisten'],
      [5, 'auth'],
      [4, 'rules'],
    ] as const);

    if (kind === 'setDoc') {
      const mode = randomSetMode(rng);
      steps.push({
        op: 'setDoc',
        db: randomDb(rng),
        path: rng.pick(DOC_PATHS),
        data: randomDocumentData(rng, mode.kind !== 'replace'),
        mode,
      });
      continue;
    }
    if (kind === 'updateDoc') {
      const { style, updates } = randomUpdates(rng);
      steps.push({ op: 'updateDoc', db: randomDb(rng), path: rng.pick(DOC_PATHS), style, updates });
      continue;
    }
    if (kind === 'deleteDoc') {
      steps.push({ op: 'deleteDoc', db: randomDb(rng), path: rng.pick(DOC_PATHS) });
      continue;
    }
    if (kind === 'addDoc') {
      steps.push({
        op: 'addDoc',
        db: randomDb(rng),
        collectionPath: rng.pick(ADD_DOC_COLLECTIONS),
        data: randomDocumentData(rng, false),
      });
      continue;
    }
    if (kind === 'writeBatch') {
      steps.push(randomBatchStep(rng));
      continue;
    }
    if (kind === 'runTransaction') {
      steps.push(randomTransactionStep(rng));
      continue;
    }
    if (kind === 'getDoc') {
      steps.push({ op: 'getDoc', db: randomDb(rng), path: rng.pick(DOC_PATHS) });
      continue;
    }
    if (kind === 'getDocs') {
      steps.push({ op: 'getDocs', db: randomDb(rng), query: randomQuerySpec(rng) });
      continue;
    }
    if (kind === 'listenDoc' && activeListeners.length < 4) {
      const id = nextListenerId++;
      activeListeners.push(id);
      steps.push({ op: 'listenDoc', db: randomDb(rng), id, path: rng.pick(DOC_PATHS) });
      continue;
    }
    if (kind === 'listenQuery' && activeListeners.length < 4) {
      const id = nextListenerId++;
      activeListeners.push(id);
      steps.push({ op: 'listenQuery', db: randomDb(rng), id, query: randomQuerySpec(rng) });
      continue;
    }
    if (kind === 'unlisten' && activeListeners.length > 0) {
      const slot = rng.int(0, activeListeners.length - 1);
      const chosen = activeListeners.splice(slot, 1)[0];
      if (chosen !== undefined) {
        steps.push({ op: 'unlisten', id: chosen });
        continue;
      }
    }
    if (kind === 'auth') {
      const authRoll = rng.int(0, 4);
      if (authRoll <= 1) {
        const claims = randomClaims(rng);
        const step: Step = { op: 'signIn', uid: rng.pick(['alice', 'bob', 'carol']) };
        if (claims !== undefined) {
          step.claims = claims;
        }
        steps.push(step);
      } else if (authRoll === 2) {
        steps.push({ op: 'signInAnonymously' });
      } else if (authRoll === 3) {
        steps.push({ op: 'signOut' });
      } else {
        steps.push({ op: 'refreshToken' });
      }
      continue;
    }
    if (kind === 'rules') {
      steps.push({ op: 'rules', rules: rng.int(0, RULES_POOL.length - 1) });
      continue;
    }
    steps.push({
      op: 'setDoc',
      db: randomDb(rng),
      path: rng.pick(DOC_PATHS),
      data: randomDocumentData(rng, false),
      mode: { kind: 'replace' },
    });
  }

  return { seed, initialRules, steps };
}
