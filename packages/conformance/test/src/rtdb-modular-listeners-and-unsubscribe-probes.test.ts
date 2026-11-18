import { describe, expect, test } from 'bun:test';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeOffTargetedAndChildRegistrars,
  probe as offTargetedProbe,
  type OffTargetedAndChildRegistrarsSdk,
  type PlainChildEventRecord,
} from '../../probes/rtdb-modular/rtdb-modular-off-targeted-and-child-registrars.ts';
import {
  observeOnValueInitialDescendantAndSuppression,
  probe as onValueSuppressionProbe,
  type OnValueSuppressionProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-onvalue-initial-descendant-and-suppression.ts';
import {
  observeOnValueOnlyOnceAndUnsubReturn,
  probe as onlyOnceAndUnsubProbe,
  type OnValueOnlyOnceAndUnsubSdk,
} from '../../probes/rtdb-modular/rtdb-modular-onvalue-onlyonce-and-unsub-return.ts';
import {
  observeQueryWindowChildListeners,
  probe as queryWindowChildProbe,
  type QueryChildEventRecord,
  type QueryChildRemovedRecord,
  type QueryWindowChildListenersSdk,
} from '../../probes/rtdb-modular/rtdb-modular-query-window-child-listeners.ts';
import { loadObservations } from '../../src/ledger.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';

const RTDB_LISTENERS_PROBE_IDS = [
  'rtdb-modular-off-targeted-and-child-registrars',
  'rtdb-modular-onvalue-initial-descendant-and-suppression',
  'rtdb-modular-onvalue-onlyonce-and-unsub-return',
  'rtdb-modular-query-window-child-listeners',
] as const;

let sandboxIdx = 0;

function createListenerSandbox(rulesObj: Record<string, unknown>) {
  sandboxIdx += 1;
  const sandbox = initializeSandbox({ projectId: `demo-rtdb-listeners-${sandboxIdx}` });
  const rawDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'listener-user' }));
  pyricRtdb.sandbox.setRules(rawDb, { rules: rulesObj });
  return rawDb as unknown as OnValueSuppressionProbeSdk['db'];
}

