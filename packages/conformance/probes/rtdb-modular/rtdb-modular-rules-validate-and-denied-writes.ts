import type { Database } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface RulesValidateAndDeniedWritesSdk {
  db: Database;
  ref: typeof import('firebase/database').ref;
  set: typeof import('firebase/database').set;
  update: typeof import('firebase/database').update;
  remove: typeof import('firebase/database').remove;
  get: typeof import('firebase/database').get;
  onValue: typeof import('firebase/database').onValue;
  runTransaction: typeof import('firebase/database').runTransaction;
}

export interface RejectedWriteShape {
  rejected: boolean;
  errorName: string | null;
  code: string | null;
  message: string | null;
}

async function captureRejectedPromise(invoke: () => Promise<unknown>): Promise<RejectedWriteShape> {
  try {
    await invoke();
    return {
      rejected: false,
      errorName: null,
      code: null,
      message: null,
    };
  } catch (err) {
    const errorObj = err as Error & { code?: unknown };
    let code: string | null = null;
    if (typeof errorObj.code === 'string') {
      code = errorObj.code;
    }
    return {
      rejected: true,
      errorName: errorObj.name,
      code,
      message: errorObj.message,
    };
  }
}

export async function observeRulesValidateAndDeniedWrites(
  sdk: RulesValidateAndDeniedWritesSdk,
  basePath: string,
  seedAdminData: (subpath: string, value: unknown) => Promise<void>,
): Promise<{
  deniedRemove: {
    outcome: RejectedWriteShape;
    preservedVal: unknown;
  };
  deniedTransactionPreservesValue: {
    outcome: RejectedWriteShape;
    preservedVal: unknown;
  };
  transactionDefensiveCloneAndCommitFanout: {
    mutatedAbortCommitted: boolean;
    valAfterMutatedAbort: unknown;
    committedTxCommitted: boolean;
    committedSnapshotVal: unknown;
    listenerObservedValues: unknown[];
  };
  validateRuleEnforcement: {
    validSetVal: unknown;
    invalidSetRejected: boolean;
    invalidMultiPathUpdateRejected: boolean;
    invalidTransactionRejected: boolean;
    preservedAfterAllInvalidWrites: unknown;
  };
  nonFunctionTransactionValidation: {
    timing: 'synchronous-throw' | 'asynchronous-reject' | 'resolved';
    isTypeError: boolean;
  };
}> {
  const { db, ref, set, update, remove, get, onValue, runTransaction } = sdk;
  const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
  let prefix = '';
  if (cleanBase) {
    prefix = `${cleanBase}/`;
  }

  await seedAdminData('lockedRemove', { secret: 'keep-me' });
  await seedAdminData('lockedTx', { balance: 100 });

  const lockedRemoveRef = ref(db, `${prefix}lockedRemove`);
  const deniedRemoveOutcome = await captureRejectedPromise(() => remove(lockedRemoveRef));
  const preservedAfterRemove = await get(lockedRemoveRef);

  const lockedTxRef = ref(db, `${prefix}lockedTx`);
  const deniedTxOutcome = await captureRejectedPromise(() =>
    runTransaction(lockedTxRef, (curr) => {
      const base = (curr as { balance?: number } | null)?.balance ?? 0;
      return { balance: base + 50 };
    }),
  );
  const preservedAfterDeniedTx = await get(lockedTxRef);

  const openTxRef = ref(db, `${prefix}openTx/counter`);
  await set(openTxRef, { count: 10, nested: { tag: 'v1' } });

  const listenerObservedValues: unknown[] = [];
  let initialReadyTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let sawInitial = false;
  try {
    await new Promise<void>((resolve, reject) => {
      initialReadyTimer = setTimeout(() => {
        reject(new Error('Timed out waiting for initial onValue on openTx/counter'));
      }, 8_000);
      unsubscribe = onValue(
        openTxRef,
        (snap) => {
          listenerObservedValues.push(snap.val());
          if (!sawInitial) {
            sawInitial = true;
            resolve();
          }
        },
        (err) => reject(err),
      );
    });
    if (initialReadyTimer !== undefined) {
      clearTimeout(initialReadyTimer);
      initialReadyTimer = undefined;
    }

    const abortResult = await runTransaction(openTxRef, (current) => {
      if (current !== null && typeof current === 'object') {
        const mutable = current as { count?: number; nested?: { tag?: string } };
        mutable.count = 999;
        if (mutable.nested !== undefined) {
          mutable.nested.tag = 'corrupted';
        }
      }
      return undefined;
    });

    const afterAbortSnap = await get(openTxRef);

    const commitResult = await runTransaction(openTxRef, (current) => {
      if (current === null) {
        return { count: 11, nested: { tag: 'v2' } };
      }
      const prev = (current as { count?: number }).count ?? 0;
      return { count: prev + 5, nested: { tag: 'v2' } };
    });

    const validatedRootRef = ref(db, `${prefix}validated`);
    const validatedItemRef = ref(db, `${prefix}validated/item`);
    await set(validatedRootRef, {
      sibling: 'unchanged',
      item: { title: 'valid-seed', qty: 3 },
    });
    const validSeedSnap = await get(validatedRootRef);

    const invalidSetOutcome = await captureRejectedPromise(() =>
      set(validatedItemRef, { title: 'bad-qty', qty: 0 }),
    );
    const invalidUpdateOutcome = await captureRejectedPromise(() =>
      update(validatedRootRef, {
        sibling: 'attempted-change',
        'item/qty': -5,
      }),
    );
    const invalidTxOutcome = await captureRejectedPromise(() =>
      runTransaction(validatedItemRef, () => ({ title: 'missing-qty-positive', qty: -1 })),
    );
    const afterInvalidWritesSnap = await get(validatedRootRef);

    let nonFnTiming: 'synchronous-throw' | 'asynchronous-reject' | 'resolved' = 'resolved';
    let nonFnIsTypeError = false;
    try {
      const maybePromise = runTransaction(openTxRef, null as unknown as (v: unknown) => unknown);
      if (
        maybePromise !== null &&
        typeof maybePromise === 'object' &&
        typeof (maybePromise as { then?: unknown }).then === 'function'
      ) {
        try {
          await maybePromise;
        } catch (asyncErr) {
          nonFnTiming = 'asynchronous-reject';
          nonFnIsTypeError = asyncErr instanceof TypeError;
        }
      }
    } catch (syncErr) {
      nonFnTiming = 'synchronous-throw';
      nonFnIsTypeError = syncErr instanceof TypeError;
    }

    return {
      deniedRemove: {
        outcome: deniedRemoveOutcome,
        preservedVal: preservedAfterRemove.val(),
      },
      deniedTransactionPreservesValue: {
        outcome: deniedTxOutcome,
        preservedVal: preservedAfterDeniedTx.val(),
      },
      transactionDefensiveCloneAndCommitFanout: {
        mutatedAbortCommitted: abortResult.committed,
        valAfterMutatedAbort: afterAbortSnap.val(),
        committedTxCommitted: commitResult.committed,
        committedSnapshotVal: commitResult.snapshot.val(),
        listenerObservedValues,
      },
      validateRuleEnforcement: {
        validSetVal: validSeedSnap.val(),
        invalidSetRejected: invalidSetOutcome.rejected,
        invalidMultiPathUpdateRejected: invalidUpdateOutcome.rejected,
        invalidTransactionRejected: invalidTxOutcome.rejected,
        preservedAfterAllInvalidWrites: afterInvalidWritesSnap.val(),
      },
      nonFunctionTransactionValidation: {
        timing: nonFnTiming,
        isTypeError: nonFnIsTypeError,
      },
    };
  } finally {
    if (initialReadyTimer !== undefined) {
      clearTimeout(initialReadyTimer);
    }
    if (unsubscribe !== undefined) {
      unsubscribe();
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  pendingRowLink: true,
  description:
    'Modular RTDB rules-denied remove() and runTransaction() state preservation, update-fn defensive clone on abort, committed transaction onValue fan-out, and .validate rule enforcement across set(), atomic update(), and runTransaction().',
  matrixRow: '',
  rowIds: [],
  observe() {
    return withRtdbProbeSession(
      {
        runRules: {
          '.read': 'auth != null',
          lockedRemove: {
            '.write': false,
          },
          lockedTx: {
            '.write': false,
          },
          openTx: {
            '.write': 'auth != null',
          },
          validated: {
            '.write': 'auth != null',
            item: {
              '.validate':
                "newData.hasChildren(['title', 'qty']) && newData.child('qty').isNumber() && newData.child('qty').val() > 0",
            },
          },
        },
      },
      async ({ runPath, db, rtdbSdk, adminWrite }) => {
        return observeRulesValidateAndDeniedWrites(
          {
            db,
            ref: rtdbSdk.ref,
            set: rtdbSdk.set,
            update: rtdbSdk.update,
            remove: rtdbSdk.remove,
            get: rtdbSdk.get,
            onValue: rtdbSdk.onValue,
            runTransaction: rtdbSdk.runTransaction,
          },
          runPath,
          adminWrite,
        );
      },
    );
  },
};
