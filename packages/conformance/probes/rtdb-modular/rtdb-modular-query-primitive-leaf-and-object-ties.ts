import type { DataSnapshot, Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface PrimitiveLeafAndObjectTiesProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  get: typeof import('firebase/database').get;
  onValue: typeof import('firebase/database').onValue;
  query: typeof import('firebase/database').query;
  orderByKey: typeof import('firebase/database').orderByKey;
  orderByValue: typeof import('firebase/database').orderByValue;
  startAt: typeof import('firebase/database').startAt;
  limitToFirst: typeof import('firebase/database').limitToFirst;
}

interface LeafQuerySummary {
  exists: boolean;
  size: number;
  val: unknown;
  forEachKeys: string[];
}

function summarizeLeafQuery(snap: DataSnapshot): LeafQuerySummary {
  const forEachKeys: string[] = [];
  snap.forEach((child) => {
    if (child.key !== null) {
      forEachKeys.push(child.key);
    }
    return false;
  });
  return {
    exists: snap.exists(),
    size: snap.size,
    val: snap.val(),
    forEachKeys,
  };
}

function collectOrderedKeys(snap: DataSnapshot): string[] {
  const keys: string[] = [];
  snap.forEach((child) => {
    if (child.key !== null) {
      keys.push(child.key);
    }
    return false;
  });
  return keys;
}

const RUN_RULES: Record<string, unknown> = {
  '.read': 'auth != null',
  '.write': 'auth != null',
  leafNum: {
    '.indexOn': '.value',
  },
  objTies: {
    '.indexOn': '.value',
  },
};

export async function observeQueryPrimitiveLeafAndObjectTies(
  sdk: PrimitiveLeafAndObjectTiesProbeSdk,
  basePath: string,
): Promise<{
  primitiveLeafOrderByKeyUnfiltered: LeafQuerySummary;
  primitiveLeafOrderByValueUnfiltered: LeafQuerySummary;
  primitiveLeafLimited: LeafQuerySummary;
  primitiveLeafBounded: LeafQuerySummary;
  objectChildrenOrderByValueKeys: string[];
  keyReorderedRewriteDelivery: {
    fireCount: number;
    deliveredKeysPerFire: string[][];
    bFieldASequence: number[];
  };
}> {
  const { db, ref, set, get, onValue, query, orderByKey, orderByValue, startAt, limitToFirst } =
    sdk;

  const leafRef = ref(db, `${basePath}/leafNum`);
  await set(leafRef, 42);

  const primitiveLeafOrderByKeyUnfiltered = summarizeLeafQuery(
    await get(query(leafRef, orderByKey())),
  );
  const primitiveLeafOrderByValueUnfiltered = summarizeLeafQuery(
    await get(query(leafRef, orderByValue())),
  );
  const primitiveLeafLimited = summarizeLeafQuery(
    await get(query(leafRef, orderByKey(), limitToFirst(1))),
  );
  const primitiveLeafBounded = summarizeLeafQuery(
    await get(query(leafRef, orderByKey(), startAt('a'))),
  );

  const objTiesRef = ref(db, `${basePath}/objTies`);
  await set(objTiesRef, {
    '10': { a: 1 },
    '2': { z: 9 },
    a: { z: 1, m: 2 },
    b: { a: 1, m: 2 },
  });

  const objOrderQuery = query(objTiesRef, orderByValue());
  const objectChildrenOrderByValueKeys = collectOrderedKeys(await get(objOrderQuery));

  const deliveredKeysPerFire: string[][] = [];
  const bFieldASequence: number[] = [];
  let resolveInitial: (() => void) | undefined;
  let rejectInitial: ((err: unknown) => void) | undefined;
  let resolveSentinel: (() => void) | undefined;
  let rejectSentinel: ((err: unknown) => void) | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let sentinelTimer: ReturnType<typeof setTimeout> | undefined;

  const initialReady = new Promise<void>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
    initialTimer = setTimeout(() => {
      reject(new Error('Timed out waiting for initial onValue(orderByValue) object-ties snapshot'));
    }, 8_000);
  });
  const sentinelReady = new Promise<void>((resolve, reject) => {
    resolveSentinel = resolve;
    rejectSentinel = reject;
  });

  const unsubscribe = onValue(
    objOrderQuery,
    (snap) => {
      deliveredKeysPerFire.push(collectOrderedKeys(snap));
      const bVal = snap.child('b').val() as { a?: unknown } | null;
      if (bVal && typeof bVal.a === 'number') {
        bFieldASequence.push(bVal.a);
        if (bVal.a === 1 && resolveInitial !== undefined) {
          resolveInitial();
        }
        if (bVal.a === 2 && resolveSentinel !== undefined) {
          resolveSentinel();
        }
      }
    },
    (err) => {
      if (rejectInitial !== undefined) {
        rejectInitial(err);
      }
      if (rejectSentinel !== undefined) {
        rejectSentinel(err);
      }
    },
  );

  try {
    await initialReady;
    if (initialTimer !== undefined) {
      clearTimeout(initialTimer);
      initialTimer = undefined;
    }
    sentinelTimer = setTimeout(() => {
      if (rejectSentinel !== undefined) {
        rejectSentinel(
          new Error('Timed out waiting for sentinel onValue(orderByValue) object-ties snapshot'),
        );
      }
    }, 8_000);
    await set(ref(db, `${basePath}/objTies/a`), { m: 2, z: 1 });
    await set(ref(db, `${basePath}/objTies/b`), { a: 2, m: 2 });
    await sentinelReady;
  } finally {
    if (initialTimer !== undefined) {
      clearTimeout(initialTimer);
    }
    if (sentinelTimer !== undefined) {
      clearTimeout(sentinelTimer);
    }
    unsubscribe();
  }

  return {
    primitiveLeafOrderByKeyUnfiltered,
    primitiveLeafOrderByValueUnfiltered,
    primitiveLeafLimited,
    primitiveLeafBounded,
    objectChildrenOrderByValueKeys,
    keyReorderedRewriteDelivery: {
      fireCount: deliveredKeysPerFire.length,
      deliveredKeysPerFire,
      bFieldASequence,
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
    'RTDB modular query behavior on a primitive scalar leaf (unfiltered vs bounded/limited) and orderByValue() nameCompare tie-breaking plus no-change suppression on object-valued children.',
  async observe() {
    return withRtdbProbeSession({ runRules: RUN_RULES }, async ({ db, runPath, rtdbSdk }) => {
      return observeQueryPrimitiveLeafAndObjectTies(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          get: rtdbSdk.get,
          onValue: rtdbSdk.onValue,
          query: rtdbSdk.query,
          orderByKey: rtdbSdk.orderByKey,
          orderByValue: rtdbSdk.orderByValue,
          startAt: rtdbSdk.startAt,
          limitToFirst: rtdbSdk.limitToFirst,
        },
        runPath,
      );
    });
  },
};
