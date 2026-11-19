import { describe, expect, test } from 'bun:test';
import { deleteApp as deleteUpstreamApp, initializeApp as initializeUpstreamApp } from 'firebase/app';
import * as upstreamRtdb from 'firebase/database';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeMultiPathUpdateAndWriteOrder,
  probe as multiPathUpdateProbe,
  type MultiPathUpdateProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-multipath-update-and-write-order.ts';
import {
  observePushValueAndNestedServerTimestamp,
  probe as pushAndServerTimestampProbe,
  type PushAndNestedServerTimestampSdk,
} from '../../probes/rtdb-modular/rtdb-modular-push-value-and-nested-servertimestamp.ts';
import {
  observeRefNavigationAndAbsentGet,
  probe as refNavAndAbsentGetProbe,
  type RefNavigationAndAbsentGetSdk,
} from '../../probes/rtdb-modular/rtdb-modular-ref-navigation-and-absent-get.ts';
import {
  observeRulesValidateAndDeniedWrites,
  probe as rulesValidateAndDeniedProbe,
  type RejectedWriteShape,
  type RulesValidateAndDeniedWritesSdk,
} from '../../probes/rtdb-modular/rtdb-modular-rules-validate-and-denied-writes.ts';
import { loadObservations } from '../../src/ledger.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';

const RTDB_UPDATES_AND_VALIDATE_PROBE_IDS = [
  'rtdb-modular-multipath-update-and-write-order',
  'rtdb-modular-push-value-and-nested-servertimestamp',
  'rtdb-modular-ref-navigation-and-absent-get',
  'rtdb-modular-rules-validate-and-denied-writes',
] as const;

let sandboxCounter = 0;

function createSandboxHandle(rulesObject: Record<string, unknown>) {
  sandboxCounter += 1;
  const sandbox = initializeSandbox({ projectId: `demo-rtdb-updates-${sandboxCounter}` });
  const rawDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'probe-user' }));
  const rawAdminDb = pyricRtdb.getAdminDatabase(sandbox);
  pyricRtdb.sandbox.setRules(rawDb, { rules: rulesObject });
  return {
    db: rawDb as unknown as RefNavigationAndAbsentGetSdk['db'],
    async adminWriteAt(basePath: string, subpath: string, value: unknown): Promise<void> {
      const cleanBase = basePath.replace(/^\/+|\/+$/g, '');
      const cleanSub = subpath.replace(/^\/+|\/+$/g, '');
      let fullPath = cleanSub;
      if (cleanBase) {
        fullPath = `${cleanBase}/${cleanSub}`;
      }
      await pyricRtdb.set(pyricRtdb.ref(rawAdminDb, fullPath), value);
    },
  };
}

