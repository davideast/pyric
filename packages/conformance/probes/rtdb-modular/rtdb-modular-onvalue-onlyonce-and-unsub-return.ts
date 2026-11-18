import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface OnValueOnlyOnceAndUnsubSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  onValue: typeof import('firebase/database').onValue;
}

export async function observeOnValueOnlyOnceAndUnsubReturn(
  sdk: OnValueOnlyOnceAndUnsubSdk,
  basePath: string,
): Promise<{
  unsubscribeReturnContract: {
    returnTypeOf: string;
    isPlainObject: boolean;
    deliveriesBeforeUnsub: number[];
    deliveriesAfterUnsubAndSubsequentWrite: number[];
    companionSentinelSawPostUnsubWrite: boolean;
  };
  onlyOncePopulatedPath: {
    onlyOnceDeliveries: number[];
    companionSawSubsequentWrite: boolean;
  };
  onlyOnceAbsentPath: {
    onlyOnceDeliveries: Array<unknown>;
    companionSawSubsequentPopulate: boolean;
  };
}> {
  const { db, ref, set, onValue } = sdk;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scope = 'onlyOnceUnsub';
  if (cleanBase) {
    scope = `${cleanBase}/onlyOnceUnsub`;
  }

  const unsubTargetRef = ref(db, `${scope}/unsubTarget`);
  await set(unsubTargetRef, { phase: 1 });

  const targetDeliveries: number[] = [];
  const companionDeliveries: number[] = [];
  let companionWaitTarget: number | undefined;
  let companionWaitResolve: (() => void) | undefined;

  const waitCompanionPhase = async (expectedPhase: number): Promise<void> => {
    if (companionDeliveries.includes(expectedPhase)) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        companionWaitTarget = expectedPhase;
        companionWaitResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for companion phase ${expectedPhase}`));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      companionWaitTarget = undefined;
      companionWaitResolve = undefined;
    }
  };

  const unsubPrimary = onValue(
    unsubTargetRef,
    (snap) => {
      const p = (snap.val() as { phase?: number } | null)?.phase;
      if (typeof p === 'number') {
        targetDeliveries.push(p);
      }
    },
    (err) => {
      throw err;
    },
  );
  const returnTypeOf = typeof unsubPrimary;
  const isPlainObject = unsubPrimary !== null && typeof unsubPrimary === 'object';

  const unsubCompanion = onValue(
    unsubTargetRef,
    (snap) => {
      const p = (snap.val() as { phase?: number } | null)?.phase;
      if (typeof p === 'number') {
        companionDeliveries.push(p);
        if (companionWaitTarget === p && companionWaitResolve !== undefined) {
          const done = companionWaitResolve;
          companionWaitTarget = undefined;
          companionWaitResolve = undefined;
          done();
        }
      }
    },
    (err) => {
      throw err;
    },
  );

  let deliveriesBeforeUnsub: number[] = [];
  try {
    await waitCompanionPhase(1);
    await set(unsubTargetRef, { phase: 2 });
    await waitCompanionPhase(2);
    deliveriesBeforeUnsub = [...targetDeliveries];

    unsubPrimary();
    await set(unsubTargetRef, { phase: 3 });
    await waitCompanionPhase(3);
  } finally {
    unsubPrimary();
    unsubCompanion();
  }

  const oncePopulatedRef = ref(db, `${scope}/oncePopulated`);
  await set(oncePopulatedRef, { count: 10 });
  const onlyOnceDeliveries: number[] = [];
  const onceCompanionCounts: number[] = [];
  let onceWaitTarget: number | undefined;
  let onceWaitResolve: (() => void) | undefined;
  let unsubOnceCompanion: (() => void) | undefined;

  const waitOnceCompanionCount = async (expectedCount: number): Promise<void> => {
    if (onceCompanionCounts.includes(expectedCount)) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onceWaitTarget = expectedCount;
        onceWaitResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for oncePopulated companion count ${expectedCount}`));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      onceWaitTarget = undefined;
      onceWaitResolve = undefined;
    }
  };

  try {
    onValue(
      oncePopulatedRef,
      (snap) => {
        const c = (snap.val() as { count?: number } | null)?.count;
        if (typeof c === 'number') {
          onlyOnceDeliveries.push(c);
        }
      },
      (err) => {
        throw err;
      },
      { onlyOnce: true },
    );

    unsubOnceCompanion = onValue(
      oncePopulatedRef,
      (snap) => {
        const c = (snap.val() as { count?: number } | null)?.count;
        if (typeof c === 'number') {
          onceCompanionCounts.push(c);
          if (onceWaitTarget === c && onceWaitResolve !== undefined) {
            const done = onceWaitResolve;
            onceWaitTarget = undefined;
            onceWaitResolve = undefined;
            done();
          }
        }
      },
      (err) => {
        throw err;
      },
    );

    await waitOnceCompanionCount(10);
    await set(oncePopulatedRef, { count: 20 });
    await waitOnceCompanionCount(20);
  } finally {
    if (unsubOnceCompanion !== undefined) {
      unsubOnceCompanion();
    }
  }
  const onceCompanionSaw20 = onceCompanionCounts.includes(20);

  const onceAbsentRef = ref(db, `${scope}/onceAbsent`);
  const onlyOnceAbsentDeliveries: Array<unknown> = [];
  const absentCompanionStates: boolean[] = [];
  let absentWaitExpectedExists: boolean | undefined;
  let absentWaitResolve: (() => void) | undefined;
  let unsubAbsentCompanion: (() => void) | undefined;

  const waitAbsentCompanionState = async (expectedExists: boolean): Promise<void> => {
    if (absentCompanionStates.includes(expectedExists)) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        absentWaitExpectedExists = expectedExists;
        absentWaitResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for onceAbsent exists=${String(expectedExists)}`));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      absentWaitExpectedExists = undefined;
      absentWaitResolve = undefined;
    }
  };

  try {
    onValue(
      onceAbsentRef,
      (snap) => {
        onlyOnceAbsentDeliveries.push(snap.val());
      },
      (err) => {
        throw err;
      },
      { onlyOnce: true },
    );

    unsubAbsentCompanion = onValue(
      onceAbsentRef,
      (snap) => {
        const ex = snap.exists();
        absentCompanionStates.push(ex);
        if (absentWaitExpectedExists === ex && absentWaitResolve !== undefined) {
          const done = absentWaitResolve;
          absentWaitExpectedExists = undefined;
          absentWaitResolve = undefined;
          done();
        }
      },
      (err) => {
        throw err;
      },
    );

    await waitAbsentCompanionState(false);
    await set(onceAbsentRef, { populated: true });
    await waitAbsentCompanionState(true);
  } finally {
    if (unsubAbsentCompanion !== undefined) {
      unsubAbsentCompanion();
    }
  }
  const absentCompanionSawPopulate = absentCompanionStates.includes(true);

  return {
    unsubscribeReturnContract: {
      returnTypeOf,
      isPlainObject,
      deliveriesBeforeUnsub,
      deliveriesAfterUnsubAndSubsequentWrite: [...targetDeliveries],
      companionSentinelSawPostUnsubWrite: companionDeliveries.includes(3),
    },
    onlyOncePopulatedPath: {
      onlyOnceDeliveries,
      companionSawSubsequentWrite: onceCompanionSaw20,
    },
    onlyOnceAbsentPath: {
      onlyOnceDeliveries: onlyOnceAbsentDeliveries,
      companionSawSubsequentPopulate: absentCompanionSawPopulate,
    },
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Modular RTDB onValue() returned unsubscribe function contract (typeof === "function", stops subsequent deliveries) and { onlyOnce: true } auto-unsubscription on populated and initially absent paths.',
  matrixRow: 'rtdb-modular#M30',
  rowIds: ['rtdb-modular#M30', 'rtdb-modular#M74', 'rtdb-modular#132'],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observeOnValueOnlyOnceAndUnsubReturn(
        {
          db,
          ref: rtdbSdk.ref,
          set: rtdbSdk.set,
          onValue: rtdbSdk.onValue,
        },
        runPath,
      );
    });
  },
};
