import type { DataSnapshot, Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface QueryWindowChildListenersSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  child: typeof import('firebase/database').child;
  set: typeof import('firebase/database').set;
  query: typeof import('firebase/database').query;
  orderByChild: typeof import('firebase/database').orderByChild;
  limitToFirst: typeof import('firebase/database').limitToFirst;
  onValue: typeof import('firebase/database').onValue;
  onChildAdded: typeof import('firebase/database').onChildAdded;
  onChildChanged: typeof import('firebase/database').onChildChanged;
  onChildRemoved: typeof import('firebase/database').onChildRemoved;
  onChildMoved: typeof import('firebase/database').onChildMoved;
}

export interface QueryChildEventRecord {
  key: string | null;
  val: unknown;
  prevKey: string | null;
}

export interface QueryChildRemovedRecord {
  key: string | null;
  val: unknown;
}

export async function observeQueryWindowChildListeners(
  sdk: QueryWindowChildListenersSdk,
  basePath: string,
): Promise<{
  initialWindowAdded: QueryChildEventRecord[];
  afterOutOfWindowEditThenInWindowEditChanged: QueryChildEventRecord[];
  afterInWindowReorderMoved: QueryChildEventRecord[];
  afterEnteringChildZAdded: QueryChildEventRecord[];
  afterEnteringChildZDisplacedRemoved: QueryChildRemovedRecord[];
}> {
  const {
    db,
    ref,
    child,
    set,
    query,
    orderByChild,
    limitToFirst,
    onValue,
    onChildAdded,
    onChildChanged,
    onChildRemoved,
    onChildMoved,
  } = sdk;

  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scoresPath = 'scores';
  if (cleanBase) {
    scoresPath = `${cleanBase}/scores`;
  }
  const scoresRef = ref(db, scoresPath);

  await set(scoresRef, {
    a: { score: 10, tag: 'init' },
    b: { score: 20, tag: 'init' },
    c: { score: 30, tag: 'init' },
  });

  const windowQuery = query(scoresRef, orderByChild('score'), limitToFirst(2));

  const addedEvents: QueryChildEventRecord[] = [];
  const changedEvents: QueryChildEventRecord[] = [];
  const removedEvents: QueryChildRemovedRecord[] = [];
  const movedEvents: QueryChildEventRecord[] = [];

  let latestWindowKeys: string[] = [];
  let waitWindowPredicate: ((keys: string[], snap: DataSnapshot) => boolean) | undefined;
  let waitWindowResolve: (() => void) | undefined;

  const waitWindow = async (
    label: string,
    predicate: (keys: string[], snap: DataSnapshot) => boolean,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        waitWindowPredicate = predicate;
        waitWindowResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for query window ${label}`));
        }, 8_000);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      waitWindowPredicate = undefined;
      waitWindowResolve = undefined;
    }
  };

  const unsubAdded = onChildAdded(
    windowQuery,
    (snap, prevKey) => {
      addedEvents.push({ key: snap.key, val: snap.val(), prevKey: prevKey ?? null });
    },
    (err) => {
      throw err;
    },
  );
  const unsubChanged = onChildChanged(
    windowQuery,
    (snap, prevKey) => {
      changedEvents.push({ key: snap.key, val: snap.val(), prevKey: prevKey ?? null });
    },
    (err) => {
      throw err;
    },
  );
  const unsubRemoved = onChildRemoved(
    windowQuery,
    (snap) => {
      removedEvents.push({ key: snap.key, val: snap.val() });
    },
    (err) => {
      throw err;
    },
  );
  const unsubMoved = onChildMoved(
    windowQuery,
    (snap, prevKey) => {
      movedEvents.push({ key: snap.key, val: snap.val(), prevKey: prevKey ?? null });
    },
    (err) => {
      throw err;
    },
  );

  let initialDelivered = false;
  const unsubWindowValue = onValue(
    windowQuery,
    (snap) => {
      const keys: string[] = [];
      snap.forEach((childSnap) => {
        if (childSnap.key !== null) {
          keys.push(childSnap.key);
        }
        return false;
      });
      latestWindowKeys = keys;
      initialDelivered = true;
      if (
        waitWindowPredicate !== undefined &&
        waitWindowResolve !== undefined &&
        waitWindowPredicate(keys, snap)
      ) {
        const done = waitWindowResolve;
        waitWindowPredicate = undefined;
        waitWindowResolve = undefined;
        done();
      }
    },
    (err) => {
      throw err;
    },
  );

  try {
    if (!initialDelivered) {
      await waitWindow('initial [a, b]', (keys) => keys.join(',') === 'a,b');
    }
    const initialWindowAdded = [...addedEvents];

    // Mutate out-of-window 'c' (score 35, still outside top 2), then in-window 'b' tag -> only 'b' fires changed
    const waitEditedB = waitWindow(
      'in-window edit on b',
      (_keys, snap) => (snap.child('b').val() as { tag?: string } | null)?.tag === 'edited-b',
    );
    await set(child(scoresRef, 'c'), { score: 35, tag: 'outside-edit' });
    await set(child(scoresRef, 'b'), { score: 20, tag: 'edited-b' });
    await waitEditedB;
    const afterOutOfWindowEditThenInWindowEditChanged = [...changedEvents];

    // Reorder 'a' from score 10 -> 25 (window becomes [b:20, a:25]) -> moved fires for 'a'
    const waitMovedA = waitWindow('reordered [b, a]', (keys) => keys.join(',') === 'b,a');
    await set(child(scoresRef, 'a'), { score: 25, tag: 'reordered-a' });
    await waitMovedA;
    const afterInWindowReorderMoved = [...movedEvents];

    // Add 'z' with score 5 -> enters window [z:5, b:20], displacing 'a' (added 'z', removed 'a')
    const addedBeforeZ = addedEvents.length;
    const removedBeforeZ = removedEvents.length;
    const waitEnteredZ = waitWindow(
      'z enters and displaces a -> [z, b]',
      (keys) => keys.join(',') === 'z,b',
    );
    await set(child(scoresRef, 'z'), { score: 5, tag: 'entered-z' });
    await waitEnteredZ;
    void latestWindowKeys;

    return {
      initialWindowAdded,
      afterOutOfWindowEditThenInWindowEditChanged,
      afterInWindowReorderMoved,
      afterEnteringChildZAdded: addedEvents.slice(addedBeforeZ),
      afterEnteringChildZDisplacedRemoved: removedEvents.slice(removedBeforeZ),
    };
  } finally {
    unsubAdded();
    unsubChanged();
    unsubRemoved();
    unsubMoved();
    unsubWindowValue();
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  description:
    'Modular RTDB child listeners (onChildAdded, onChildChanged, onChildRemoved, onChildMoved) on a bounded Query (orderByChild + limitToFirst): observes initial window replay, out-of-window write suppression, in-window reorder movement, and entering/displaced member add+remove events.',
  matrixRow: 'rtdb-modular#M75b',
  rowIds: ['rtdb-modular#M75b'],
  observe() {
    return withRtdbProbeSession(
      {
        runRules: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          scores: {
            '.indexOn': ['score'],
          },
        },
      },
      async ({ runPath, db, rtdbSdk }) => {
        return observeQueryWindowChildListeners(
          {
            db,
            ref: rtdbSdk.ref,
            child: rtdbSdk.child,
            set: rtdbSdk.set,
            query: rtdbSdk.query,
            orderByChild: rtdbSdk.orderByChild,
            limitToFirst: rtdbSdk.limitToFirst,
            onValue: rtdbSdk.onValue,
            onChildAdded: rtdbSdk.onChildAdded,
            onChildChanged: rtdbSdk.onChildChanged,
            onChildRemoved: rtdbSdk.onChildRemoved,
            onChildMoved: rtdbSdk.onChildMoved,
          },
          runPath,
        );
      },
    );
  },
};
