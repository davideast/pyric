import type { DataSnapshot, Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface TieBreakerAndMissingChildProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  get: typeof import('firebase/database').get;
  query: typeof import('firebase/database').query;
  orderByChild: typeof import('firebase/database').orderByChild;
  startAt: typeof import('firebase/database').startAt;
  endAt: typeof import('firebase/database').endAt;
}

function collectKeys(snap: DataSnapshot): string[] {
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
  ties: {
    '.indexOn': ['pos'],
  },
  missingField: {
    '.indexOn': ['pos', 'meta/score'],
  },
};

export async function observeStartAtKeyTieBreakerAndMissingChild(
  sdk: TieBreakerAndMissingChildProbeSdk,
  basePath: string,
): Promise<{
  startAtKeyC: string[];
  startAtKeyTwoEndAtKeyB: string[];
  missingDirectChildOrder: string[];
  missingNestedChildOrder: string[];
}> {
  const { db, ref, set, get, query, orderByChild, startAt, endAt } = sdk;

  const tiesRef = ref(db, `${basePath}/ties`);
  await set(tiesRef, {
    '2': { pos: 1 },
    '10': { pos: 1 },
    a: { pos: 1 },
    b: { pos: 1 },
    c: { pos: 1 },
    d: { pos: 1 },
    e: { pos: 2 },
  });

  const startAtKeyCSnap = await get(query(tiesRef, orderByChild('pos'), startAt(1, 'c')));
  const boundedTieWindowSnap = await get(
    query(tiesRef, orderByChild('pos'), startAt(1, '2'), endAt(1, 'b')),
  );

  const missingRef = ref(db, `${basePath}/missingField`);
  await set(missingRef, {
    numZero: { pos: 0, meta: { score: 0 } },
    boolFalse: { pos: false, meta: { score: false } },
    strEmpty: { pos: '', meta: { score: '' } },
    absentObj: { other: 'x' },
    scalarChild: 'leaf',
  });

  const directMissingSnap = await get(query(missingRef, orderByChild('pos')));
  const nestedMissingSnap = await get(query(missingRef, orderByChild('meta/score')));

  return {
    startAtKeyC: collectKeys(startAtKeyCSnap),
    startAtKeyTwoEndAtKeyB: collectKeys(boundedTieWindowSnap),
    missingDirectChildOrder: collectKeys(directMissingSnap),
    missingNestedChildOrder: collectKeys(nestedMissingSnap),
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: 'rtdb-modular#M62',
  rowIds: ['rtdb-modular#M62', 'rtdb-modular#M63'],
  description:
    'RTDB modular startAt(value, key) and endAt(value, key) inclusive nameCompare tie-breaking on equal child values plus orderByChild() null-first ordering for missing direct and nested fields.',
  async observe() {
    return withRtdbProbeSession({ runRules: RUN_RULES }, async ({ db, runPath, rtdbSdk }) => {
      return observeStartAtKeyTieBreakerAndMissingChild(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          get: rtdbSdk.get,
          query: rtdbSdk.query,
          orderByChild: rtdbSdk.orderByChild,
          startAt: rtdbSdk.startAt,
          endAt: rtdbSdk.endAt,
        },
        runPath,
      );
    });
  },
};
