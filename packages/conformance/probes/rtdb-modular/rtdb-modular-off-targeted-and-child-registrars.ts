import type { DataSnapshot, Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface OffTargetedAndChildRegistrarsSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  child: typeof import('firebase/database').child;
  setWithPriority: typeof import('firebase/database').setWithPriority;
  setPriority: typeof import('firebase/database').setPriority;
  remove: typeof import('firebase/database').remove;
  onValue: typeof import('firebase/database').onValue;
  onChildAdded: typeof import('firebase/database').onChildAdded;
  onChildChanged: typeof import('firebase/database').onChildChanged;
  onChildRemoved: typeof import('firebase/database').onChildRemoved;
  onChildMoved: typeof import('firebase/database').onChildMoved;
  off: typeof import('firebase/database').off;
}

export interface PlainChildEventRecord {
  key: string | null;
  val: unknown;
  prevKey: string | null;
}

export async function observeOffTargetedAndChildRegistrars(
  sdk: OffTargetedAndChildRegistrarsSdk,
  basePath: string,
): Promise<{
  childRegistrarIsolation: {
    initialAdded: PlainChildEventRecord[];
    initialChangedCount: number;
    changedCountAfterAddChildC: number;
    changedAfterMutateChildB: PlainChildEventRecord[];
    movedAfterPriorityChangeOnC: PlainChildEventRecord[];
    removedKeysAfterDeleteChildA: string[];
    changedCountAfterDeleteChildA: number;
  };
  targetedOffPrecision: {
    valCb1CountBeforeOffCb1: number;
    valCb2CountBeforeOffCb1: number;
    valCb1CountAfterOffCb1AndWrite: number;
    valCb2CountAfterOffCb1AndWrite: number;
    valCb2CountAfterOffAllValueAndWrite: number;
    childChangedStillFiredAfterOffAllValue: boolean;
    addedCountAfterUnsubChildAddedAndAddD: number;
    changedCountAfterOffChildChangedCbAndWrite: number;
  };
}> {
  const {
    db,
    ref,
    child,
    setWithPriority,
    setPriority,
    remove,
    onValue,
    onChildAdded,
    onChildChanged,
    onChildRemoved,
    onChildMoved,
    off,
  } = sdk;

  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scope = 'offAndChild';
  if (cleanBase) {
    scope = `${cleanBase}/offAndChild`;
  }

  const itemsRef = ref(db, `${scope}/items`);
  const sentinelRef = ref(db, `${scope}/sentinel`);
  await setWithPriority(child(itemsRef, 'a'), { v: 1 }, 10);
  await setWithPriority(child(itemsRef, 'b'), { v: 2 }, 20);
  await setWithPriority(sentinelRef, { seq: 0 }, null);

  const addedEvents: PlainChildEventRecord[] = [];
  const changedEvents: PlainChildEventRecord[] = [];
  const removedKeys: string[] = [];
  const movedEvents: PlainChildEventRecord[] = [];
  let valCb1Count = 0;
  let valCb2Count = 0;
  let initialItemsValueResolve: (() => void) | undefined;
  let sentinelLastSeq: number | null = null;
  let sentinelWaitTarget: number | undefined;
  let sentinelWaitResolve: (() => void) | undefined;

  const waitInitialItemsValue = async (): Promise<void> => {
    if (valCb1Count >= 1) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        initialItemsValueResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error('Timed out waiting for initial onValue on itemsRef'));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      initialItemsValueResolve = undefined;
    }
  };

  const advanceAndWaitSentinel = async (nextSeq: number): Promise<void> => {
    await setWithPriority(sentinelRef, { seq: nextSeq }, null);
    if (sentinelLastSeq === nextSeq) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        sentinelWaitTarget = nextSeq;
        sentinelWaitResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for sentinel seq=${nextSeq}`));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      sentinelWaitTarget = undefined;
      sentinelWaitResolve = undefined;
    }
  };

  const waitInitialSentinel = async (): Promise<void> => {
    if (sentinelLastSeq === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        sentinelWaitTarget = 0;
        sentinelWaitResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error('Timed out waiting for initial sentinel seq=0'));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      sentinelWaitTarget = undefined;
      sentinelWaitResolve = undefined;
    }
  };

  const unsubSentinel = onValue(
    sentinelRef,
    (snap) => {
      const seq = (snap.val() as { seq?: number } | null)?.seq ?? null;
      sentinelLastSeq = seq;
      if (seq !== null && sentinelWaitTarget === seq && sentinelWaitResolve !== undefined) {
        const done = sentinelWaitResolve;
        sentinelWaitTarget = undefined;
        sentinelWaitResolve = undefined;
        done();
      }
    },
    (err) => {
      throw err;
    },
  );

  const valCb1 = (_snap: DataSnapshot) => {
    valCb1Count += 1;
    if (initialItemsValueResolve !== undefined) {
      const done = initialItemsValueResolve;
      initialItemsValueResolve = undefined;
      done();
    }
  };
  const valCb2 = (_snap: DataSnapshot) => {
    valCb2Count += 1;
  };
  const childAddedCb = (snap: DataSnapshot, prevKey?: string | null) => {
    addedEvents.push({ key: snap.key, val: snap.val(), prevKey: prevKey ?? null });
  };
  const childChangedCb = (snap: DataSnapshot, prevKey?: string | null) => {
    changedEvents.push({ key: snap.key, val: snap.val(), prevKey: prevKey ?? null });
  };
  const childRemovedCb = (snap: DataSnapshot) => {
    if (snap.key !== null) {
      removedKeys.push(snap.key);
    }
  };
  const childMovedCb = (snap: DataSnapshot, prevKey?: string | null) => {
    movedEvents.push({ key: snap.key, val: snap.val(), prevKey: prevKey ?? null });
  };

  onValue(itemsRef, valCb1, (err) => {
    throw err;
  });
  onValue(itemsRef, valCb2, (err) => {
    throw err;
  });
  const unsubChildAdded = onChildAdded(itemsRef, childAddedCb, (err) => {
    throw err;
  });
  onChildChanged(itemsRef, childChangedCb, (err) => {
    throw err;
  });
  onChildRemoved(itemsRef, childRemovedCb, (err) => {
    throw err;
  });
  onChildMoved(itemsRef, childMovedCb, (err) => {
    throw err;
  });

  try {
    await Promise.all([waitInitialItemsValue(), waitInitialSentinel()]);
    const initialAdded = [...addedEvents];
    const initialChangedCount = changedEvents.length;

    // Add child 'c' -> onChildAdded fires, onChildChanged MUST NOT fire (#M44)
    await setWithPriority(child(itemsRef, 'c'), { v: 3 }, 30);
    await setWithPriority(child(itemsRef, 'b'), { v: 20 }, 20);
    await advanceAndWaitSentinel(1);
    const changedSnapshotAfterCAndB = [...changedEvents];
    const changedCountAfterAddChildC = changedSnapshotAfterCAndB.filter(
      (e) => e.key === 'c',
    ).length;

    // Move 'c' ahead of 'a' and 'b' via priority 5 -> onChildMoved fires for 'c'
    await setPriority(child(itemsRef, 'c'), 5);
    await advanceAndWaitSentinel(2);
    const movedAfterPriorityChangeOnC = [...movedEvents];

    // Delete child 'a' -> onChildRemoved fires for 'a', onChildChanged MUST NOT fire for 'a' (#M44)
    const changedBeforeRemoveA = changedEvents.length;
    await remove(child(itemsRef, 'a'));
    await advanceAndWaitSentinel(3);
    const removedKeysAfterDeleteChildA = [...removedKeys];
    const changedForA = changedEvents.slice(changedBeforeRemoveA).filter((e) => e.key === 'a').length;

    // Targeted off(itemsRef, 'value', valCb1) (#140, #M48): detaches valCb1 ONLY, keeping valCb2 + child listeners
    const valCb1CountBeforeOffCb1 = valCb1Count;
    const valCb2CountBeforeOffCb1 = valCb2Count;
    off(itemsRef, 'value', valCb1);
    await setWithPriority(child(itemsRef, 'b'), { v: 23 }, 20);
    await advanceAndWaitSentinel(4);
    const valCb1CountAfterOffCb1AndWrite = valCb1Count;
    const valCb2CountAfterOffCb1AndWrite = valCb2Count;

    // off(itemsRef, 'value') (#M48): detaches remaining value listener valCb2 while child_changed stays active
    const changedBeforeOffAllValue = changedEvents.length;
    off(itemsRef, 'value');
    await setWithPriority(child(itemsRef, 'b'), { v: 24 }, 20);
    await advanceAndWaitSentinel(5);
    const valCb2CountAfterOffAllValueAndWrite = valCb2Count;
    const childChangedStillFiredAfterOffAllValue = changedEvents.length > changedBeforeOffAllValue;

    // Returned unsubscribe from onChildAdded + off(itemsRef, 'child_changed', childChangedCb) (#M48)
    const addedCountBeforeUnsub = addedEvents.length;
    const changedCountBeforeOffChanged = changedEvents.length;
    unsubChildAdded();
    off(itemsRef, 'child_changed', childChangedCb);
    await setWithPriority(child(itemsRef, 'd'), { v: 4 }, 40);
    await setWithPriority(child(itemsRef, 'b'), { v: 25 }, 20);
    await advanceAndWaitSentinel(6);

    return {
      childRegistrarIsolation: {
        initialAdded,
        initialChangedCount,
        changedCountAfterAddChildC,
        changedAfterMutateChildB: changedSnapshotAfterCAndB,
        movedAfterPriorityChangeOnC,
        removedKeysAfterDeleteChildA,
        changedCountAfterDeleteChildA: changedForA,
      },
      targetedOffPrecision: {
        valCb1CountBeforeOffCb1,
        valCb2CountBeforeOffCb1,
        valCb1CountAfterOffCb1AndWrite,
        valCb2CountAfterOffCb1AndWrite,
        valCb2CountAfterOffAllValueAndWrite,
        childChangedStillFiredAfterOffAllValue,
        addedCountAfterUnsubChildAddedAndAddD: addedEvents.length - addedCountBeforeUnsub,
        changedCountAfterOffChildChangedCbAndWrite:
          changedEvents.length - changedCountBeforeOffChanged,
      },
    };
  } finally {
    off(itemsRef);
    unsubSentinel();
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Modular RTDB plain-ref child listener registrars (onChildAdded/Changed/Removed/Moved), onChildChanged isolation from adds and deletes, and targeted off(ref, eventType?, callback?) vs returned-unsubscribe precision.',
  matrixRow: 'rtdb-modular#M31',
  rowIds: ['rtdb-modular#M31', 'rtdb-modular#M44', 'rtdb-modular#M48', 'rtdb-modular#140'],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observeOffTargetedAndChildRegistrars(
        {
          db,
          ref: rtdbSdk.ref,
          child: rtdbSdk.child,
          setWithPriority: rtdbSdk.setWithPriority,
          setPriority: rtdbSdk.setPriority,
          remove: rtdbSdk.remove,
          onValue: rtdbSdk.onValue,
          onChildAdded: rtdbSdk.onChildAdded,
          onChildChanged: rtdbSdk.onChildChanged,
          onChildRemoved: rtdbSdk.onChildRemoved,
          onChildMoved: rtdbSdk.onChildMoved,
          off: rtdbSdk.off,
        },
        runPath,
      );
    });
  },
};
