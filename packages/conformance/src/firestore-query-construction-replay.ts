/**
 * Cross-plane replay drivers for the 12 Firestore `Query construction` probes.
 *
 * Drives the exact probe inputs against any `FirestoreScenarioContext` (`inPageContext`
 * for `pyric/firestore` or `servedFirestoreContext` for the SharedWorker/hosted client +
 * host) and returns normalized behavior records matching `firestore-probe-outcomes.ts`.
 */
import { Bytes, GeoPoint, Timestamp } from 'pyric/firestore';
import type { FirestoreScenarioContext } from './capture/sdk-scenarios/scenario-types.ts';
import {
  observeFirestoreCall,
  observeFirestoreIdQuery,
  type FirestoreIdQueryOutcome,
  type FirestoreSyncCallOutcome,
} from './firestore-probe-outcomes.ts';

export function stripCaptureTransport<T extends Record<string, unknown>>(behavior: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(behavior)) {
    if (key === 'transport') {
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = stripCaptureTransport(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export async function replayQueryComposeWhereOrderByLimit(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/compose-where-orderby-limit`);
  await fs.setDoc(fs.doc(items, 'd1'), { score: 10 });
  await fs.setDoc(fs.doc(items, 'd2'), { score: 20 });
  await fs.setDoc(fs.doc(items, 'd3'), { score: 30 });
  await fs.setDoc(fs.doc(items, 'd4'), { score: 40 });

  return {
    gteTwentyAscTopTwo: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('score', '>=', 20), fs.orderBy('score', 'asc'), fs.limit(2))),
    ),
    gteTwentyDescTopTwo: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('score', '>=', 20), fs.orderBy('score', 'desc'), fs.limit(2))),
    ),
    ltFortyDescTopOne: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('score', '<', 40), fs.orderBy('score', 'desc'), fs.limit(1))),
    ),
  };
}

export async function replayWhereTenFilterOperators(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/where-ten-ops`);
  await fs.setDoc(fs.doc(items, 'd1'), { num: 10, tags: ['red', 'blue'] });
  await fs.setDoc(fs.doc(items, 'd2'), { num: 20, tags: ['blue', 'green'] });
  await fs.setDoc(fs.doc(items, 'd3'), { num: 30, tags: ['yellow'] });
  await fs.setDoc(fs.doc(items, 'd4'), { num: 40, tags: [] });

  return {
    lt: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('num', '<', 30)))),
    lte: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('num', '<=', 30)))),
    eq: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('num', '==', 20)))),
    gte: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('num', '>=', 20)))),
    gt: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('num', '>', 20)))),
    neq: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('num', '!=', 20)))),
    inOp: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('num', 'in', [10, 30]))),
    ),
    notInOp: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('num', 'not-in', [10, 30]))),
    ),
    arrayContains: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('tags', 'array-contains', 'blue'))),
    ),
    arrayContainsAny: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('tags', 'array-contains-any', ['red', 'yellow']))),
    ),
  };
}

export async function replayWhereExistenceAndNullGuards(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/where-existence-null`);
  await fs.setDoc(fs.doc(items, 'missing'), { label: 'absent' });
  await fs.setDoc(fs.doc(items, 'null_val'), { val: null });
  await fs.setDoc(fs.doc(items, 'ten'), { val: 10 });
  await fs.setDoc(fs.doc(items, 'twenty'), { val: 20 });

  return {
    eqTen: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('val', '==', 10)))),
    eqNull: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', '==', null))),
    ),
    ltTwenty: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', '<', 20))),
    ),
    lteTwenty: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', '<=', 20))),
    ),
    gtTen: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('val', '>', 10)))),
    gteTen: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', '>=', 10))),
    ),
    inTenTwenty: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', 'in', [10, 20]))),
    ),
    inWithNull: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', 'in', [10, null]))),
    ),
    neqTen: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.where('val', '!=', 10)))),
    neqNull: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', '!=', null))),
    ),
    notInTen: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', 'not-in', [10]))),
    ),
    notInWithNull: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', 'not-in', [10, null]))),
    ),
  };
}

export async function replayOrderByDirectionAscDesc(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/orderby-direction`);
  await fs.setDoc(fs.doc(items, 'd1'), { rank: 30 });
  await fs.setDoc(fs.doc(items, 'd2'), { rank: 10 });
  await fs.setDoc(fs.doc(items, 'd3'), { rank: 20 });

  return {
    defaultDirection: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('rank'))),
    ),
    explicitAsc: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('rank', 'asc'))),
    ),
    explicitDesc: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('rank', 'desc'))),
    ),
  };
}

