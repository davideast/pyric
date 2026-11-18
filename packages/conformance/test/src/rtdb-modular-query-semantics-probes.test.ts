import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as pyricRtdb from 'pyric/database';
import { loadObservations } from '../../src/ledger.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import {
  observeOrderByKeyNameCompare,
  probe as orderByKeyProbe,
  type OrderByKeyProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-orderbykey-namecompare.ts';
import {
  observeQueryChainingAndForEachOrder,
  probe as queryChainingProbe,
  type QueryChainingAndForEachProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-query-chaining-and-foreach-order.ts';
import {
  observeQueryConstraintConflicts,
  probe as queryConflictProbe,
  probeQueryConstraintConflicts,
  type ConstraintConflictOutcome,
  type ConstraintConflictProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-query-constraint-conflicts.ts';
import {
  observeQueryEmptyAndOversizedWindow,
  probe as emptyAndOversizedProbe,
  type EmptyAndOversizedWindowProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-query-empty-and-oversized-window.ts';
import {
  observeQueryPrimitiveLeafAndObjectTies,
  probe as primitiveLeafAndObjectTiesProbe,
  type PrimitiveLeafAndObjectTiesProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-query-primitive-leaf-and-object-ties.ts';
import {
  observeStartAtKeyTieBreakerAndMissingChild,
  probe as tieBreakerAndMissingChildProbe,
  type TieBreakerAndMissingChildProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-startat-key-tiebreaker-and-missing-child.ts';

const RTDB_QUERY_SEMANTICS_PROBE_IDS = [
  'rtdb-modular-orderbykey-namecompare',
  'rtdb-modular-query-chaining-and-foreach-order',
  'rtdb-modular-query-constraint-conflicts',
  'rtdb-modular-query-empty-and-oversized-window',
  'rtdb-modular-query-primitive-leaf-and-object-ties',
  'rtdb-modular-startat-key-tiebreaker-and-missing-child',
] as const;

function createSandboxProbeHandle(): {
  db: OrderByKeyProbeSdk['db'];
  sdk: typeof pyricRtdb;
} {
  const sandbox = initializeSandbox({ projectId: 'demo-rtdb-query-probes' });
  const rawDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'probe-user' }));
  pyricRtdb.sandbox.setRules(rawDb, {
    rules: {
      probe_run: {
        '.read': 'auth != null',
        '.write': 'auth != null',
        items: {
          '.indexOn': ['group', 'pos'],
        },
        absent: {
          '.indexOn': ['pos'],
        },
        chained: {
          '.indexOn': ['rank'],
        },
        nonIntKeys: {
          '.indexOn': ['rank'],
        },
        intKeys: {
          '.indexOn': ['rank'],
        },
        ties: {
          '.indexOn': ['pos'],
        },
        missingField: {
          '.indexOn': ['pos', 'meta/score'],
        },
        leafNum: {
          '.indexOn': '.value',
        },
        objTies: {
          '.indexOn': '.value',
        },
      },
    },
  });
  const db = rawDb as unknown as OrderByKeyProbeSdk['db'];
  return { db, sdk: pyricRtdb };
}

describe('RTDB modular query semantics probes (sdk-probes)', () => {
  test('links all 6 RTDB query semantics probes and committed observations to registry rows', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of RTDB_QUERY_SEMANTICS_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const expectedLinks = [
      [
        'rtdb-modular-orderbykey-namecompare',
        orderByKeyProbe,
        'rtdb-modular#M50',
        ['rtdb-modular#M50'],
      ],
      [
        'rtdb-modular-query-chaining-and-foreach-order',
        queryChainingProbe,
        'rtdb-modular#M36',
        ['rtdb-modular#M36', 'rtdb-modular#M60', 'rtdb-modular#M61'],
      ],
      [
        'rtdb-modular-query-constraint-conflicts',
        queryConflictProbe,
        'rtdb-modular#M69',
        ['rtdb-modular#M69'],
      ],
      [
        'rtdb-modular-query-empty-and-oversized-window',
        emptyAndOversizedProbe,
        'rtdb-modular#M53',
        ['rtdb-modular#M53', 'rtdb-modular#M56', 'rtdb-modular#M59'],
      ],
      [
        'rtdb-modular-query-primitive-leaf-and-object-ties',
        primitiveLeafAndObjectTiesProbe,
        'rtdb-modular#M64',
        ['rtdb-modular#M64', 'rtdb-modular#M72'],
      ],
      [
        'rtdb-modular-startat-key-tiebreaker-and-missing-child',
        tieBreakerAndMissingChildProbe,
        'rtdb-modular#M62',
        ['rtdb-modular#M62', 'rtdb-modular#M63'],
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
      expect(unfilteredIds.has(id)).toBe(true);
      expect(pendingRowLinkIds.has(id)).toBe(false);

      const committed = observations.get(id);
      expect(committed).toBeDefined();
      if (committed !== undefined) {
        expect(committed.matrixRow).toBe(expectedMatrixRow);
        expect(committed.rowIds).toEqual([...expectedRowIds]);
      }
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    for (const id of RTDB_QUERY_SEMANTICS_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('observes orderByKey nameCompare and numeric cursor bounds deterministically', async () => {
    const { db, sdk } = createSandboxProbeHandle();
    const adapter: OrderByKeyProbeSdk = {
      db,
      ref: sdk.ref as unknown as OrderByKeyProbeSdk['ref'],
      set: sdk.set as unknown as OrderByKeyProbeSdk['set'],
      get: sdk.get as unknown as OrderByKeyProbeSdk['get'],
      onValue: sdk.onValue as unknown as OrderByKeyProbeSdk['onValue'],
      query: sdk.query as unknown as OrderByKeyProbeSdk['query'],
      orderByKey: sdk.orderByKey as unknown as OrderByKeyProbeSdk['orderByKey'],
      startAt: sdk.startAt as unknown as OrderByKeyProbeSdk['startAt'],
      endAt: sdk.endAt as unknown as OrderByKeyProbeSdk['endAt'],
    };

    const result = await observeOrderByKeyNameCompare(adapter, '/probe_run');
    expect(result.unfilteredMixedOrder.forEachKeys).toEqual([
      '-10',
      '-2',
      '0',
      '1',
      '01',
      '2',
      '10',
      'a',
      'b',
    ]);
    expect(result.negativeAndLeadingZeroWindow.forEachKeys).toEqual(['-2', '0', '1', '01']);
    expect(result.numericCursorWindowGet.forEachKeys).toEqual(['2', '10']);
    expect(result.numericCursorWindowOnValue.forEachKeys).toEqual(['2', '10']);
  });

  test('observes empty equalTo(), oversized limits, and initial onValue() on an absent path', async () => {
    const { db, sdk } = createSandboxProbeHandle();
    const adapter: EmptyAndOversizedWindowProbeSdk = {
      db,
      ref: sdk.ref as unknown as EmptyAndOversizedWindowProbeSdk['ref'],
      set: sdk.set as unknown as EmptyAndOversizedWindowProbeSdk['set'],
      get: sdk.get as unknown as EmptyAndOversizedWindowProbeSdk['get'],
      onValue: sdk.onValue as unknown as EmptyAndOversizedWindowProbeSdk['onValue'],
      query: sdk.query as unknown as EmptyAndOversizedWindowProbeSdk['query'],
      orderByChild: sdk.orderByChild as unknown as EmptyAndOversizedWindowProbeSdk['orderByChild'],
      orderByKey: sdk.orderByKey as unknown as EmptyAndOversizedWindowProbeSdk['orderByKey'],
      equalTo: sdk.equalTo as unknown as EmptyAndOversizedWindowProbeSdk['equalTo'],
      limitToFirst: sdk.limitToFirst as unknown as EmptyAndOversizedWindowProbeSdk['limitToFirst'],
      limitToLast: sdk.limitToLast as unknown as EmptyAndOversizedWindowProbeSdk['limitToLast'],
    };

    const result = await observeQueryEmptyAndOversizedWindow(adapter, '/probe_run');
    expect(result.equalToNoMatchGet).toEqual({
      exists: false,
      size: 0,
      val: null,
      forEachKeys: [],
    });
    expect(result.equalToNoMatchOnValue).toEqual({
      exists: false,
      size: 0,
      val: null,
      forEachKeys: [],
    });
    expect(result.oversizedLimitToFirstGet.size).toBe(2);
    expect(result.oversizedLimitToFirstGet.forEachKeys).toEqual(['k1', 'k2']);
    expect(result.oversizedLimitToLastGet.size).toBe(2);
    expect(result.oversizedLimitToLastGet.forEachKeys).toEqual(['k1', 'k2']);
    expect(result.absentPathInitialOnValue).toEqual({
      exists: false,
      size: 0,
      val: null,
      forEachKeys: [],
    });
  });

  test('observes nested query() chaining parity and forEach() order vs Object.keys(val())', async () => {
    const { db, sdk } = createSandboxProbeHandle();
    const adapter: QueryChainingAndForEachProbeSdk = {
      db,
      ref: sdk.ref as unknown as QueryChainingAndForEachProbeSdk['ref'],
      set: sdk.set as unknown as QueryChainingAndForEachProbeSdk['set'],
      get: sdk.get as unknown as QueryChainingAndForEachProbeSdk['get'],
      onValue: sdk.onValue as unknown as QueryChainingAndForEachProbeSdk['onValue'],
      query: sdk.query as unknown as QueryChainingAndForEachProbeSdk['query'],
      orderByChild: sdk.orderByChild as unknown as QueryChainingAndForEachProbeSdk['orderByChild'],
      startAt: sdk.startAt as unknown as QueryChainingAndForEachProbeSdk['startAt'],
      endAt: sdk.endAt as unknown as QueryChainingAndForEachProbeSdk['endAt'],
      limitToFirst: sdk.limitToFirst as unknown as QueryChainingAndForEachProbeSdk['limitToFirst'],
    };

    const result = await observeQueryChainingAndForEachOrder(adapter, '/probe_run');
    expect(result.chainedVsFlatRangeLimit.queriesEqual).toBe(true);
    expect(result.chainedVsFlatRangeLimit.chained.forEachKeys).toEqual(['b', 'c']);
    expect(result.chainedVsFlatRangeLimit.flat.forEachKeys).toEqual(['b', 'c']);
    expect(result.forEachOrderVsValNonIntegerKeys.get.forEachKeys).toEqual(['z', 'a', 'm']);
    expect(result.forEachOrderVsValSparseIntegerKeys.get.forEachKeys).toEqual(['2', '10', '1']);
    expect(result.forEachOrderVsValSparseIntegerKeys.get.valObjectKeys).toEqual(['1', '2', '10']);
    expect(result.forEachOrderVsValSparseIntegerKeys.onValue.forEachKeys).toEqual([
      '2',
      '10',
      '1',
    ]);
  });

  test('observes startAt/endAt key tie-breaking and null-first missing-field orderByChild()', async () => {
    const { db, sdk } = createSandboxProbeHandle();
    const adapter: TieBreakerAndMissingChildProbeSdk = {
      db,
      ref: sdk.ref as unknown as TieBreakerAndMissingChildProbeSdk['ref'],
      set: sdk.set as unknown as TieBreakerAndMissingChildProbeSdk['set'],
      get: sdk.get as unknown as TieBreakerAndMissingChildProbeSdk['get'],
      query: sdk.query as unknown as TieBreakerAndMissingChildProbeSdk['query'],
      orderByChild:
        sdk.orderByChild as unknown as TieBreakerAndMissingChildProbeSdk['orderByChild'],
      startAt: sdk.startAt as unknown as TieBreakerAndMissingChildProbeSdk['startAt'],
      endAt: sdk.endAt as unknown as TieBreakerAndMissingChildProbeSdk['endAt'],
    };

    const result = await observeStartAtKeyTieBreakerAndMissingChild(adapter, '/probe_run');
    expect(result.startAtKeyC).toEqual(['c', 'd', 'e']);
    expect(result.startAtKeyTwoEndAtKeyB).toEqual(['2', '10', 'a', 'b']);
    expect(result.missingDirectChildOrder).toEqual([
      'absentObj',
      'scalarChild',
      'boolFalse',
      'numZero',
      'strEmpty',
    ]);
    expect(result.missingNestedChildOrder).toEqual([
      'absentObj',
      'scalarChild',
      'boolFalse',
      'numZero',
      'strEmpty',
    ]);
  });

  test('observes primitive-leaf query projection and object-child order-equality', async () => {
    const { db, sdk } = createSandboxProbeHandle();
    const adapter: PrimitiveLeafAndObjectTiesProbeSdk = {
      db,
      ref: sdk.ref as unknown as PrimitiveLeafAndObjectTiesProbeSdk['ref'],
      set: sdk.set as unknown as PrimitiveLeafAndObjectTiesProbeSdk['set'],
      get: sdk.get as unknown as PrimitiveLeafAndObjectTiesProbeSdk['get'],
      onValue: sdk.onValue as unknown as PrimitiveLeafAndObjectTiesProbeSdk['onValue'],
      query: sdk.query as unknown as PrimitiveLeafAndObjectTiesProbeSdk['query'],
      orderByKey: sdk.orderByKey as unknown as PrimitiveLeafAndObjectTiesProbeSdk['orderByKey'],
      orderByValue:
        sdk.orderByValue as unknown as PrimitiveLeafAndObjectTiesProbeSdk['orderByValue'],
      startAt: sdk.startAt as unknown as PrimitiveLeafAndObjectTiesProbeSdk['startAt'],
      limitToFirst:
        sdk.limitToFirst as unknown as PrimitiveLeafAndObjectTiesProbeSdk['limitToFirst'],
    };

    const result = await observeQueryPrimitiveLeafAndObjectTies(adapter, '/probe_run');
    expect(result.primitiveLeafOrderByKeyUnfiltered).toEqual({
      exists: true,
      size: 0,
      val: 42,
      forEachKeys: [],
    });
    expect(result.primitiveLeafOrderByValueUnfiltered).toEqual({
      exists: true,
      size: 0,
      val: 42,
      forEachKeys: [],
    });
    expect(result.primitiveLeafLimited).toEqual({
      exists: false,
      size: 0,
      val: null,
      forEachKeys: [],
    });
    expect(result.primitiveLeafBounded).toEqual({
      exists: false,
      size: 0,
      val: null,
      forEachKeys: [],
    });
    expect(result.objectChildrenOrderByValueKeys).toEqual(['2', '10', 'a', 'b']);
    expect(result.keyReorderedRewriteDelivery).toEqual({
      fireCount: 2,
      deliveredKeysPerFire: [
        ['2', '10', 'a', 'b'],
        ['2', '10', 'a', 'b'],
      ],
      bFieldASequence: [1, 2],
    });
  });

  test('observes upstream firebase/database and pyric/database query() constraint-conflict parity', async () => {
    const upstream = await probeQueryConstraintConflicts();
    const { db, sdk } = createSandboxProbeHandle();
    const adapter: ConstraintConflictProbeSdk = {
      query: sdk.query as unknown as ConstraintConflictProbeSdk['query'],
      orderByChild: sdk.orderByChild as unknown as ConstraintConflictProbeSdk['orderByChild'],
      orderByKey: sdk.orderByKey as unknown as ConstraintConflictProbeSdk['orderByKey'],
      orderByValue: sdk.orderByValue as unknown as ConstraintConflictProbeSdk['orderByValue'],
      orderByPriority:
        sdk.orderByPriority as unknown as ConstraintConflictProbeSdk['orderByPriority'],
      startAt: sdk.startAt as unknown as ConstraintConflictProbeSdk['startAt'],
      startAfter: sdk.startAfter as unknown as ConstraintConflictProbeSdk['startAfter'],
      endAt: sdk.endAt as unknown as ConstraintConflictProbeSdk['endAt'],
      endBefore: sdk.endBefore as unknown as ConstraintConflictProbeSdk['endBefore'],
      equalTo: sdk.equalTo as unknown as ConstraintConflictProbeSdk['equalTo'],
      limitToFirst: sdk.limitToFirst as unknown as ConstraintConflictProbeSdk['limitToFirst'],
      limitToLast: sdk.limitToLast as unknown as ConstraintConflictProbeSdk['limitToLast'],
    };
    const baseRef = sdk.ref(
      db as unknown as Parameters<typeof sdk.ref>[0],
      'items',
    ) as unknown as Parameters<typeof observeQueryConstraintConflicts>[1];
    const local = observeQueryConstraintConflicts(adapter, baseRef);

    expect(local).toEqual(upstream);
    const conflictOutcome: ConstraintConflictOutcome = upstream.orderByChildThenOrderByKey;
    expect(conflictOutcome).toEqual({
      threw: true,
      errorMessage: "orderByKey: You can't combine multiple orderBy calls.",
    });
    expect(upstream.validRangeAndLimitControl).toEqual({ threw: false, errorMessage: null });
    expect(upstream.validChainedRangeAndLimitControl).toEqual({
      threw: false,
      errorMessage: null,
    });
  });
});
