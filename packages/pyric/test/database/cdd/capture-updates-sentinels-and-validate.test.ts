import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, signInAnonymously } from 'pyric/auth';
import * as pyricRtdb from 'pyric/database';
import { getAdminDatabase } from 'pyric/database';
import {
  observeMultiPathUpdateAndWriteOrder,
  type MultiPathUpdateProbeSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-multipath-update-and-write-order.ts';
import {
  observePushValueAndNestedServerTimestamp,
  type PushAndNestedServerTimestampSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-push-value-and-nested-servertimestamp.ts';
import {
  observeRefNavigationAndAbsentGet,
  type RefNavigationAndAbsentGetSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-ref-navigation-and-absent-get.ts';
import {
  observeRulesValidateAndDeniedWrites,
  type RulesValidateAndDeniedWritesSdk,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-rules-validate-and-denied-writes.ts';
import { obs } from './capture-replay.ts';

const OPEN_REPLAY_RULES: Record<string, unknown> = {
  rules: {
    '.read': true,
    '.write': true,
  },
};

const MULTIPATH_REPLAY_RULES: Record<string, unknown> = {
  rules: {
    pyric_oracle: {
      replay: {
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
  },
};

const VALIDATE_AND_DENIAL_REPLAY_RULES: Record<string, unknown> = {
  rules: {
    pyric_oracle: {
      replay: {
        '.read': 'auth != null',
        lockedRemove: { '.write': false },
        lockedTx: { '.write': false },
        openTx: { '.write': 'auth != null' },
        validated: {
          '.write': 'auth != null',
          item: {
            '.validate':
              "newData.hasChildren(['title', 'qty']) && newData.child('qty').isNumber() && newData.child('qty').val() > 0",
          },
        },
      },
    },
  },
};

async function withUpdatesSandbox<T>(
  rules: Record<string, unknown>,
  run: (
    db: RefNavigationAndAbsentGetSdk['db'],
    sdk: typeof pyricRtdb,
    adminWrite: (subpath: string, value: unknown) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const sandbox = initializeSandbox({ projectId: 'demo-rtdb-updates-cdd' });
  await signInAnonymously(getAuth(sandbox));
  const rawDb = pyricRtdb.getDatabase(sandbox);
  const adminDb = getAdminDatabase(sandbox);
  pyricRtdb.sandbox.setRules(rawDb, rules);
  const adminWrite = async (subpath: string, value: unknown): Promise<void> => {
    await pyricRtdb.set(pyricRtdb.ref(adminDb, `pyric_oracle/replay/${subpath}`), value as never);
  };
  try {
    return await run(rawDb as unknown as RefNavigationAndAbsentGetSdk['db'], pyricRtdb, adminWrite);
  } finally {
    sandbox.dispose();
  }
}

describe('RTDB modular ref navigation, updates, sentinels, and .validate oracle captures (in-page sandbox)', () => {
  it('rtdb-modular-ref-navigation-and-absent-get (rtdb-modular#M4..#M9)', async () => {
    const actual = await withUpdatesSandbox(OPEN_REPLAY_RULES, (db, sdk) =>
      observeRefNavigationAndAbsentGet(
        {
          db,
          ref: sdk.ref as unknown as RefNavigationAndAbsentGetSdk['ref'],
          child: sdk.child as unknown as RefNavigationAndAbsentGetSdk['child'],
          set: sdk.set as unknown as RefNavigationAndAbsentGetSdk['set'],
          get: sdk.get as unknown as RefNavigationAndAbsentGetSdk['get'],
        },
        'pyric_oracle/replay',
      ),
    );
    expect(actual.rootAndPathRefs.emptyStringPathThrewSync).toBe(true);
    expect(actual as unknown).toEqual(obs('rtdb-modular-ref-navigation-and-absent-get'));
  });

  it('rtdb-modular-multipath-update-and-write-order (rtdb-modular#M13..#M16b)', async () => {
    const actual = await withUpdatesSandbox(MULTIPATH_REPLAY_RULES, (db, sdk, adminWrite) =>
      observeMultiPathUpdateAndWriteOrder(
        {
          db,
          ref: sdk.ref as unknown as MultiPathUpdateProbeSdk['ref'],
          child: sdk.child as unknown as MultiPathUpdateProbeSdk['child'],
          set: sdk.set as unknown as MultiPathUpdateProbeSdk['set'],
          update: sdk.update as unknown as MultiPathUpdateProbeSdk['update'],
          remove: sdk.remove as unknown as MultiPathUpdateProbeSdk['remove'],
          get: sdk.get as unknown as MultiPathUpdateProbeSdk['get'],
          onValue: sdk.onValue as unknown as MultiPathUpdateProbeSdk['onValue'],
        },
        'pyric_oracle/replay',
        adminWrite,
      ),
    );
    expect(actual.singleClientWriteOrderAndListenerTiming.listenerSawUpdateBeforeAwaitResolved).toBe(
      true,
    );
    expect(actual as unknown).toEqual(obs('rtdb-modular-multipath-update-and-write-order'));
  });

  it('rtdb-modular-push-value-and-nested-servertimestamp (rtdb-modular#M18, #M20, #M22)', async () => {
    const actual = await withUpdatesSandbox(OPEN_REPLAY_RULES, (db, sdk) =>
      observePushValueAndNestedServerTimestamp(
        {
          db,
          ref: sdk.ref as unknown as PushAndNestedServerTimestampSdk['ref'],
          child: sdk.child as unknown as PushAndNestedServerTimestampSdk['child'],
          set: sdk.set as unknown as PushAndNestedServerTimestampSdk['set'],
          update: sdk.update as unknown as PushAndNestedServerTimestampSdk['update'],
          push: sdk.push as unknown as PushAndNestedServerTimestampSdk['push'],
          get: sdk.get as unknown as PushAndNestedServerTimestampSdk['get'],
          serverTimestamp:
            sdk.serverTimestamp as unknown as PushAndNestedServerTimestampSdk['serverTimestamp'],
        },
        'pyric_oracle/replay',
      ),
    );
    expect(actual.serverTimestampSentinelMarker.markerShape).toEqual({ '.sv': 'timestamp' });
    expect(actual as unknown).toEqual(obs('rtdb-modular-push-value-and-nested-servertimestamp'));
  });

  it('rtdb-modular-rules-validate-and-denied-writes (rtdb-modular#M25, #M37c, #M37f, #M37g, #M76)', async () => {
    const actual = await withUpdatesSandbox(
      VALIDATE_AND_DENIAL_REPLAY_RULES,
      (db, sdk, adminWrite) =>
        observeRulesValidateAndDeniedWrites(
          {
            db,
            ref: sdk.ref as unknown as RulesValidateAndDeniedWritesSdk['ref'],
            set: sdk.set as unknown as RulesValidateAndDeniedWritesSdk['set'],
            update: sdk.update as unknown as RulesValidateAndDeniedWritesSdk['update'],
            remove: sdk.remove as unknown as RulesValidateAndDeniedWritesSdk['remove'],
            get: sdk.get as unknown as RulesValidateAndDeniedWritesSdk['get'],
            onValue: sdk.onValue as unknown as RulesValidateAndDeniedWritesSdk['onValue'],
            runTransaction:
              sdk.runTransaction as unknown as RulesValidateAndDeniedWritesSdk['runTransaction'],
          },
          'pyric_oracle/replay',
          adminWrite,
        ),
    );
    expect(actual.nonFunctionTransactionValidation).toEqual({
      timing: 'synchronous-throw',
      isTypeError: true,
    });
    expect(actual as unknown).toEqual(obs('rtdb-modular-rules-validate-and-denied-writes'));
  });
});
