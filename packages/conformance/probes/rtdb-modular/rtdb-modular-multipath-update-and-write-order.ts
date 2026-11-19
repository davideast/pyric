import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface MultiPathUpdateProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  child: typeof import('firebase/database').child;
  set: typeof import('firebase/database').set;
  update: typeof import('firebase/database').update;
  remove: typeof import('firebase/database').remove;
  get: typeof import('firebase/database').get;
  onValue: typeof import('firebase/database').onValue;
}

export async function observeMultiPathUpdateAndWriteOrder(
  sdk: MultiPathUpdateProbeSdk,
  basePath: string,
  seedDeniedBranch: (subpath: string, value: unknown) => Promise<void>,
): Promise<{
  shallowMergeAndNullDelete: {
    afterShallowMerge: unknown;
    afterNullKeyDelete: unknown;
  };
  multiPathAtomicAllowed: {
    val: unknown;
  };
  multiPathAtomicPartialDenialRollback: {
    rejected: boolean;
    errorCode: string | null;
    allowedBranchUnchanged: unknown;
    deniedBranchUnchanged: unknown;
  };
  overlappingPathsRejectedBeforeWrite: {
    ancestorFirstThrewSync: boolean;
    ancestorFirstMessage: string | null;
    descendantFirstThrewSync: boolean;
    storedAfterOverlappingCalls: unknown;
  };
  singleClientWriteOrderAndListenerTiming: {
    updateThenChildSetVal: unknown;
    updateThenRemoveExists: boolean;
    listenerSawUpdateBeforeAwaitResolved: boolean;
    observedSequence: unknown[];
  };
}> {
  const { db, ref, child, set, update, remove, get, onValue } = sdk;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  const shallowRef = ref(db, `${prefix}shallow`);
  await set(shallowRef, { a: 1, b: 2, dropMe: 'old' });
  await update(shallowRef, { b: 20, c: 3 });
  const afterMergeSnap = await get(shallowRef);
  await update(shallowRef, { dropMe: null });
  const afterNullDeleteSnap = await get(shallowRef);

  const atomicAllowedRef = ref(db, `${prefix}atomicAllowed`);
  await set(atomicAllowedRef, {
    left: { keep: 'L', v: 1 },
    right: { keep: 'R', v: 1 },
  });
  await update(atomicAllowedRef, {
    'left/v': 10,
    'right/v': 20,
  });
  const atomicAllowedSnap = await get(atomicAllowedRef);

  await seedDeniedBranch('atomicMixed', {
    allowedBranch: { x: 1 },
    blockedBranch: { y: 1 },
  });
  const atomicMixedRef = ref(db, `${prefix}atomicMixed`);
  let partialDenialRejected = false;
  let partialDenialCode: string | null = null;
  try {
    await update(atomicMixedRef, {
      'allowedBranch/x': 99,
      'blockedBranch/y': 99,
    });
  } catch (err) {
    partialDenialRejected = true;
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      partialDenialCode = rawCode;
    }
  }
  const [allowedAfterDenial, blockedAfterDenial] = await Promise.all([
    get(ref(db, `${prefix}atomicMixed/allowedBranch`)),
    get(ref(db, `${prefix}atomicMixed/blockedBranch`)),
  ]);

  const overlapRef = ref(db, `${prefix}overlap`);
  await set(overlapRef, { a: { initial: true } });
  let ancestorFirstThrewSync = false;
  let ancestorFirstMessage: string | null = null;
  try {
    const p = update(overlapRef, { a: { x: 1 }, 'a/y': 2 });
    await p;
  } catch (err) {
    ancestorFirstThrewSync = true;
    ancestorFirstMessage = (err as Error).message;
  }
  // Check exact sync throw vs async reject for ancestor-first
  let syncCheck = false;
  try {
    const maybePromise = update(overlapRef, { a: { x: 1 }, 'a/y': 2 });
    if (
      maybePromise !== null &&
      typeof maybePromise === 'object' &&
      typeof (maybePromise as { catch?: unknown }).catch === 'function'
    ) {
      (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    syncCheck = true;
  }
  ancestorFirstThrewSync = syncCheck;

  let descendantFirstThrewSync = false;
  try {
    const maybePromise = update(overlapRef, { 'a/y': 2, a: { x: 1 } });
    if (
      maybePromise !== null &&
      typeof maybePromise === 'object' &&
      typeof (maybePromise as { catch?: unknown }).catch === 'function'
    ) {
      (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    descendantFirstThrewSync = true;
  }
  const overlapAfterSnap = await get(overlapRef);

  const orderRef = ref(db, `${prefix}order/doc`);
  await set(orderRef, { x: 1, keep: 'ok' });
  const p1 = update(orderRef, { x: 2 });
  const p2 = set(child(orderRef, 'x'), 3);
  await Promise.all([p1, p2]);
  const afterOrderSetSnap = await get(orderRef);

  const orderRemoveRef = ref(db, `${prefix}order/temp`);
  await set(orderRemoveRef, { a: 1 });
  const p3 = update(orderRemoveRef, { b: 2 });
  const p4 = remove(orderRemoveRef);
  await Promise.all([p3, p4]);
  const afterOrderRemoveSnap = await get(orderRemoveRef);

  const listenerRef = ref(db, `${prefix}order/observed`);
  await set(listenerRef, { step: 0 });
  const observedSequence: unknown[] = [];
  let sawInitial = false;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      initialTimer = setTimeout(() => {
        reject(new Error('Timed out waiting for initial onValue on order/observed'));
      }, 8_000);
      unsubscribe = onValue(
        listenerRef,
        (snap) => {
          observedSequence.push(snap.val());
          if (!sawInitial) {
            sawInitial = true;
            resolve();
          }
        },
        (err) => reject(err),
      );
    });
    if (initialTimer !== undefined) {
      clearTimeout(initialTimer);
      initialTimer = undefined;
    }
    await update(listenerRef, { step: 1 });
  } finally {
    if (initialTimer !== undefined) {
      clearTimeout(initialTimer);
    }
    if (unsubscribe !== undefined) {
      unsubscribe();
    }
  }
  const listenerSawUpdateBeforeAwaitResolved =
    observedSequence.length >= 2 &&
    (observedSequence[observedSequence.length - 1] as { step?: unknown } | null)?.step === 1;

  return {
    shallowMergeAndNullDelete: {
      afterShallowMerge: afterMergeSnap.val(),
      afterNullKeyDelete: afterNullDeleteSnap.val(),
    },
    multiPathAtomicAllowed: {
      val: atomicAllowedSnap.val(),
    },
    multiPathAtomicPartialDenialRollback: {
      rejected: partialDenialRejected,
      errorCode: partialDenialCode,
      allowedBranchUnchanged: allowedAfterDenial.val(),
      deniedBranchUnchanged: blockedAfterDenial.val(),
    },
    overlappingPathsRejectedBeforeWrite: {
      ancestorFirstThrewSync,
      ancestorFirstMessage,
      descendantFirstThrewSync,
      storedAfterOverlappingCalls: overlapAfterSnap.val(),
    },
    singleClientWriteOrderAndListenerTiming: {
      updateThenChildSetVal: afterOrderSetSnap.val(),
      updateThenRemoveExists: afterOrderRemoveSnap.exists(),
      listenerSawUpdateBeforeAwaitResolved,
      observedSequence,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Modular RTDB update() shallow merge, null-key deletion, multi-path atomic commit vs partial rules-denial rollback, synchronous overlapping-path rejection, and single-client write ordering with onValue delivery before update() resolves.',
  matrixRow: 'rtdb-modular#M13',
  rowIds: [
    'rtdb-modular#M13',
    'rtdb-modular#M14',
    'rtdb-modular#M15',
    'rtdb-modular#M16',
    'rtdb-modular#M16b',
    'rtdb-modular#VR2',
  ],
  observe() {
    return withRtdbProbeSession(
      {
        runRules: {
          '.read': 'auth != null',
          shallow: { '.write': 'auth != null' },
          atomicAllowed: { '.write': 'auth != null' },
          atomicMixed: {
            allowedBranch: { '.write': 'auth != null' },
            blockedBranch: { '.write': false },
          },
          overlap: { '.write': 'auth != null' },
          order: { '.write': 'auth != null' },
        },
      },
      async ({ runPath, db, rtdbSdk, adminWrite }) => {
        return observeMultiPathUpdateAndWriteOrder(
          {
            db,
            ref: rtdbSdk.ref,
            child: rtdbSdk.child,
            set: rtdbSdk.set,
            update: rtdbSdk.update,
            remove: rtdbSdk.remove,
            get: rtdbSdk.get,
            onValue: rtdbSdk.onValue,
          },
          runPath,
          adminWrite,
        );
      },
    );
  },
};
