import type { DataSnapshot, Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface ArrayWriteNormalizationSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  child: typeof import('firebase/database').child;
  set: typeof import('firebase/database').set;
  get: typeof import('firebase/database').get;
}

interface ChildIterationEntry {
  key: string | null;
  val: unknown;
}

function collectForEachEntries(snap: DataSnapshot): ChildIterationEntry[] {
  const entries: ChildIterationEntry[] = [];
  snap.forEach((childSnap) => {
    entries.push({ key: childSnap.key, val: childSnap.val() });
    return false;
  });
  return entries;
}

export async function observeArrayWriteNormalization(
  sdk: ArrayWriteNormalizationSdk,
  basePath: string,
): Promise<{
  denseArray: {
    isArray: boolean;
    val: unknown;
    exportVal: unknown;
    size: number;
    hasChildren: boolean;
    hasChild1: boolean;
    hasLeadingZeroChild01: boolean;
    directChild1Exists: boolean;
    directChild1Val: unknown;
    forEachEntries: ChildIterationEntry[];
    afterChild1OverwriteVal: unknown;
  };
  arrayWithNulls: {
    isArray: boolean;
    length: number | null;
    ownKeys: string[];
    hasIndex1InOperator: boolean;
    size: number;
    hasChild1: boolean;
    directChild1Exists: boolean;
    exportVal: unknown;
    forEachEntries: ChildIterationEntry[];
  };
}> {
  const { db, ref, child, set, get } = sdk;

  const denseRef = ref(db, `${basePath}/dense`);
  await set(denseRef, ['alpha', 'beta', 'gamma']);

  const denseSnap = await get(denseRef);
  const directChild1Snap = await get(child(denseRef, '1'));
  const denseVal = denseSnap.val();

  await set(child(denseRef, '1'), 'BETA');
  const updatedDenseSnap = await get(denseRef);

  const nullsRef = ref(db, `${basePath}/withNulls`);
  await set(nullsRef, ['x', null, 'z', null]);

  const nullsSnap = await get(nullsRef);
  const nullsDirectChild1 = await get(child(nullsRef, '1'));
  const nullsVal = nullsSnap.val();

  let nullsLength: number | null = null;
  let nullsOwnKeys: string[] = [];
  let hasIndex1InOperator = false;
  if (Array.isArray(nullsVal)) {
    nullsLength = nullsVal.length;
    nullsOwnKeys = Object.keys(nullsVal);
    hasIndex1InOperator = 1 in nullsVal;
  }

  return {
    denseArray: {
      isArray: Array.isArray(denseVal),
      val: denseVal,
      exportVal: denseSnap.exportVal(),
      size: denseSnap.size,
      hasChildren: denseSnap.hasChildren(),
      hasChild1: denseSnap.hasChild('1'),
      hasLeadingZeroChild01: denseSnap.hasChild('01'),
      directChild1Exists: directChild1Snap.exists(),
      directChild1Val: directChild1Snap.val(),
      forEachEntries: collectForEachEntries(denseSnap),
      afterChild1OverwriteVal: updatedDenseSnap.val(),
    },
    arrayWithNulls: {
      isArray: Array.isArray(nullsVal),
      length: nullsLength,
      ownKeys: nullsOwnKeys,
      hasIndex1InOperator,
      size: nullsSnap.size,
      hasChild1: nullsSnap.hasChild('1'),
      directChild1Exists: nullsDirectChild1.exists(),
      exportVal: nullsSnap.exportVal(),
      forEachEntries: collectForEachEntries(nullsSnap),
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'Modular RTDB write-boundary array normalization: arrays written via set() store integer-keyed children addressable via child(ref, "1"), iterate "0","1","2" in forEach(), prune interior and trailing null elements, and preserve keyed objects in exportVal().',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observeArrayWriteNormalization(
        {
          db,
          ref: rtdbSdk.ref,
          child: rtdbSdk.child,
          set: rtdbSdk.set,
          get: rtdbSdk.get,
        },
        `${runPath}/array-write-norm`,
      );
    });
  },
};