describe('RTDB modular listeners, unsubscribe, and query child-window probes (sdk-probes)', () => {
  test('links all 4 listener and unsubscribe probes and committed observations to registry rows', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of RTDB_LISTENERS_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const expectedLinks = [
      [
        'rtdb-modular-onvalue-initial-descendant-and-suppression',
        onValueSuppressionProbe,
        'rtdb-modular#M26',
        ['rtdb-modular#M26', 'rtdb-modular#M27', 'rtdb-modular#M28', 'rtdb-modular#M29'],
      ],
      [
        'rtdb-modular-onvalue-onlyonce-and-unsub-return',
        onlyOnceAndUnsubProbe,
        'rtdb-modular#M30',
        ['rtdb-modular#M30', 'rtdb-modular#M74', 'rtdb-modular#132'],
      ],
      [
        'rtdb-modular-off-targeted-and-child-registrars',
        offTargetedProbe,
        'rtdb-modular#M31',
        ['rtdb-modular#M31', 'rtdb-modular#M44', 'rtdb-modular#M48', 'rtdb-modular#140'],
      ],
      [
        'rtdb-modular-query-window-child-listeners',
        queryWindowChildProbe,
        'rtdb-modular#M75b',
        ['rtdb-modular#M75b'],
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
    for (const id of RTDB_LISTENERS_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('observes immediate initial fire, no-change suppression (-0, rewrite, sibling update), and descendant re-firing', async () => {
    const db = createListenerSandbox({
      '.read': 'auth != null',
      '.write': 'auth != null',
    });
    const sdk: OnValueSuppressionProbeSdk = {
      db,
      ref: pyricRtdb.ref as unknown as OnValueSuppressionProbeSdk['ref'],
      child: pyricRtdb.child as unknown as OnValueSuppressionProbeSdk['child'],
      set: pyricRtdb.set as unknown as OnValueSuppressionProbeSdk['set'],
      update: pyricRtdb.update as unknown as OnValueSuppressionProbeSdk['update'],
      onValue: pyricRtdb.onValue as unknown as OnValueSuppressionProbeSdk['onValue'],
    };

    const result = await observeOnValueInitialDescendantAndSuppression(sdk, '/probe_suppress');
    expect(result.absentInitialFire).toEqual({
      exists: false,
      val: null,
    });
    expect(result.watchedFireCount).toBe(3);
    expect(result.watchedDeliverySequence).toEqual([
      { n: 0, nested: { step: 1 } },
      { n: 2, nested: { step: 1 } },
      { n: 2, nested: { step: 9 } },
    ]);
  });

  test('observes returned unsubscribe function contract and { onlyOnce: true } on present and absent paths', async () => {
    const db = createListenerSandbox({
      '.read': 'auth != null',
      '.write': 'auth != null',
    });
    const sdk: OnValueOnlyOnceAndUnsubSdk = {
      db,
      ref: pyricRtdb.ref as unknown as OnValueOnlyOnceAndUnsubSdk['ref'],
      set: pyricRtdb.set as unknown as OnValueOnlyOnceAndUnsubSdk['set'],
      onValue: pyricRtdb.onValue as unknown as OnValueOnlyOnceAndUnsubSdk['onValue'],
    };

    const result = await observeOnValueOnlyOnceAndUnsubReturn(sdk, '/probe_once');
    expect(result.unsubscribeReturnContract).toEqual({
      returnTypeOf: 'function',
      isPlainObject: false,
      deliveriesBeforeUnsub: [1, 2],
      deliveriesAfterUnsubAndSubsequentWrite: [1, 2],
      companionSentinelSawPostUnsubWrite: true,
    });
    expect(result.onlyOncePopulatedPath).toEqual({
      onlyOnceDeliveries: [10],
      companionSawSubsequentWrite: true,
    });
    expect(result.onlyOnceAbsentPath).toEqual({
      onlyOnceDeliveries: [null],
      companionSawSubsequentPopulate: true,
    });
  });

  test('observes child registrar isolation (no onChildChanged on add/delete) and targeted off() precision', async () => {
    const db = createListenerSandbox({
      '.read': 'auth != null',
      '.write': 'auth != null',
    });
    const sdk: OffTargetedAndChildRegistrarsSdk = {
      db,
      ref: pyricRtdb.ref as unknown as OffTargetedAndChildRegistrarsSdk['ref'],
      child: pyricRtdb.child as unknown as OffTargetedAndChildRegistrarsSdk['child'],
      setWithPriority:
        pyricRtdb.setWithPriority as unknown as OffTargetedAndChildRegistrarsSdk['setWithPriority'],
      setPriority:
        pyricRtdb.setPriority as unknown as OffTargetedAndChildRegistrarsSdk['setPriority'],
      remove: pyricRtdb.remove as unknown as OffTargetedAndChildRegistrarsSdk['remove'],
      onValue: pyricRtdb.onValue as unknown as OffTargetedAndChildRegistrarsSdk['onValue'],
      onChildAdded:
        pyricRtdb.onChildAdded as unknown as OffTargetedAndChildRegistrarsSdk['onChildAdded'],
      onChildChanged:
        pyricRtdb.onChildChanged as unknown as OffTargetedAndChildRegistrarsSdk['onChildChanged'],
      onChildRemoved:
        pyricRtdb.onChildRemoved as unknown as OffTargetedAndChildRegistrarsSdk['onChildRemoved'],
      onChildMoved:
        pyricRtdb.onChildMoved as unknown as OffTargetedAndChildRegistrarsSdk['onChildMoved'],
      off: pyricRtdb.off as unknown as OffTargetedAndChildRegistrarsSdk['off'],
    };

    const result = await observeOffTargetedAndChildRegistrars(sdk, '/probe_off');
    const expectedInitialAdded: PlainChildEventRecord[] = [
      { key: 'a', val: { v: 1 }, prevKey: null },
      { key: 'b', val: { v: 2 }, prevKey: 'a' },
    ];
    expect(result.childRegistrarIsolation.initialAdded).toEqual(expectedInitialAdded);
    expect(result.childRegistrarIsolation.initialChangedCount).toBe(0);
    expect(result.childRegistrarIsolation.changedCountAfterAddChildC).toBe(0);
    expect(result.childRegistrarIsolation.changedAfterMutateChildB).toEqual([
      { key: 'b', val: { v: 20 }, prevKey: 'a' },
    ]);
    expect(result.childRegistrarIsolation.movedAfterPriorityChangeOnC).toEqual([
      { key: 'c', val: { v: 3 }, prevKey: null },
    ]);
    expect(result.childRegistrarIsolation.removedKeysAfterDeleteChildA).toEqual(['a']);
    expect(result.childRegistrarIsolation.changedCountAfterDeleteChildA).toBe(0);
    expect(result.targetedOffPrecision.valCb1CountAfterOffCb1AndWrite).toBe(
      result.targetedOffPrecision.valCb1CountBeforeOffCb1,
    );
    expect(result.targetedOffPrecision.valCb2CountAfterOffCb1AndWrite).toBe(
      result.targetedOffPrecision.valCb2CountBeforeOffCb1 + 1,
    );
    expect(result.targetedOffPrecision.valCb2CountAfterOffAllValueAndWrite).toBe(
      result.targetedOffPrecision.valCb2CountAfterOffCb1AndWrite,
    );
    expect(result.targetedOffPrecision.childChangedStillFiredAfterOffAllValue).toBe(true);
    expect(result.targetedOffPrecision.addedCountAfterUnsubChildAddedAndAddD).toBe(0);
    expect(result.targetedOffPrecision.changedCountAfterOffChildChangedCbAndWrite).toBe(0);
  });

  test('observes query-window child listeners respecting bounded orderByChild + limitToFirst windows', async () => {
    const db = createListenerSandbox({
      probe_qchild: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        scores: {
          '.indexOn': ['score'],
        },
      },
    });
    const sdk: QueryWindowChildListenersSdk = {
      db,
      ref: pyricRtdb.ref as unknown as QueryWindowChildListenersSdk['ref'],
      child: pyricRtdb.child as unknown as QueryWindowChildListenersSdk['child'],
      set: pyricRtdb.set as unknown as QueryWindowChildListenersSdk['set'],
      query: pyricRtdb.query as unknown as QueryWindowChildListenersSdk['query'],
      orderByChild:
        pyricRtdb.orderByChild as unknown as QueryWindowChildListenersSdk['orderByChild'],
      limitToFirst:
        pyricRtdb.limitToFirst as unknown as QueryWindowChildListenersSdk['limitToFirst'],
      onValue: pyricRtdb.onValue as unknown as QueryWindowChildListenersSdk['onValue'],
      onChildAdded:
        pyricRtdb.onChildAdded as unknown as QueryWindowChildListenersSdk['onChildAdded'],
      onChildChanged:
        pyricRtdb.onChildChanged as unknown as QueryWindowChildListenersSdk['onChildChanged'],
      onChildRemoved:
        pyricRtdb.onChildRemoved as unknown as QueryWindowChildListenersSdk['onChildRemoved'],
      onChildMoved:
        pyricRtdb.onChildMoved as unknown as QueryWindowChildListenersSdk['onChildMoved'],
    };

    const result = await observeQueryWindowChildListeners(sdk, 'probe_qchild');
    const expectedAdded: QueryChildEventRecord[] = [
      { key: 'a', val: { score: 10, tag: 'init' }, prevKey: null },
      { key: 'b', val: { score: 20, tag: 'init' }, prevKey: 'a' },
    ];
    const expectedDisplaced: QueryChildRemovedRecord[] = [
      { key: 'a', val: { score: 25, tag: 'reordered-a' } },
    ];
    expect(result).toEqual({
      initialWindowAdded: expectedAdded,
      afterOutOfWindowEditThenInWindowEditChanged: [
        { key: 'b', val: { score: 20, tag: 'edited-b' }, prevKey: 'a' },
      ],
      afterInWindowReorderMoved: [
        { key: 'a', val: { score: 25, tag: 'reordered-a' }, prevKey: 'b' },
      ],
      afterEnteringChildZAdded: [
        { key: 'z', val: { score: 5, tag: 'entered-z' }, prevKey: null },
      ],
      afterEnteringChildZDisplacedRemoved: expectedDisplaced,
    });
  });
});
