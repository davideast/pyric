import type { DataSnapshot, Database, Query } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface EmptyAndOversizedWindowProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  get: typeof import('firebase/database').get;
  onValue: typeof import('firebase/database').onValue;
  query: typeof import('firebase/database').query;
  orderByChild: typeof import('firebase/database').orderByChild;
  orderByKey: typeof import('firebase/database').orderByKey;
  equalTo: typeof import('firebase/database').equalTo;
  limitToFirst: typeof import('firebase/database').limitToFirst;
  limitToLast: typeof import('firebase/database').limitToLast;
}

interface QueryWindowSnapshotShape {
  exists: boolean;
  size: number;
  val: unknown;
  forEachKeys: string[];
}

function summarizeWindowShape(snap: DataSnapshot): QueryWindowSnapshotShape {
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

async function readInitialQueryOnValue(
  onValueFn: typeof import('firebase/database').onValue,
  targetQuery: Query,
  timeoutMs = 8_000,
): Promise<QueryWindowSnapshotShape> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await new Promise<QueryWindowSnapshotShape>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Timed out waiting for initial onValue(query) snapshot'));
      }, timeoutMs);
      unsubscribe = onValueFn(
        targetQuery,
        (snap) => {
          resolve(summarizeWindowShape(snap));
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
  items: {
    '.indexOn': ['group', 'pos'],
  },
  absent: {
    '.indexOn': ['pos'],
  },
};

export async function observeQueryEmptyAndOversizedWindow(
  sdk: EmptyAndOversizedWindowProbeSdk,
  basePath: string,
): Promise<{
  equalToNoMatchGet: QueryWindowSnapshotShape;
  equalToNoMatchOnValue: QueryWindowSnapshotShape;
  oversizedLimitToFirstGet: QueryWindowSnapshotShape;
  oversizedLimitToLastGet: QueryWindowSnapshotShape;
  absentPathInitialOnValue: QueryWindowSnapshotShape;
}> {
  const {
    db,
    ref,
    set,
    get,
    onValue,
    query,
    orderByChild,
    orderByKey,
    equalTo,
    limitToFirst,
    limitToLast,
  } = sdk;

  const itemsRef = ref(db, `${basePath}/items`);
  await set(itemsRef, {
    k1: { group: 'a', pos: 1 },
    k2: { group: 'b', pos: 2 },
  });

  const noMatchQuery = query(itemsRef, orderByChild('group'), equalTo('missing'));
  const equalToNoMatchGet = summarizeWindowShape(await get(noMatchQuery));
  const equalToNoMatchOnValue = await readInitialQueryOnValue(onValue, noMatchQuery);

  const oversizedFirstSnap = await get(query(itemsRef, orderByKey(), limitToFirst(10)));
  const oversizedLastSnap = await get(query(itemsRef, orderByChild('pos'), limitToLast(10)));

  const absentQuery = query(ref(db, `${basePath}/absent`), orderByChild('pos'), limitToFirst(3));
  const absentPathInitialOnValue = await readInitialQueryOnValue(onValue, absentQuery);

  return {
    equalToNoMatchGet,
    equalToNoMatchOnValue,
    oversizedLimitToFirstGet: summarizeWindowShape(oversizedFirstSnap),
    oversizedLimitToLastGet: summarizeWindowShape(oversizedLastSnap),
    absentPathInitialOnValue,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'RTDB modular query empty-match equalTo(), oversized limitToFirst()/limitToLast() windows, and initial onValue(query) snapshot shape on an absent path.',
  async observe() {
    return withRtdbProbeSession({ runRules: RUN_RULES }, async ({ db, runPath, rtdbSdk }) => {
      return observeQueryEmptyAndOversizedWindow(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          get: rtdbSdk.get,
          onValue: rtdbSdk.onValue,
          query: rtdbSdk.query,
          orderByChild: rtdbSdk.orderByChild,
          orderByKey: rtdbSdk.orderByKey,
          equalTo: rtdbSdk.equalTo,
          limitToFirst: rtdbSdk.limitToFirst,
          limitToLast: rtdbSdk.limitToLast,
        },
        runPath,
      );
    });
  },
};
