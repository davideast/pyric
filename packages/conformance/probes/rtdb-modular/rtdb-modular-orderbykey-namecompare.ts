import type { DataSnapshot, Database, Query } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface OrderByKeyProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  get: typeof import('firebase/database').get;
  onValue: typeof import('firebase/database').onValue;
  query: typeof import('firebase/database').query;
  orderByKey: typeof import('firebase/database').orderByKey;
  startAt: typeof import('firebase/database').startAt;
  endAt: typeof import('firebase/database').endAt;
}

interface OrderedKeyWindowSummary {
  forEachKeys: string[];
  forEachValues: unknown[];
}

function summarizeOrderedKeys(snap: DataSnapshot): OrderedKeyWindowSummary {
  const forEachKeys: string[] = [];
  const forEachValues: unknown[] = [];
  snap.forEach((child) => {
    if (child.key !== null) {
      forEachKeys.push(child.key);
    }
    forEachValues.push(child.val());
    return false;
  });
  return { forEachKeys, forEachValues };
}

async function readFirstOnValue(
  onValueFn: typeof import('firebase/database').onValue,
  targetQuery: Query,
  timeoutMs = 8_000,
): Promise<OrderedKeyWindowSummary> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    return await new Promise<OrderedKeyWindowSummary>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Timed out waiting for initial onValue(orderByKey) snapshot'));
      }, timeoutMs);
      unsubscribe = onValueFn(
        targetQuery,
        (snap) => {
          resolve(summarizeOrderedKeys(snap));
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

export async function observeOrderByKeyNameCompare(
  sdk: OrderByKeyProbeSdk,
  basePath: string,
): Promise<{
  unfilteredMixedOrder: OrderedKeyWindowSummary;
  negativeAndLeadingZeroWindow: OrderedKeyWindowSummary;
  numericCursorWindowGet: OrderedKeyWindowSummary;
  numericCursorWindowOnValue: OrderedKeyWindowSummary;
}> {
  const { db, ref, set, get, onValue, query, orderByKey, startAt, endAt } = sdk;

  const mixedRef = ref(db, `${basePath}/mixed`);
  await set(mixedRef, {
    '10': 'j',
    '2': 'b',
    '1': 'a',
    '0': 'z0',
    '-2': 'neg2',
    '-10': 'neg10',
    '01': 'lead01',
    a: 'alpha',
    b: 'beta',
  });

  const unfilteredSnap = await get(query(mixedRef, orderByKey()));
  const negativeToLeadingZeroSnap = await get(
    query(mixedRef, orderByKey(), startAt('-2'), endAt('01')),
  );

  const cursorRef = ref(db, `${basePath}/cursor`);
  await set(cursorRef, {
    '1': 'a',
    '2': 'b',
    '10': 'j',
    '20': 't',
    b: 'z',
  });

  const cursorQuery = query(cursorRef, orderByKey(), startAt('2'), endAt('10'));
  const numericCursorGetSnap = await get(cursorQuery);
  const numericCursorWindowOnValue = await readFirstOnValue(onValue, cursorQuery);

  return {
    unfilteredMixedOrder: summarizeOrderedKeys(unfilteredSnap),
    negativeAndLeadingZeroWindow: summarizeOrderedKeys(negativeToLeadingZeroSnap),
    numericCursorWindowGet: summarizeOrderedKeys(numericCursorGetSnap),
    numericCursorWindowOnValue,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: 'rtdb-modular#M50',
  rowIds: ['rtdb-modular#M50'],
  description:
    'RTDB modular orderByKey() nameCompare ordering across negative, zero, leading-zero, multi-digit integer, and non-integer keys plus startAt/endAt numeric-key cursor windows on get() and onValue().',
  async observe() {
    return withRtdbProbeSession({}, async ({ db, runPath, rtdbSdk }) => {
      return observeOrderByKeyNameCompare(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          get: rtdbSdk.get,
          onValue: rtdbSdk.onValue,
          query: rtdbSdk.query,
          orderByKey: rtdbSdk.orderByKey,
          startAt: rtdbSdk.startAt,
          endAt: rtdbSdk.endAt,
        },
        runPath,
      );
    });
  },
};