describe('RTDB modular updates, sentinels, and .validate probes (sdk-probes)', () => {
  test('links all 4 updates, sentinels, and .validate probes and committed observations to registry rows', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of RTDB_UPDATES_AND_VALIDATE_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const expectedLinks = [
      [
        'rtdb-modular-ref-navigation-and-absent-get',
        refNavAndAbsentGetProbe,
        'rtdb-modular#M4',
        [
          'rtdb-modular#M4',
          'rtdb-modular#M5',
          'rtdb-modular#M6',
          'rtdb-modular#M7',
          'rtdb-modular#M8',
          'rtdb-modular#M9',
        ],
      ],
      [
        'rtdb-modular-multipath-update-and-write-order',
        multiPathUpdateProbe,
        'rtdb-modular#M13',
        [
          'rtdb-modular#M13',
          'rtdb-modular#M14',
          'rtdb-modular#M15',
          'rtdb-modular#M16',
          'rtdb-modular#M16b',
          'rtdb-modular#VR2',
        ],
      ],
      [
        'rtdb-modular-push-value-and-nested-servertimestamp',
        pushAndServerTimestampProbe,
        'rtdb-modular#M18',
        ['rtdb-modular#M18', 'rtdb-modular#M20', 'rtdb-modular#M22'],
      ],
      [
        'rtdb-modular-rules-validate-and-denied-writes',
        rulesValidateAndDeniedProbe,
        'rtdb-modular#M25',
        [
          'rtdb-modular#M25',
          'rtdb-modular#M37c',
          'rtdb-modular#M37f',
          'rtdb-modular#M37g',
          'rtdb-modular#M76',
        ],
      ],
    ] as const;

    const observations = new Map(
      loadObservations().map((item) => [item.name, item] as const),
    );
    const pendingRowLinkIds = loadPendingRowLinkObservations();
    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    for (const [id, probeRecord, expectedMatrixRow, expectedRowIds] of expectedLinks) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'dedicated-rtdb']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow).toBe(expectedMatrixRow);
      expect(probeRecord.rowIds).toEqual([...expectedRowIds]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
      expect(pendingRowLinkIds.has(id)).toBe(false);
      expect(unfilteredIds.has(id)).toBe(true);
      const committed = observations.get(id);
      expect(committed).toBeDefined();
      expect(committed?.matrixRow).toBe(expectedMatrixRow);
      expect(committed?.rowIds).toEqual([...expectedRowIds]);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    for (const id of RTDB_UPDATES_AND_VALIDATE_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('observes ref navigation, DataSnapshot shape without numChildren, and absent get()', async () => {
    const { db } = createSandboxHandle({
      '.read': 'auth != null',
      '.write': 'auth != null',
    });
    const sdk: RefNavigationAndAbsentGetSdk = {
      db,
      ref: pyricRtdb.ref as unknown as RefNavigationAndAbsentGetSdk['ref'],
      child: pyricRtdb.child as unknown as RefNavigationAndAbsentGetSdk['child'],
      set: pyricRtdb.set as unknown as RefNavigationAndAbsentGetSdk['set'],
      get: pyricRtdb.get as unknown as RefNavigationAndAbsentGetSdk['get'],
    };

    const result = await observeRefNavigationAndAbsentGet(sdk, '/pyric_oracle/rtdb_nav_check');
    expect(result.rootAndPathRefs).toEqual({
      defaultRootKey: null,
      defaultRootParentIsNull: true,
      emptyStringPathThrewSync: true,
      emptyStringPathMessage:
        'child failed: path argument was an invalid path = "". Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"',
      pathRefKey: 'ord-1',
      composedChildKey: 'ord-1',
      composedParentKey: 'orders',
      composedRootKey: null,
      composedRootParentIsNull: true,
      composedRootMatchesDefaultRoot: true,
      composedMatchesDirectPathRef: true,
      scrubbedComposedToString: '<rootOrigin>/<runPath>/refNav/orders/ord-1',
    });
    expect(result.populatedGetSnapshotShape).toEqual({
      exists: true,
      key: 'ord-1',
      val: { item: 'widget', qty: 2 },
      toJSON: { item: 'widget', qty: 2 },
      size: 2,
      hasChildren: true,
      directChildVal: 'widget',
      missingChildVal: null,
      hasNumChildrenProperty: false,
    });
    expect(result.absentGetSnapshotShape).toEqual({
      exists: false,
      key: 'missing-ord',
      val: null,
      toJSON: null,
      size: 0,
      hasChildren: false,
    });
  });

  test('observes shallow merge, multi-path atomic denial rollback, overlapping path rejection, and write ordering', async () => {
    const basePath = 'probe_updates';
    const { db, adminWriteAt } = createSandboxHandle({
      probe_updates: {
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
    });
    const sdk: MultiPathUpdateProbeSdk = {
      db,
      ref: pyricRtdb.ref as unknown as MultiPathUpdateProbeSdk['ref'],
      child: pyricRtdb.child as unknown as MultiPathUpdateProbeSdk['child'],
      set: pyricRtdb.set as unknown as MultiPathUpdateProbeSdk['set'],
      update: pyricRtdb.update as unknown as MultiPathUpdateProbeSdk['update'],
      remove: pyricRtdb.remove as unknown as MultiPathUpdateProbeSdk['remove'],
      get: pyricRtdb.get as unknown as MultiPathUpdateProbeSdk['get'],
      onValue: pyricRtdb.onValue as unknown as MultiPathUpdateProbeSdk['onValue'],
    };

    const result = await observeMultiPathUpdateAndWriteOrder(sdk, basePath, (subpath, val) =>
      adminWriteAt(basePath, subpath, val),
    );
    expect(result.shallowMergeAndNullDelete).toEqual({
      afterShallowMerge: { a: 1, b: 20, c: 3, dropMe: 'old' },
      afterNullKeyDelete: { a: 1, b: 20, c: 3 },
    });
    expect(result.multiPathAtomicAllowed).toEqual({
      val: {
        left: { keep: 'L', v: 10 },
        right: { keep: 'R', v: 20 },
      },
    });
    expect(result.multiPathAtomicPartialDenialRollback).toEqual({
      rejected: true,
      errorCode: 'PERMISSION_DENIED',
      allowedBranchUnchanged: { x: 1 },
      deniedBranchUnchanged: { y: 1 },
    });
    expect(result.overlappingPathsRejectedBeforeWrite.storedAfterOverlappingCalls).toEqual({
      a: { initial: true },
    });
    expect(result.singleClientWriteOrderAndListenerTiming).toEqual({
      updateThenChildSetVal: { x: 3, keep: 'ok' },
      updateThenRemoveExists: false,
      listenerSawUpdateBeforeAwaitResolved: true,
      observedSequence: [{ step: 0 }, { step: 1 }],
    });

    const upstreamApp = initializeUpstreamApp(
      { databaseURL: 'https://demo-offline-overlap-default-rtdb.firebaseio.com' },
      'offline-overlap-check',
    );
    try {
      const upstreamDb = upstreamRtdb.getDatabase(upstreamApp);
      upstreamRtdb.goOffline(upstreamDb);
      const r = upstreamRtdb.ref(upstreamDb, 'overlap');
      expect(() => upstreamRtdb.update(r, { a: { x: 1 }, 'a/y': 2 })).toThrow(/ancestor/);
      expect(() => upstreamRtdb.update(r, { 'a/y': 2, a: { x: 1 } })).toThrow(/ancestor/);
    } finally {
      await deleteUpstreamApp(upstreamApp);
    }
  });

  test('observes push(ref, value) child write and nested serverTimestamp() sentinel resolution', async () => {
    const { db } = createSandboxHandle({
      '.read': 'auth != null',
      '.write': 'auth != null',
    });
    const sdk: PushAndNestedServerTimestampSdk = {
      db,
      ref: pyricRtdb.ref as unknown as PushAndNestedServerTimestampSdk['ref'],
      child: pyricRtdb.child as unknown as PushAndNestedServerTimestampSdk['child'],
      set: pyricRtdb.set as unknown as PushAndNestedServerTimestampSdk['set'],
      update: pyricRtdb.update as unknown as PushAndNestedServerTimestampSdk['update'],
      push: pyricRtdb.push as unknown as PushAndNestedServerTimestampSdk['push'],
      get: pyricRtdb.get as unknown as PushAndNestedServerTimestampSdk['get'],
      serverTimestamp:
        pyricRtdb.serverTimestamp as unknown as PushAndNestedServerTimestampSdk['serverTimestamp'],
    };

    const result = await observePushValueAndNestedServerTimestamp(sdk, '/probe_sv');
    expect(result.pushWithValue).toEqual({
      keyStartsWithHyphen: true,
      keyLength: 20,
      directGetVal: { title: 'ship-probes', done: false },
      viaParentChildGetVal: { title: 'ship-probes', done: false },
      parentSize: 1,
    });
    expect(result.serverTimestampSentinelMarker).toEqual({
      markerShape: { '.sv': 'timestamp' },
    });
    expect(result.nestedMultiPathServerTimestamp).toEqual({
      topAuditUpdatedIsInteger: true,
      deepItemTouchedIsInteger: true,
      bothWithinPlausibleWindow: true,
      bothEqualInSingleAtomicUpdate: true,
      preservedSiblingField: 'preserved',
      deepNonSentinelField: 'updated',
    });
  });

  test('observes rules-denied remove/runTransaction preservation, defensive clone, commit fan-out, and .validate rules', async () => {
    const basePath = 'probe_validate';
    const { db, adminWriteAt } = createSandboxHandle({
      probe_validate: {
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
    });
    const sdk: RulesValidateAndDeniedWritesSdk = {
      db,
      ref: pyricRtdb.ref as unknown as RulesValidateAndDeniedWritesSdk['ref'],
      set: pyricRtdb.set as unknown as RulesValidateAndDeniedWritesSdk['set'],
      update: pyricRtdb.update as unknown as RulesValidateAndDeniedWritesSdk['update'],
      remove: pyricRtdb.remove as unknown as RulesValidateAndDeniedWritesSdk['remove'],
      get: pyricRtdb.get as unknown as RulesValidateAndDeniedWritesSdk['get'],
      onValue: pyricRtdb.onValue as unknown as RulesValidateAndDeniedWritesSdk['onValue'],
      runTransaction:
        pyricRtdb.runTransaction as unknown as RulesValidateAndDeniedWritesSdk['runTransaction'],
    };

    const result = await observeRulesValidateAndDeniedWrites(sdk, basePath, (subpath, val) =>
      adminWriteAt(basePath, subpath, val),
    );
    const removeOutcome: RejectedWriteShape = result.deniedRemove.outcome;
    expect(removeOutcome).toEqual({
      rejected: true,
      errorName: 'Error',
      code: 'PERMISSION_DENIED',
      message: 'PERMISSION_DENIED: Permission denied',
    });
    expect(result.deniedRemove.preservedVal).toEqual({ secret: 'keep-me' });

    expect(result.deniedTransactionPreservesValue).toEqual({
      outcome: {
        rejected: true,
        errorName: 'Error',
        code: null,
        message: 'permission_denied',
      },
      preservedVal: { balance: 100 },
    });

    expect(result.transactionDefensiveCloneAndCommitFanout).toEqual({
      mutatedAbortCommitted: false,
      valAfterMutatedAbort: { count: 10, nested: { tag: 'v1' } },
      committedTxCommitted: true,
      committedSnapshotVal: { count: 15, nested: { tag: 'v2' } },
      listenerObservedValues: [
        { count: 10, nested: { tag: 'v1' } },
        { count: 15, nested: { tag: 'v2' } },
      ],
    });

    expect(result.validateRuleEnforcement).toEqual({
      validSetVal: {
        sibling: 'unchanged',
        item: { title: 'valid-seed', qty: 3 },
      },
      invalidSetRejected: true,
      invalidMultiPathUpdateRejected: true,
      invalidTransactionRejected: true,
      preservedAfterAllInvalidWrites: {
        sibling: 'unchanged',
        item: { title: 'valid-seed', qty: 3 },
      },
    });
    expect(result.nonFunctionTransactionValidation).toEqual({
      timing: 'synchronous-throw',
      isTypeError: true,
    });
  });
});
