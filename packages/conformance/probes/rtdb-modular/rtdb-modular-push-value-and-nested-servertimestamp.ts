import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface PushAndNestedServerTimestampSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  child: typeof import('firebase/database').child;
  set: typeof import('firebase/database').set;
  update: typeof import('firebase/database').update;
  push: typeof import('firebase/database').push;
  get: typeof import('firebase/database').get;
  serverTimestamp: typeof import('firebase/database').serverTimestamp;
}

export async function observePushValueAndNestedServerTimestamp(
  sdk: PushAndNestedServerTimestampSdk,
  basePath: string,
): Promise<{
  pushWithValue: {
    keyStartsWithHyphen: boolean;
    keyLength: number | null;
    directGetVal: unknown;
    viaParentChildGetVal: unknown;
    parentSize: number;
  };
  serverTimestampSentinelMarker: {
    markerShape: unknown;
  };
  nestedMultiPathServerTimestamp: {
    topAuditUpdatedIsInteger: boolean;
    deepItemTouchedIsInteger: boolean;
    bothWithinPlausibleWindow: boolean;
    bothEqualInSingleAtomicUpdate: boolean;
    preservedSiblingField: unknown;
    deepNonSentinelField: unknown;
  };
}> {
  const { db, ref, child, set, update, push, get, serverTimestamp } = sdk;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scope = 'pushAndSv';
  if (cleanBase) {
    scope = `${cleanBase}/pushAndSv`;
  }

  const listRef = ref(db, `${scope}/tasks`);
  const pushedRef = push(listRef, { title: 'ship-probes', done: false });
  const mintedKey = pushedRef.key;
  await pushedRef;

  const directPushedSnap = await get(pushedRef);
  let viaParentVal: unknown = null;
  if (mintedKey !== null) {
    const viaChildSnap = await get(child(listRef, mintedKey));
    viaParentVal = viaChildSnap.val();
  }
  const parentListSnap = await get(listRef);

  let keyStartsWithHyphen = false;
  let keyLength: number | null = null;
  if (typeof mintedKey === 'string') {
    keyStartsWithHyphen = mintedKey.startsWith('-');
    keyLength = mintedKey.length;
  }

  const markerShape = serverTimestamp();

  const docRef = ref(db, `${scope}/doc`);
  await set(docRef, {
    keep: 'preserved',
    audit: { actor: 'u1' },
    items: { a: { label: 'old' } },
  });

  const beforeMs = Date.now();
  await update(docRef, {
    'audit/updatedAt': serverTimestamp(),
    'items/a': {
      label: 'updated',
      meta: { touchedAt: serverTimestamp() },
    },
  });
  const afterMs = Date.now();

  const docSnap = await get(docRef);
  const docVal = docSnap.val() as {
    keep?: unknown;
    audit?: { actor?: unknown; updatedAt?: unknown };
    items?: { a?: { label?: unknown; meta?: { touchedAt?: unknown } } };
  };

  const tsTop = docVal.audit?.updatedAt;
  const tsDeep = docVal.items?.a?.meta?.touchedAt;

  const topAuditUpdatedIsInteger = typeof tsTop === 'number' && Number.isInteger(tsTop);
  const deepItemTouchedIsInteger = typeof tsDeep === 'number' && Number.isInteger(tsDeep);
  let bothWithinPlausibleWindow = false;
  let bothEqualInSingleAtomicUpdate = false;
  if (typeof tsTop === 'number' && typeof tsDeep === 'number') {
    bothWithinPlausibleWindow =
      tsTop >= beforeMs - 60_000 &&
      tsTop <= afterMs + 60_000 &&
      tsDeep >= beforeMs - 60_000 &&
      tsDeep <= afterMs + 60_000;
    bothEqualInSingleAtomicUpdate = tsTop === tsDeep;
  }

  return {
    pushWithValue: {
      keyStartsWithHyphen,
      keyLength,
      directGetVal: directPushedSnap.val(),
      viaParentChildGetVal: viaParentVal,
      parentSize: parentListSnap.size,
    },
    serverTimestampSentinelMarker: {
      markerShape,
    },
    nestedMultiPathServerTimestamp: {
      topAuditUpdatedIsInteger,
      deepItemTouchedIsInteger,
      bothWithinPlausibleWindow,
      bothEqualInSingleAtomicUpdate,
      preservedSiblingField: docVal.keep,
      deepNonSentinelField: docVal.items?.a?.label,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'Modular RTDB push(ref, value) child write and serverTimestamp() sentinel marker ({ ".sv": "timestamp" }) plus resolution when nested deep inside multi-path update() payloads.',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observePushValueAndNestedServerTimestamp(
        {
          db,
          ref: rtdbSdk.ref,
          child: rtdbSdk.child,
          set: rtdbSdk.set,
          update: rtdbSdk.update,
          push: rtdbSdk.push,
          get: rtdbSdk.get,
          serverTimestamp: rtdbSdk.serverTimestamp,
        },
        runPath,
      );
    });
  },
};
