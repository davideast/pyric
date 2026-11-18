import { describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import {
  observeMultiPathUpdateAndWriteOrder,
  type MultiPathUpdateProbeSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-multipath-update-and-write-order.ts';
import {
  observePushValueAndNestedServerTimestamp,
  type PushAndNestedServerTimestampSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-push-value-and-nested-servertimestamp.ts';
import {
  observeRefNavigationAndAbsentGet,
  type RefNavigationAndAbsentGetSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-ref-navigation-and-absent-get.ts';
import {
  observeRulesValidateAndDeniedWrites,
  type RulesValidateAndDeniedWritesSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-rules-validate-and-denied-writes.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

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

type ServedPlaneFactory = (rules?: Record<string, unknown>) => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, ServedPlaneFactory]> = [
  ['served SharedWorker', (rules) => servedRtdbContext(rules)],
  ['served Node host', (rules) => hostedRtdbContext(rules)],
];

async function authenticateAndMakeAdminSeeder(
  ctx: ServedRtdbAdminContext,
): Promise<(subpath: string, value: unknown) => Promise<void>> {
  const port = (ctx.db as unknown as { port: client.ClientDb['port'] }).port;
  await client.signInAnonymously(client.getAuth({ port } as never));
  const adminDb = await ctx.openAdminDb();
  return async (subpath: string, value: unknown): Promise<void> => {
    await adminDb.ref(`${ctx.base}/${subpath}`).set(value);
  };
}

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB modular ref navigation, updates, sentinels, and .validate oracle captures (${planeLabel})`, () => {
    it('rtdb-modular-ref-navigation-and-absent-get (rtdb-modular#M4..#M9)', async () => {
      const ctx = await createContext();
      const actual = await observeRefNavigationAndAbsentGet(
        {
          db: ctx.db as unknown as RefNavigationAndAbsentGetSdk['db'],
          ref: ctx.rtdb.ref as unknown as RefNavigationAndAbsentGetSdk['ref'],
          child: ctx.rtdb.child as unknown as RefNavigationAndAbsentGetSdk['child'],
          set: ctx.rtdb.set as unknown as RefNavigationAndAbsentGetSdk['set'],
          get: ctx.rtdb.get as unknown as RefNavigationAndAbsentGetSdk['get'],
        },
        ctx.base,
      );
      expect(actual.rootAndPathRefs.emptyStringPathThrewSync).toBe(true);
      expect(actual as unknown).toEqual(load('rtdb-modular-ref-navigation-and-absent-get'));
    });

    it('rtdb-modular-multipath-update-and-write-order (rtdb-modular#M13..#M16b)', async () => {
      const ctx = await createContext(MULTIPATH_REPLAY_RULES);
      const adminWrite = await authenticateAndMakeAdminSeeder(ctx);
      const actual = await observeMultiPathUpdateAndWriteOrder(
        {
          db: ctx.db as unknown as MultiPathUpdateProbeSdk['db'],
          ref: ctx.rtdb.ref as unknown as MultiPathUpdateProbeSdk['ref'],
          child: ctx.rtdb.child as unknown as MultiPathUpdateProbeSdk['child'],
          set: ctx.rtdb.set as unknown as MultiPathUpdateProbeSdk['set'],
          update: ctx.rtdb.update as unknown as MultiPathUpdateProbeSdk['update'],
          remove: ctx.rtdb.remove as unknown as MultiPathUpdateProbeSdk['remove'],
          get: ctx.rtdb.get as unknown as MultiPathUpdateProbeSdk['get'],
          onValue: ctx.rtdb.onValue as unknown as MultiPathUpdateProbeSdk['onValue'],
        },
        ctx.base,
        adminWrite,
      );
      expect(
        actual.singleClientWriteOrderAndListenerTiming.listenerSawUpdateBeforeAwaitResolved,
      ).toBe(true);
      expect(actual as unknown).toEqual(load('rtdb-modular-multipath-update-and-write-order'));
    });

    it('rtdb-modular-push-value-and-nested-servertimestamp (rtdb-modular#M18, #M20, #M22)', async () => {
      const ctx = await createContext();
      const actual = await observePushValueAndNestedServerTimestamp(
        {
          db: ctx.db as unknown as PushAndNestedServerTimestampSdk['db'],
          ref: ctx.rtdb.ref as unknown as PushAndNestedServerTimestampSdk['ref'],
          child: ctx.rtdb.child as unknown as PushAndNestedServerTimestampSdk['child'],
          set: ctx.rtdb.set as unknown as PushAndNestedServerTimestampSdk['set'],
          update: ctx.rtdb.update as unknown as PushAndNestedServerTimestampSdk['update'],
          push: ctx.rtdb.push as unknown as PushAndNestedServerTimestampSdk['push'],
          get: ctx.rtdb.get as unknown as PushAndNestedServerTimestampSdk['get'],
          serverTimestamp:
            ctx.rtdb.serverTimestamp as unknown as PushAndNestedServerTimestampSdk['serverTimestamp'],
        },
        ctx.base,
      );
      expect(actual.serverTimestampSentinelMarker.markerShape).toEqual({ '.sv': 'timestamp' });
      expect(actual as unknown).toEqual(load('rtdb-modular-push-value-and-nested-servertimestamp'));
    });

    it('rtdb-modular-rules-validate-and-denied-writes (rtdb-modular#M25, #M37c, #M37f, #M37g, #M76)', async () => {
      const ctx = await createContext(VALIDATE_AND_DENIAL_REPLAY_RULES);
      const adminWrite = await authenticateAndMakeAdminSeeder(ctx);
      const actual = await observeRulesValidateAndDeniedWrites(
        {
          db: ctx.db as unknown as RulesValidateAndDeniedWritesSdk['db'],
          ref: ctx.rtdb.ref as unknown as RulesValidateAndDeniedWritesSdk['ref'],
          set: ctx.rtdb.set as unknown as RulesValidateAndDeniedWritesSdk['set'],
          update: ctx.rtdb.update as unknown as RulesValidateAndDeniedWritesSdk['update'],
          remove: ctx.rtdb.remove as unknown as RulesValidateAndDeniedWritesSdk['remove'],
          get: ctx.rtdb.get as unknown as RulesValidateAndDeniedWritesSdk['get'],
          onValue: ctx.rtdb.onValue as unknown as RulesValidateAndDeniedWritesSdk['onValue'],
          runTransaction:
            ctx.rtdb.runTransaction as unknown as RulesValidateAndDeniedWritesSdk['runTransaction'],
        },
        ctx.base,
        adminWrite,
      );
      expect(actual.nonFunctionTransactionValidation).toEqual({
        timing: 'synchronous-throw',
        isTypeError: true,
      });
      expect(actual as unknown).toEqual(load('rtdb-modular-rules-validate-and-denied-writes'));
    });
  });
}
