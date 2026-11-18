import type {
  Database as AdminDatabase,
  DataSnapshot as AdminDataSnapshot,
  Query as AdminQuery,
} from 'firebase-admin/database';
import type { Probe } from '../../rigs/types.ts';
import { RTDB_RULES_SCOPE } from '../../src/oracle-access-token.ts';
import { loadOracleServiceAccount, oracleAccessToken } from '../../src/oracle-credential.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export const ADMIN_QUERY_PROBE_RULES = {
  adminQuery: {
    indexedItems: {
      '.indexOn': ['score', 'meta/rank'],
    },
    indexedScalars: {
      '.indexOn': '.value',
    },
    windowItems: {
      '.indexOn': ['rank'],
    },
  },
} as const;

export interface UnindexedOrderCheck {
  getResolved: boolean;
  getKeys: string[] | null;
  getCode: string | null;
  getMessage: string | null;
  onceResolved: boolean;
  onceKeys: string[];
}

export interface QueryGetAndOnceKeys {
  getKeys: string[];
  onceKeys: string[];
}

export interface ContextValueDelivery {
  tag: string | null;
  val: unknown;
}

export interface WindowChildEventRecord {
  event: 'child_added' | 'child_changed' | 'child_moved' | 'child_removed';
  key: string | null;
  prevKey: string | null;
  val: unknown;
  tag: string | null;
}

export function scrubAdminQueryError(rawMessage: string, cleanBase: string): string {
  let out = rawMessage;
  if (cleanBase) {
    out = out
      .split(`/${cleanBase}`)
      .join('/<base>')
      .split(cleanBase)
      .join('<base>');
  }
  return out
    .replace(/\/pyric_oracle\/rtdb_[a-z0-9_-]+/gi, '/<base>')
    .replace(/https?:\/\/[a-z0-9.-]+\.(?:firebaseio\.com|firebasedatabase\.app)/gi, 'https://<db-host>');
}

function snapshotKeys(snap: AdminDataSnapshot): string[] {
  const keys: string[] = [];
  snap.forEach((childSnap) => {
    if (childSnap.key !== null) {
      keys.push(childSnap.key);
    }
    return false;
  });
  return keys;
}

async function readGetAndOnceKeys(query: AdminQuery): Promise<QueryGetAndOnceKeys> {
  const getSnap = await query.get();
  const onceSnap = await query.once('value');
  return {
    getKeys: snapshotKeys(getSnap),
    onceKeys: snapshotKeys(onceSnap),
  };
}

async function checkUnindexedOrder(
  query: AdminQuery,
  cleanBase: string,
): Promise<UnindexedOrderCheck> {
  let getResolved = false;
  let getKeys: string[] | null = null;
  let getCode: string | null = null;
  let getMessage: string | null = null;

  try {
    const snap = await query.get();
    getResolved = true;
    getKeys = snapshotKeys(snap);
  } catch (err) {
    getResolved = false;
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      getCode = rawCode;
    }
    getMessage = scrubAdminQueryError((err as Error).message, cleanBase);
  }

  const onceSnap = await query.once('value');
  return {
    getResolved,
    getKeys,
    getCode,
    getMessage,
    onceResolved: true,
    onceKeys: snapshotKeys(onceSnap),
  };
}