export async function replayOrderByCanonicalTypeOrder(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/orderby-type-order`);
  const anchor = fs.doc(db, `${base}/orderby-type-order/anchor`);

  await fs.setDoc(fs.doc(items, 't_null'), { v: null });
  await fs.setDoc(fs.doc(items, 't_bool_false'), { v: false });
  await fs.setDoc(fs.doc(items, 't_bool_true'), { v: true });
  await fs.setDoc(fs.doc(items, 't_num_nan'), { v: Number.NaN });
  await fs.setDoc(fs.doc(items, 't_num_neg'), { v: -10 });
  await fs.setDoc(fs.doc(items, 't_num_two'), { v: 2 });
  await fs.setDoc(fs.doc(items, 't_num_ten'), { v: 10 });
  await fs.setDoc(fs.doc(items, 't_ts'), { v: Timestamp.fromMillis(1_700_000_000_000) });
  await fs.setDoc(fs.doc(items, 't_str'), { v: 'alpha' });
  await fs.setDoc(fs.doc(items, 't_bytes'), { v: Bytes.fromUint8Array(new Uint8Array([1, 2])) });
  await fs.setDoc(fs.doc(items, 't_ref'), { v: anchor });
  await fs.setDoc(fs.doc(items, 't_geo'), { v: new GeoPoint(10, 20) });
  await fs.setDoc(fs.doc(items, 't_arr'), { v: [1] });
  await fs.setDoc(fs.doc(items, 't_map'), { v: { k: 1 } });

  return {
    allAsc: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.orderBy('v', 'asc')))),
    allDesc: await observeFirestoreIdQuery(() => fs.getDocs(fs.query(items, fs.orderBy('v', 'desc')))),
    numberRangeGtZero: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('v', '>', 0), fs.orderBy('v', 'asc'))),
    ),
    stringRangeGteA: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('v', '>=', 'a'), fs.orderBy('v', 'asc'))),
    ),
  };
}

export async function replayOrderByExcludesMissingField(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/orderby-excludes-missing`);
  await fs.setDoc(fs.doc(items, 'present_high'), { rank: 20, tag: 'a' });
  await fs.setDoc(fs.doc(items, 'missing_field'), { tag: 'b' });
  await fs.setDoc(fs.doc(items, 'present_null'), { rank: null, tag: 'c' });
  await fs.setDoc(fs.doc(items, 'present_low'), { rank: 5, tag: 'd' });

  return {
    unfiltered: await observeFirestoreIdQuery(() => fs.getDocs(items)),
    orderByAsc: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('rank', 'asc'))),
    ),
    orderByDesc: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('rank', 'desc'))),
    ),
  };
}

