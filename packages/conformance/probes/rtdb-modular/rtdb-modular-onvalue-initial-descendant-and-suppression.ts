import type { Database, DatabaseReference } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface OnValueSuppressionProbeSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  child: typeof import('firebase/database').child;
  set: typeof import('firebase/database').set;
  update: typeof import('firebase/database').update;
  onValue: typeof import('firebase/database').onValue;
}

export async function observeOnValueInitialDescendantAndSuppression(
  sdk: OnValueSuppressionProbeSdk,
  basePath: string,
): Promise<{
  absentInitialFire: {
    exists: boolean;
    val: unknown;
  };
  watchedDeliverySequence: unknown[];
  watchedFireCount: number;
}> {
  const { db, ref, child, set, update, onValue } = sdk;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let scope = 'onValueSuppress';
  if (cleanBase) {
    scope = `${cleanBase}/onValueSuppress`;
  }

  const absentRef = ref(db, `${scope}/absentPath`);
  let absentTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubAbsent: (() => void) | undefined;
  let absentInitialFire = { exists: true, val: 'uninitialized' as unknown };
  try {
    absentInitialFire = await new Promise<{ exists: boolean; val: unknown }>((resolve, reject) => {
      absentTimer = setTimeout(() => {
        reject(new Error('Timed out waiting for absent onValue initial fire'));
      }, 8_000);
      unsubAbsent = onValue(
        absentRef,
        (snap) => {
          resolve({ exists: snap.exists(), val: snap.val() });
        },
        (err) => reject(err),
      );
    });
  } finally {
    if (absentTimer !== undefined) {
      clearTimeout(absentTimer);
    }
    if (unsubAbsent !== undefined) {
      unsubAbsent();
    }
  }

  const parentRef: DatabaseReference = ref(db, `${scope}/parent`);
  const watchedRef: DatabaseReference = child(parentRef, 'watched');
  await set(parentRef, {
    watched: { n: 0, nested: { step: 1 } },
    sibling: { other: 1 },
  });

  const watchedDeliverySequence: unknown[] = [];
  let waitPredicate: ((val: unknown) => boolean) | undefined;
  let waitResolve: (() => void) | undefined;
  let unsubWatched: (() => void) | undefined;

  const waitForWatched = async (
    label: string,
    predicate: (val: unknown) => boolean,
    timeoutMs = 8_000,
  ): Promise<void> => {
    if (
      watchedDeliverySequence.length > 0 &&
      predicate(watchedDeliverySequence[watchedDeliverySequence.length - 1])
    ) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        waitPredicate = predicate;
        waitResolve = resolve;
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      waitPredicate = undefined;
      waitResolve = undefined;
    }
  };

  try {
    unsubWatched = onValue(
      watchedRef,
      (snap) => {
        const val = snap.val();
        watchedDeliverySequence.push(val);
        if (waitPredicate !== undefined && waitResolve !== undefined && waitPredicate(val)) {
          const done = waitResolve;
          waitPredicate = undefined;
          waitResolve = undefined;
          done();
        }
      },
      (err) => {
        throw err;
      },
    );

    await waitForWatched(
      'initial watched delivery',
      (v) => (v as { n?: unknown } | null)?.n === 0,
    );

    // 1. Byte-identical subtree rewrite -> suppressed
    await set(watchedRef, { n: 0, nested: { step: 1 } });
    // 2. -0 write over stored 0 -> suppressed
    await set(child(watchedRef, 'n'), -0);
    // 3. Ancestor multi-path write leaving watched unchanged while changing sibling -> suppressed
    await update(parentRef, {
      'watched/n': 0,
      'sibling/other': 99,
    });
    // 4. Sentinel change on watched/n -> fires
    await set(child(watchedRef, 'n'), 2);
    await waitForWatched(
      'sentinel n=2 delivery',
      (v) => (v as { n?: unknown } | null)?.n === 2,
    );

    // 5. Descendant write under watched/nested/step -> fires on parent watched listener
    await set(child(watchedRef, 'nested/step'), 9);
    await waitForWatched(
      'descendant nested/step=9 delivery',
      (v) => (v as { nested?: { step?: unknown } } | null)?.nested?.step === 9,
    );
  } finally {
    if (unsubWatched !== undefined) {
      unsubWatched();
    }
  }

  return {
    absentInitialFire,
    watchedDeliverySequence,
    watchedFireCount: watchedDeliverySequence.length,
  };
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'Modular RTDB onValue() immediate initial fire on present and absent paths, no-change suppression across identical rewrites, -0 over 0, and unchanged-subtree ancestor updates, plus descendant-write re-firing.',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession({}, async ({ runPath, db, rtdbSdk }) => {
      return observeOnValueInitialDescendantAndSuppression(
        {
          db,
          ref: rtdbSdk.ref,
          child: rtdbSdk.child,
          set: rtdbSdk.set,
          update: rtdbSdk.update,
          onValue: rtdbSdk.onValue,
        },
        runPath,
      );
    });
  },
};