export async function observeAdminQueryBoundsListenersAndContext(
  adminDb: Pick<AdminDatabase, 'ref'>,
  basePath: string,
  seedRankedPriorities: (rankedSubpath: string) => Promise<void>,
): Promise<{
  unindexedGetChecks: {
    orderByChild: UnindexedOrderCheck;
    orderByValue: UnindexedOrderCheck;
    orderByKey: UnindexedOrderCheck;
    orderByPriority: UnindexedOrderCheck;
  };
  indexedQueriesAndBounds: {
    orderByChildScoreAll: QueryGetAndOnceKeys;
    orderByNestedChildAll: QueryGetAndOnceKeys;
    inclusiveRangeStartAtEndAt: QueryGetAndOnceKeys;
    exclusiveRangeStartAfterEndBefore: QueryGetAndOnceKeys;
    cursorStartAtWithKey: QueryGetAndOnceKeys;
    cursorStartAfterWithKey: QueryGetAndOnceKeys;
    cursorEndAtWithKey: QueryGetAndOnceKeys;
    cursorEndBeforeWithKey: QueryGetAndOnceKeys;
    equalToValue: QueryGetAndOnceKeys;
    equalToValueAndKey: QueryGetAndOnceKeys;
    limitToFirstTwo: QueryGetAndOnceKeys;
    limitToLastTwo: QueryGetAndOnceKeys;
    orderByKeyNumericAndLexical: QueryGetAndOnceKeys;
    orderByKeyBounded: QueryGetAndOnceKeys;
    orderByKeyEqualTo: QueryGetAndOnceKeys;
    orderByValueMixedTypesAll: QueryGetAndOnceKeys;
    orderByValueEqualTo: QueryGetAndOnceKeys;
    orderByValueCursorAndLimitFirstTwo: QueryGetAndOnceKeys;
    orderByValueLimitLastTwo: QueryGetAndOnceKeys;
    orderByPriorityAll: QueryGetAndOnceKeys;
    orderByPriorityBounded: QueryGetAndOnceKeys;
    defaultOrderLimitFirstTwo: QueryGetAndOnceKeys;
  };
  onceContextBinding: {
    threeArgTag: string | null;
    threeArgKeys: string[];
    fourArgTag: string | null;
    fourArgKeys: string[];
    promiseMatchedCallbackKeys: boolean;
  };
  valueContextAndScopedOff: {
    returnedOriginalCallback: boolean;
    initialDeliveries: ContextValueDelivery[];
    afterOffCtxA: ContextValueDelivery[];
    afterOffContextless: ContextValueDelivery[];
    afterOffAllValue: ContextValueDelivery[];
  };
  queryChildWindowAndZeroArgOff: {
    initialWindowAdded: WindowChildEventRecord[];
    afterInWindowReorderAndChange: WindowChildEventRecord[];
    afterWindowEvictAndEnter: WindowChildEventRecord[];
    countAfterZeroArgQueryOff: number;
  };
}> {
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let rootPrefix = 'adminQuery';
  if (cleanBase) {
    rootPrefix = `${cleanBase}/adminQuery`;
  }

  // 1. Seed cold unindexed locations and record get() before once('value') across all 4 orderings.
  const unindexedItemsRef = adminDb.ref(`${rootPrefix}/unindexedItems`);
  await unindexedItemsRef.set({
    b: { score: 20 },
    a: { score: 10 },
    c: { score: 30 },
  });

  const unindexedScalarsRef = adminDb.ref(`${rootPrefix}/unindexedScalars`);
  await unindexedScalarsRef.set({
    k2: 20,
    k1: 10,
    k3: 30,
  });

  const rankedSubpath = 'adminQuery/rankedPriorities';
  const rankedRef = adminDb.ref(`${rootPrefix}/rankedPriorities`);
  await seedRankedPriorities(rankedSubpath);

  const unindexedOrderByChild = await checkUnindexedOrder(
    unindexedItemsRef.orderByChild('score'),
    cleanBase,
  );
  const unindexedOrderByValue = await checkUnindexedOrder(
    unindexedScalarsRef.orderByValue(),
    cleanBase,
  );
  const unindexedOrderByKey = await checkUnindexedOrder(
    unindexedItemsRef.orderByKey(),
    cleanBase,
  );
  const unindexedOrderByPriority = await checkUnindexedOrder(
    rankedRef.orderByPriority(),
    cleanBase,
  );

  // 2. Indexed orderByChild, orderByKey, orderByValue, and orderByPriority bounds/cursors/limits.
  const indexedItemsRef = adminDb.ref(`${rootPrefix}/indexedItems`);
  await indexedItemsRef.set({
    d: { score: 20, meta: { rank: 2 } },
    b: { score: 10, meta: { rank: 4 } },
    a: { score: 20, meta: { rank: 1 } },
    c: { meta: { rank: 3 } },
    e: { score: 30, meta: { rank: 5 } },
  });

  const byKeyRef = adminDb.ref(`${rootPrefix}/byKeyItems`);
  await byKeyRef.set({ b: 1, '10': 2, '2': 3, a: 4, c: 5 });

  const indexedScalarsRef = adminDb.ref(`${rootPrefix}/indexedScalars`);
  await indexedScalarsRef.set({
    s2: 'beta',
    n2: 5,
    b1: false,
    n1: 5,
    s1: 'alpha',
    b2: true,
    n0: -3,
  });

  const indexedQueriesAndBounds = {
    orderByChildScoreAll: await readGetAndOnceKeys(indexedItemsRef.orderByChild('score')),
    orderByNestedChildAll: await readGetAndOnceKeys(indexedItemsRef.orderByChild('meta/rank')),
    inclusiveRangeStartAtEndAt: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('score').startAt(10).endAt(20),
    ),
    exclusiveRangeStartAfterEndBefore: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('score').startAfter(10).endBefore(30),
    ),
    cursorStartAtWithKey: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('score').startAt(20, 'd'),
    ),
    cursorStartAfterWithKey: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('score').startAfter(20, 'a'),
    ),
    cursorEndAtWithKey: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('score').endAt(20, 'a'),
    ),
    cursorEndBeforeWithKey: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('score').endBefore(20, 'd'),
    ),
    equalToValue: await readGetAndOnceKeys(indexedItemsRef.orderByChild('score').equalTo(20)),
    equalToValueAndKey: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('score').equalTo(20, 'd'),
    ),
    limitToFirstTwo: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('meta/rank').limitToFirst(2),
    ),
    limitToLastTwo: await readGetAndOnceKeys(
      indexedItemsRef.orderByChild('meta/rank').limitToLast(2),
    ),
    orderByKeyNumericAndLexical: await readGetAndOnceKeys(byKeyRef.orderByKey()),
    orderByKeyBounded: await readGetAndOnceKeys(
      byKeyRef.orderByKey().startAfter('2').endBefore('c'),
    ),
    orderByKeyEqualTo: await readGetAndOnceKeys(byKeyRef.orderByKey().equalTo('a')),
    orderByValueMixedTypesAll: await readGetAndOnceKeys(indexedScalarsRef.orderByValue()),
    orderByValueEqualTo: await readGetAndOnceKeys(indexedScalarsRef.orderByValue().equalTo(5)),
    orderByValueCursorAndLimitFirstTwo: await readGetAndOnceKeys(
      indexedScalarsRef.orderByValue().startAt(5, 'n2').limitToFirst(2),
    ),
    orderByValueLimitLastTwo: await readGetAndOnceKeys(
      indexedScalarsRef.orderByValue().limitToLast(2),
    ),
    orderByPriorityAll: await readGetAndOnceKeys(rankedRef.orderByPriority()),
    orderByPriorityBounded: await readGetAndOnceKeys(
      rankedRef.orderByPriority().startAt(10).endAt(30),
    ),
    defaultOrderLimitFirstTwo: await readGetAndOnceKeys(rankedRef.limitToFirst(2)),
  };

  // 3. once('value') 3-arg and 4-arg context `this`-binding.
  let threeArgTag: string | null = null;
  let threeArgCbKeys: string[] = [];
  const ctxOnce3 = { tag: 'once-ctx-3' };
  const onceSnap3 = await indexedItemsRef.orderByChild('score').equalTo(20).once(
    'value',
    function onOnce3(this: { tag?: string } | undefined, snap: AdminDataSnapshot) {
      if (this && typeof this.tag === 'string') {
        threeArgTag = this.tag;
      }
      threeArgCbKeys = snapshotKeys(snap);
    },
    ctxOnce3,
  );

  let fourArgTag: string | null = null;
  let fourArgCbKeys: string[] = [];
  const ctxOnce4 = { tag: 'once-ctx-4' };
  const onceSnap4 = await indexedItemsRef.orderByChild('score').equalTo(20).once(
    'value',
    function onOnce4(this: { tag?: string } | undefined, snap: AdminDataSnapshot) {
      if (this && typeof this.tag === 'string') {
        fourArgTag = this.tag;
      }
      fourArgCbKeys = snapshotKeys(snap);
    },
    function onOnceCancel() {
      // unused on authorized admin query
    },
    ctxOnce4,
  );

  const snap3Keys = snapshotKeys(onceSnap3);
  const snap4Keys = snapshotKeys(onceSnap4);
  const promiseMatchedCallbackKeys =
    JSON.stringify(snap3Keys) === JSON.stringify(threeArgCbKeys) &&
    JSON.stringify(snap4Keys) === JSON.stringify(fourArgCbKeys);

  // 4. Live sibling sentinel barrier for deterministic on/off context & child window observations.
  const sentinelRef = adminDb.ref(`${rootPrefix}/sentinel`);
  const ctxTargetRef = adminDb.ref(`${rootPrefix}/ctxTarget`);
  const windowItemsRef = adminDb.ref(`${rootPrefix}/windowItems`);
  await sentinelRef.set({ seq: 0 });
  await ctxTargetRef.set({ step: 1 });
  await windowItemsRef.set({
    d: { rank: 2 },
    b: { rank: 4 },
    a: { rank: 1 },
    c: { rank: 3 },
  });

  let sentinelLastSeq: number | null = null;
  let sentinelTarget: number | undefined;
  let sentinelResolve: (() => void) | undefined;

  const waitSentinelSeq = async (expectedSeq: number): Promise<void> => {
    if (sentinelLastSeq === expectedSeq) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        sentinelTarget = expectedSeq;
        sentinelResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for admin query sentinel seq=${expectedSeq}`));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      sentinelTarget = undefined;
      sentinelResolve = undefined;
    }
  };

  const advanceAndWaitSentinel = async (nextSeq: number): Promise<void> => {
    await sentinelRef.set({ seq: nextSeq });
    await waitSentinelSeq(nextSeq);
  };

  const windowQuery = windowItemsRef.orderByChild('rank').limitToFirst(2);
  try {
    sentinelRef.on('value', (snap) => {
      const raw = snap.val() as { seq?: unknown } | null;
      if (raw && typeof raw.seq === 'number') {
        sentinelLastSeq = raw.seq;
        if (sentinelTarget !== undefined && raw.seq === sentinelTarget && sentinelResolve) {
          sentinelResolve();
        }
      }
    });
    await waitSentinelSeq(0);

    const valueBuffer: ContextValueDelivery[] = [];
    function sharedValueHandler(this: { tag?: string } | undefined, snap: AdminDataSnapshot): void {
      let tag: string | null = null;
      if (this && typeof this.tag === 'string') {
        tag = this.tag;
      }
      valueBuffer.push({ tag, val: snap.val() });
    }
    function noopCancel(): void {
      // unused on admin listener
    }

    const ctxA = { tag: 'ctx-A' };
    const ctxB = { tag: 'ctx-B' };
    const retA = ctxTargetRef.on('value', sharedValueHandler, ctxA);
    const retB = ctxTargetRef.on('value', sharedValueHandler, noopCancel, ctxB);
    const retNoCtx = ctxTargetRef.on('value', sharedValueHandler);
    const returnedOriginalCallback =
      retA === sharedValueHandler &&
      retB === sharedValueHandler &&
      retNoCtx === sharedValueHandler;

    await advanceAndWaitSentinel(1);
    const initialDeliveries = [...valueBuffer];

    valueBuffer.length = 0;
    ctxTargetRef.off('value', sharedValueHandler, ctxA);
    await ctxTargetRef.set({ step: 2 });
    await advanceAndWaitSentinel(2);
    const afterOffCtxA = [...valueBuffer];

    valueBuffer.length = 0;
    ctxTargetRef.off('value', sharedValueHandler);
    await ctxTargetRef.set({ step: 3 });
    await advanceAndWaitSentinel(3);
    const afterOffContextless = [...valueBuffer];

    valueBuffer.length = 0;
    ctxTargetRef.off('value');
    await ctxTargetRef.set({ step: 4 });
    await advanceAndWaitSentinel(4);
    const afterOffAllValue = [...valueBuffer];

    // 5. Query child window listeners (child_added/changed/moved/removed) with 4-arg context + 0-arg off().
    const windowBuffer: WindowChildEventRecord[] = [];
    const ctxWindow = { tag: 'win-ctx' };
    const recordWindowEvent = (
      event: WindowChildEventRecord['event'],
    ) => {
      return function onChildEvent(
        this: { tag?: string } | undefined,
        snap: AdminDataSnapshot,
        prevChildKey?: string | null,
      ): void {
        let tag: string | null = null;
        if (this && typeof this.tag === 'string') {
          tag = this.tag;
        }
        let prevKey: string | null = null;
        if (typeof prevChildKey === 'string') {
          prevKey = prevChildKey;
        }
        windowBuffer.push({
          event,
          key: snap.key,
          prevKey,
          val: snap.val(),
          tag,
        });
      };
    };

    windowQuery.on('child_added', recordWindowEvent('child_added'), noopCancel, ctxWindow);
    windowQuery.on('child_changed', recordWindowEvent('child_changed'), noopCancel, ctxWindow);
    windowQuery.on('child_moved', recordWindowEvent('child_moved'), noopCancel, ctxWindow);
    windowQuery.on('child_removed', recordWindowEvent('child_removed'), noopCancel, ctxWindow);

    await advanceAndWaitSentinel(5);
    const initialWindowAdded = [...windowBuffer];

    windowBuffer.length = 0;
    await windowItemsRef.child('d/rank').set(0);
    await advanceAndWaitSentinel(6);
    const afterInWindowReorderAndChange = [...windowBuffer];

    windowBuffer.length = 0;
    await windowItemsRef.child('a/rank').set(9);
    await advanceAndWaitSentinel(7);
    const afterWindowEvictAndEnter = [...windowBuffer];

    windowBuffer.length = 0;
    windowQuery.off();
    await windowItemsRef.child('c/rank').set(-5);
    await advanceAndWaitSentinel(8);
    const countAfterZeroArgQueryOff = windowBuffer.length;

    return {
      unindexedGetChecks: {
        orderByChild: unindexedOrderByChild,
        orderByValue: unindexedOrderByValue,
        orderByKey: unindexedOrderByKey,
        orderByPriority: unindexedOrderByPriority,
      },
      indexedQueriesAndBounds,
      onceContextBinding: {
        threeArgTag,
        threeArgKeys: threeArgCbKeys,
        fourArgTag,
        fourArgKeys: fourArgCbKeys,
        promiseMatchedCallbackKeys,
      },
      valueContextAndScopedOff: {
        returnedOriginalCallback,
        initialDeliveries,
        afterOffCtxA,
        afterOffContextless,
        afterOffAllValue,
      },
      queryChildWindowAndZeroArgOff: {
        initialWindowAdded,
        afterInWindowReorderAndChange,
        afterWindowEvictAndEnter,
        countAfterZeroArgQueryOff,
      },
    };
  } finally {
    windowQuery.off();
    ctxTargetRef.off();
    sentinelRef.off();
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'firebase-admin/database Query ordering (orderByChild, orderByKey, orderByValue, orderByPriority), unindexed vs indexed get()/once("value"), cursor bounds/limits, 3-arg and 4-arg context this-binding on once/on, scoped off(eventType, cb, context), and windowed child_* events.',
  matrixRow: 'rtdb-admin#5',
  rowIds: ['rtdb-admin#5'],
  observe() {
    return withRtdbProbeSession(
      { runRules: { ...ADMIN_QUERY_PROBE_RULES } },
      async ({ runId, runPath, databaseUrl, adminWrite }) => {
        const [adminAppMod, { getDatabaseWithUrl }] = await Promise.all([
          import('firebase-admin/app'),
          import('firebase-admin/database'),
        ]);
        const sa = await loadOracleServiceAccount();
        const adminApp = adminAppMod.initializeApp(
          {
            credential: {
              getAccessToken: async () => ({
                access_token: await oracleAccessToken(sa, RTDB_RULES_SCOPE),
                expires_in: 3600,
              }),
            },
            projectId: sa.project_id,
            databaseURL: databaseUrl,
          },
          `sdk-probe-rtdb-admin-query-${runId}`,
        );
        const adminDb = getDatabaseWithUrl(databaseUrl, adminApp);
        try {
          return await observeAdminQueryBoundsListenersAndContext(
            adminDb,
            runPath,
            async (rankedSubpath) => {
              await adminWrite(rankedSubpath, {
                k1: { label: 'one', '.priority': 30 },
                k2: { label: 'two', '.priority': 10 },
                k3: { label: 'no-prio' },
                k4: { label: 'str-prio', '.priority': 'high' },
              });
            },
          );
        } finally {
          adminDb.goOffline();
          await adminAppMod.deleteApp(adminApp).catch(() => undefined);
        }
      },
    );
  },
};