export async function replayOrderByImplicitInequalityAndNameTiebreak(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/orderby-implicit-tiebreak`);
  await fs.setDoc(fs.doc(items, 'k3'), { val: 2 });
  await fs.setDoc(fs.doc(items, 'k1'), { val: 2 });
  await fs.setDoc(fs.doc(items, 'k2'), { val: 1 });
  await fs.setDoc(fs.doc(items, 'k0'), { val: 3 });

  return {
    equalValueAscTiebreak: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('val', 'asc'))),
    ),
    equalValueDescTiebreak: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('val', 'desc'))),
    ),
    inequalityWithoutExplicitOrderBy: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.where('val', '>', 1))),
    ),
  };
}

export async function replayLimitCapsResultCount(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<{
  clientBounds: Record<string, FirestoreSyncCallOutcome>;
  live: Record<string, FirestoreIdQueryOutcome>;
}> {
  const { fs, db, base } = ctx;
  const clientBounds = {
    limitZero: observeFirestoreCall(() => fs.limit(0)),
    limitNegativeOne: observeFirestoreCall(() => fs.limit(-1)),
    limitPositiveTwo: observeFirestoreCall(() => fs.limit(2)),
  };

  const items = fs.collection(db, `${base}/limit-caps-count`);
  await fs.setDoc(fs.doc(items, 'd1'), { seq: 1 });
  await fs.setDoc(fs.doc(items, 'd2'), { seq: 2 });
  await fs.setDoc(fs.doc(items, 'd3'), { seq: 3 });
  await fs.setDoc(fs.doc(items, 'd4'), { seq: 4 });

  const live = {
    ascLimitTwo: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('seq', 'asc'), fs.limit(2))),
    ),
    descLimitThree: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('seq', 'desc'), fs.limit(3))),
    ),
    ascLimitExceedsCount: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.orderBy('seq', 'asc'), fs.limit(10))),
    ),
  };

  return { clientBounds, live };
}

export async function replayCompositeOrWithOrderByAndLimit(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<{
  clientTopLevelMixing: Record<string, FirestoreSyncCallOutcome>;
  live: Record<string, FirestoreIdQueryOutcome>;
}> {
  const { fs, db, base } = ctx;
  const dummyItems = fs.collection(db, `${base}/composite-mixing-check`);
  const queryUntyped = fs.query as unknown as (source: unknown, ...constraints: unknown[]) => unknown;
  const clientTopLevelMixing = {
    orWithOrderByAndLimit: observeFirestoreCall(() =>
      queryUntyped(
        dummyItems,
        fs.or(fs.where('group', '==', 'a'), fs.where('group', '==', 'b')),
        fs.orderBy('score', 'desc'),
        fs.limit(2),
      ),
    ),
    wherePlusOrSameCall: observeFirestoreCall(() =>
      queryUntyped(
        dummyItems,
        fs.where('active', '==', true),
        fs.or(fs.where('group', '==', 'a'), fs.where('group', '==', 'b')),
      ),
    ),
    orPlusWhereSameCall: observeFirestoreCall(() =>
      queryUntyped(
        dummyItems,
        fs.or(fs.where('group', '==', 'a'), fs.where('group', '==', 'b')),
        fs.where('active', '==', true),
      ),
    ),
    orPlusOrSameCall: observeFirestoreCall(() =>
      queryUntyped(
        dummyItems,
        fs.or(fs.where('group', '==', 'a'), fs.where('group', '==', 'b')),
        fs.or(fs.where('score', '==', 10), fs.where('score', '==', 40)),
      ),
    ),
    andWrappingWhereAndOr: observeFirestoreCall(() =>
      queryUntyped(
        dummyItems,
        fs.and(
          fs.where('active', '==', true),
          fs.or(fs.where('group', '==', 'a'), fs.where('group', '==', 'b')),
        ),
      ),
    ),
    chainedWhereThenOr: observeFirestoreCall(() =>
      queryUntyped(
        fs.query(dummyItems, fs.where('active', '==', true)),
        fs.or(fs.where('group', '==', 'a'), fs.where('group', '==', 'b')),
      ),
    ),
  };

  const items = fs.collection(db, `${base}/composite-or-orderby-limit`);
  await fs.setDoc(fs.doc(items, 'd1'), { score: 10, group: 'alpha' });
  await fs.setDoc(fs.doc(items, 'd2'), { score: 20, group: 'beta' });
  await fs.setDoc(fs.doc(items, 'd3'), { score: 30, group: 'alpha' });
  await fs.setDoc(fs.doc(items, 'd4'), { score: 40, group: 'alpha' });

  const chained = queryUntyped(
    fs.query(items, fs.where('group', '==', 'alpha')),
    fs.or(fs.where('score', '==', 10), fs.where('score', '==', 40)),
  ) as Parameters<typeof fs.getDocs>[0];

  const live = {
    orWithOrderByDescLimitTwo: await observeFirestoreIdQuery(() =>
      fs.getDocs(
        fs.query(
          items,
          fs.or(fs.where('score', '==', 10), fs.where('score', '==', 30), fs.where('score', '==', 40)),
          fs.orderBy('score', 'desc'),
          fs.limit(2),
        ),
      ),
    ),
    andWrappingWhereAndOr: await observeFirestoreIdQuery(() =>
      fs.getDocs(
        fs.query(
          items,
          fs.and(
            fs.where('group', '==', 'alpha'),
            fs.or(fs.where('score', '==', 10), fs.where('score', '==', 40)),
          ),
        ),
      ),
    ),
    chainedWhereThenOr: await observeFirestoreIdQuery(() => fs.getDocs(chained)),
  };

  return { clientTopLevelMixing, live };
}

export function replayCompositeRejectsNonFilterConstraints(
  ctx: Pick<FirestoreScenarioContext, 'fs'>,
): Record<string, FirestoreSyncCallOutcome> {
  const { fs } = ctx;
  const orUntyped = fs.or as unknown as (...args: unknown[]) => unknown;
  const andUntyped = fs.and as unknown as (...args: unknown[]) => unknown;

  return {
    orWithOrderBy: observeFirestoreCall(() => orUntyped(fs.orderBy('x'))),
    orWithLimit: observeFirestoreCall(() => orUntyped(fs.limit(5))),
    orWithLimitToLast: observeFirestoreCall(() => orUntyped(fs.limitToLast(5))),
    andWithOrderBy: observeFirestoreCall(() => andUntyped(fs.orderBy('x'))),
    andWithLimit: observeFirestoreCall(() => andUntyped(fs.limit(5))),
    andWithStartAt: observeFirestoreCall(() => andUntyped(fs.startAt(1))),
    andWithEndBefore: observeFirestoreCall(() => andUntyped(fs.endBefore(1))),
    orMixedWhereAndOrderBy: observeFirestoreCall(() =>
      orUntyped(fs.where('x', '==', 1), fs.orderBy('x')),
    ),
  };
}

export async function replayCompositeZeroArgOrAnd(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<{
  clientConstruction: Record<string, FirestoreSyncCallOutcome>;
  liveExecution: Record<string, FirestoreIdQueryOutcome>;
}> {
  const { fs, db, base } = ctx;
  const checkItems = fs.collection(db, `${base}/zero-arg-composite-check`);
  const clientConstruction = {
    orZeroArgs: observeFirestoreCall(() => fs.or()),
    andZeroArgs: observeFirestoreCall(() => fs.and()),
    queryWithOrZeroArgs: observeFirestoreCall(() => fs.query(checkItems, fs.or())),
    queryWithAndZeroArgs: observeFirestoreCall(() => fs.query(checkItems, fs.and())),
  };

  const items = fs.collection(db, `${base}/zero-arg-composites`);
  await fs.setDoc(fs.doc(items, 'd1'), { v: 1 });
  await fs.setDoc(fs.doc(items, 'd2'), { v: 2 });

  const liveExecution = {
    getDocsWithOrZeroArgs: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.or())),
    ),
    getDocsWithAndZeroArgs: await observeFirestoreIdQuery(() =>
      fs.getDocs(fs.query(items, fs.and())),
    ),
  };

  return { clientConstruction, liveExecution };
}

export async function replayQueryChainingRetagsConstraints(
  ctx: Pick<FirestoreScenarioContext, 'fs' | 'db' | 'base'>,
): Promise<Record<string, FirestoreIdQueryOutcome>> {
  const { fs, db, base } = ctx;
  const items = fs.collection(db, `${base}/chained-query-retag`);
  await fs.setDoc(fs.doc(items, 'd1'), { score: 10 });
  await fs.setDoc(fs.doc(items, 'd2'), { score: 20 });
  await fs.setDoc(fs.doc(items, 'd3'), { score: 30 });
  await fs.setDoc(fs.doc(items, 'd4'), { score: 40 });

  const step1Filtered = fs.query(items, fs.where('score', '>=', 20));
  const step2Ordered = fs.query(step1Filtered, fs.orderBy('score', 'desc'));
  const step3Limited = fs.query(step2Ordered, fs.limit(2));

  return {
    chainedThreeStep: await observeFirestoreIdQuery(() => fs.getDocs(step3Limited)),
    intermediateOrderedUnmutated: await observeFirestoreIdQuery(() => fs.getDocs(step2Ordered)),
    intermediateFilteredUnmutated: await observeFirestoreIdQuery(() => fs.getDocs(step1Filtered)),
  };
}
