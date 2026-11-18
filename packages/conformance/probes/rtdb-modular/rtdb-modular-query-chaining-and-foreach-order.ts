import type { DataSnapshot, Database, Query } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface QueryChainingAndForEachProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  get: typeof import('firebase/database').get;
  onValue: typeof import('firebase/database').onValue;
  query: typeof import('firebase/database').query;
  orderByChild: typeof import('firebase/database').orderByChild;
  startAt: typeof import('firebase/database').startAt;
  endAt: typeof import('firebase/database').endAt;
  limitToFirst: typeof import('firebase/database').limitToFirst;
}

interface OrderedRankSummary {
  forEachKeys: string[];
  forEachRanks: number[];
  valObjectKeys: string[];
}

function summarizeRankSnapshot(snap: DataSnapshot): OrderedRankSummary {
  const forEachKeys: string[] = [];
  const forEachRanks: number[] = [];
  snap.forEach((child) => {
    if (child.key !== null) {
      forEachKeys.push(child.key);
    }
    const raw = child.val() as { rank?: unknown } | null;
    if (raw && typeof raw.rank === 'number') {
      forEachRanks.push(raw.rank);
    }
    return false;
  });
  const val = snap.val();
  let valObjectKeys: string[] = [];
  if (typeof val === 'object' && val !== null) {
    valObjectKeys = Object.keys(val as Record<string, unknown>);
  }
  return { forEachKeys, forEachRanks, valObjectKeys };
}

async function readInitialRankOnValue(
  onValueFn: typeof import('firebase/database').onValue,
  targetQuery: Query,
  timeoutMs = 8_000,
): Promise<OrderedRankSummary> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await new Promise<OrderedRankSummary>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Timed out waiting for initial onValue(orderByChild) snapshot'));
      }, timeoutMs);
      unsubscribe = onValueFn(
        targetQuery,
        (snap) => {
          resolve(summarizeRankSnapshot(snap));
        },
        (err) => {
          reject(err);
        },
      );
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (unsubscribe !== undefined) {
      unsubscribe();
    }
  }
}

const RUN_RULES: Record<string, unknown> = {
  '.read': 'auth != null',
  '.write': 'auth != null',
  chained: {
    '.indexOn': ['rank'],
  },
  nonIntKeys: {
    '.indexOn': ['rank'],
  },
  intKeys: {
    '.indexOn': ['rank'],
  },
};

export async function observeQueryChainingAndForEachOrder(
  sdk: QueryChainingAndForEachProbeSdk,
  basePath: string,
): Promise<{
  chainedVsFlatRangeLimit: {
    chained: OrderedRankSummary;
    flat: OrderedRankSummary;
    queriesEqual: boolean;
  };
  forEachOrderVsValNonIntegerKeys: {
    get: OrderedRankSummary;
    onValue: OrderedRankSummary;
  };
  forEachOrderVsValSparseIntegerKeys: {
    get: OrderedRankSummary;
    onValue: OrderedRankSummary;
  };
}> {
  const { db, ref, set, get, onValue, query, orderByChild, startAt, endAt, limitToFirst } = sdk;

  const chainedRef = ref(db, `${basePath}/chained`);
  await set(chainedRef, {
    d: { rank: 40 },
    a: { rank: 10 },
    c: { rank: 30 },
    b: { rank: 20 },
    e: { rank: 50 },
  });

  const chainedQuery = query(
    query(query(chainedRef, orderByChild('rank')), startAt(20)),
    endAt(40),
    limitToFirst(2),
  );
  const flatQuery = query(
    chainedRef,
    orderByChild('rank'),
    startAt(20),
    endAt(40),
    limitToFirst(2),
  );

  const chainedSummary = summarizeRankSnapshot(await get(chainedQuery));
  const flatSummary = summarizeRankSnapshot(await get(flatQuery));

  const nonIntRef = ref(db, `${basePath}/nonIntKeys`);
  await set(nonIntRef, {
    z: { rank: 10 },
    a: { rank: 20 },
    m: { rank: 30 },
  });
  const nonIntQuery = query(nonIntRef, orderByChild('rank'));

  const intRef = ref(db, `${basePath}/intKeys`);
  await set(intRef, {
    '1': { rank: 30 },
    '2': { rank: 10 },
    '10': { rank: 20 },
  });
  const intQuery = query(intRef, orderByChild('rank'));

  return {
    chainedVsFlatRangeLimit: {
      chained: chainedSummary,
      flat: flatSummary,
      queriesEqual: chainedQuery.isEqual(flatQuery),
    },
    forEachOrderVsValNonIntegerKeys: {
      get: summarizeRankSnapshot(await get(nonIntQuery)),
      onValue: await readInitialRankOnValue(onValue, nonIntQuery),
    },
    forEachOrderVsValSparseIntegerKeys: {
      get: summarizeRankSnapshot(await get(intQuery)),
      onValue: await readInitialRankOnValue(onValue, intQuery),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'RTDB modular nested query(query(ref, c1), c2) constraint folding parity with flat query() and DataSnapshot.forEach() executor sort order vs Object.keys(snap.val()) across non-integer and sparse integer keys.',
  async observe() {
    return withRtdbProbeSession({ runRules: RUN_RULES }, async ({ db, runPath, rtdbSdk }) => {
      return observeQueryChainingAndForEachOrder(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          get: rtdbSdk.get,
          onValue: rtdbSdk.onValue,
          query: rtdbSdk.query,
          orderByChild: rtdbSdk.orderByChild,
          startAt: rtdbSdk.startAt,
          endAt: rtdbSdk.endAt,
          limitToFirst: rtdbSdk.limitToFirst,
        },
        runPath,
      );
    });
  },
};
