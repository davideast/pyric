import { describe, expect, test } from 'bun:test';
import {
  deleteApp as deleteUpstreamAdminApp,
  initializeApp as initializeUpstreamAdminApp,
} from 'firebase-admin/app';
import { getDatabaseWithUrl as getUpstreamAdminDatabaseWithUrl } from 'firebase-admin/database';
import {
  deleteApp as deletePyricAdminApp,
  initializeApp as initializePyricAdminApp,
} from 'pyric-admin/app';
import { getDatabase as getPyricAdminDatabase } from 'pyric-admin/database';
import {
  getDatabase as getClientDatabase,
  ref as clientRef,
  sandbox as databaseSandbox,
  setWithPriority as clientSetWithPriority,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  ADMIN_QUERY_PROBE_RULES,
  observeAdminQueryBoundsListenersAndContext,
  probe as adminQueryBoundsProbe,
  scrubAdminQueryError,
  type ContextValueDelivery,
  type QueryGetAndOnceKeys,
  type UnindexedOrderCheck,
  type WindowChildEventRecord,
} from '../../probes/rtdb-modular/rtdb-modular-admin-query-bounds-listeners-and-context.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';

const PROBE_ID = 'rtdb-modular-admin-query-bounds-listeners-and-context';

let seq = 0;

function createPyricAdminQueryHarness() {
  seq += 1;
  const projectId = `demo-admin-query-${seq}`;
  const runPath = `pyric_oracle/rtdb_q_${seq}`;
  const host = initializeSandbox({ projectId });
  const clientDb = getClientDatabase(host);
  databaseSandbox.setRules(clientDb, {
    rules: {
      '.read': true,
      '.write': true,
      pyric_oracle: {
        [`rtdb_q_${seq}`]: ADMIN_QUERY_PROBE_RULES,
      },
    },
  });
  const adminApp = initializePyricAdminApp(
    { sandbox: host, projectId },
    `pyric-admin-query-app-${seq}`,
  );
  const adminDb = getPyricAdminDatabase(adminApp);

  return {
    runPath,
    adminDb,
    async seedRankedPriorities(rankedSubpath: string): Promise<void> {
      const prefix = `${runPath}/${rankedSubpath}`;
      await clientSetWithPriority(clientRef(clientDb, `${prefix}/k1`), { label: 'one' }, 30);
      await clientSetWithPriority(clientRef(clientDb, `${prefix}/k2`), { label: 'two' }, 10);
      await adminDb.ref(`${prefix}/k3`).set({ label: 'no-prio' });
      await clientSetWithPriority(clientRef(clientDb, `${prefix}/k4`), { label: 'str-prio' }, 'high');
    },
    async cleanup(): Promise<void> {
      await deletePyricAdminApp(adminApp);
    },
  };
}

describe('RTDB modular firebase-admin query bounds, listeners, and context linked probe', () => {
  test('registers on sdk-probes linked to rtdb-admin#5 without pendingRowLink', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(adminQueryBoundsProbe.rig).toBe('sdk-probes');
    expect(adminQueryBoundsProbe.requires).toEqual(['web-config', 'dedicated-rtdb']);
    expect(adminQueryBoundsProbe.pendingRowLink).toBeUndefined();
    expect(adminQueryBoundsProbe.matrixRow).toBe('rtdb-admin#5');
    expect(adminQueryBoundsProbe.rowIds).toEqual(['rtdb-admin#5']);
    expect(adminQueryBoundsProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    expect(unfilteredIds.has(PROBE_ID)).toBe(true);

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    expect(previewLines.some((line) => line.includes(PROBE_ID))).toBe(true);
  });

  test('observes all 4 orderings, bounds/cursors/limits, 3-arg & 4-arg context, scoped off(), and child window events', async () => {
    const harness = createPyricAdminQueryHarness();
    try {
      const adminAdapter = harness.adminDb as unknown as Parameters<
        typeof observeAdminQueryBoundsListenersAndContext
      >[0];
      const result = await observeAdminQueryBoundsListenersAndContext(
        adminAdapter,
        `/${harness.runPath}`,
        harness.seedRankedPriorities,
      );

      const keyCheck: UnindexedOrderCheck = result.unindexedGetChecks.orderByKey;
      const prioCheck: UnindexedOrderCheck = result.unindexedGetChecks.orderByPriority;
      expect(keyCheck).toEqual({
        getResolved: true,
        getKeys: ['a', 'b', 'c'],
        getCode: null,
        getMessage: null,
        onceResolved: true,
        onceKeys: ['a', 'b', 'c'],
      });
      expect(prioCheck).toEqual({
        getResolved: true,
        getKeys: ['k3', 'k2', 'k1', 'k4'],
        getCode: null,
        getMessage: null,
        onceResolved: true,
        onceKeys: ['k3', 'k2', 'k1', 'k4'],
      });
      expect(result.unindexedGetChecks.orderByChild.onceKeys).toEqual(['a', 'b', 'c']);
      expect(result.unindexedGetChecks.orderByValue.onceKeys).toEqual(['k1', 'k2', 'k3']);
      if (result.unindexedGetChecks.orderByChild.getMessage !== null) {
        expect(result.unindexedGetChecks.orderByChild.getMessage.includes('rtdb_q_')).toBe(false);
      }

      const both = (keys: string[]): QueryGetAndOnceKeys => ({
        getKeys: keys,
        onceKeys: keys,
      });
      expect(result.indexedQueriesAndBounds).toEqual({
        orderByChildScoreAll: both(['c', 'b', 'a', 'd', 'e']),
        orderByNestedChildAll: both(['a', 'd', 'c', 'b', 'e']),
        inclusiveRangeStartAtEndAt: both(['b', 'a', 'd']),
        exclusiveRangeStartAfterEndBefore: both(['a', 'd']),
        cursorStartAtWithKey: both(['d', 'e']),
        cursorStartAfterWithKey: both(['d', 'e']),
        cursorEndAtWithKey: both(['c', 'b', 'a']),
        cursorEndBeforeWithKey: both(['c', 'b', 'a']),
        equalToValue: both(['a', 'd']),
        equalToValueAndKey: both(['d']),
        limitToFirstTwo: both(['a', 'd']),
        limitToLastTwo: both(['b', 'e']),
        orderByKeyNumericAndLexical: both(['2', '10', 'a', 'b', 'c']),
        orderByKeyBounded: both(['10', 'a', 'b']),
        orderByKeyEqualTo: both(['a']),
        orderByValueMixedTypesAll: both(['b1', 'b2', 'n0', 'n1', 'n2', 's1', 's2']),
        orderByValueEqualTo: both(['n1', 'n2']),
        orderByValueCursorAndLimitFirstTwo: both(['n2', 's1']),
        orderByValueLimitLastTwo: both(['s1', 's2']),
        orderByPriorityAll: both(['k3', 'k2', 'k1', 'k4']),
        orderByPriorityBounded: both(['k2', 'k1']),
        defaultOrderLimitFirstTwo: both(['k3', 'k2']),
      });

      expect(result.onceContextBinding).toEqual({
        threeArgTag: 'once-ctx-3',
        threeArgKeys: ['a', 'd'],
        fourArgTag: 'once-ctx-4',
        fourArgKeys: ['a', 'd'],
        promiseMatchedCallbackKeys: true,
      });

      const expectedInitialValue: ContextValueDelivery[] = [
        { tag: 'ctx-A', val: { step: 1 } },
        { tag: 'ctx-B', val: { step: 1 } },
        { tag: null, val: { step: 1 } },
      ];
      expect(result.valueContextAndScopedOff).toEqual({
        returnedOriginalCallback: true,
        initialDeliveries: expectedInitialValue,
        afterOffCtxA: [
          { tag: 'ctx-B', val: { step: 2 } },
          { tag: null, val: { step: 2 } },
        ],
        afterOffContextless: [{ tag: 'ctx-B', val: { step: 3 } }],
        afterOffAllValue: [],
      });

      const expectedInitialWindow: WindowChildEventRecord[] = [
        { event: 'child_added', key: 'a', prevKey: null, val: { rank: 1 }, tag: 'win-ctx' },
        { event: 'child_added', key: 'd', prevKey: 'a', val: { rank: 2 }, tag: 'win-ctx' },
      ];
      expect(result.queryChildWindowAndZeroArgOff).toEqual({
        initialWindowAdded: expectedInitialWindow,
        afterInWindowReorderAndChange: [
          { event: 'child_moved', key: 'd', prevKey: null, val: { rank: 0 }, tag: 'win-ctx' },
          { event: 'child_changed', key: 'd', prevKey: null, val: { rank: 0 }, tag: 'win-ctx' },
        ],
        afterWindowEvictAndEnter: [
          { event: 'child_moved', key: 'a', prevKey: 'd', val: { rank: 9 }, tag: 'win-ctx' },
          { event: 'child_changed', key: 'a', prevKey: 'd', val: { rank: 9 }, tag: 'win-ctx' },
          { event: 'child_removed', key: 'a', prevKey: null, val: { rank: 9 }, tag: 'win-ctx' },
          { event: 'child_added', key: 'c', prevKey: 'd', val: { rank: 3 }, tag: 'win-ctx' },
        ],
        countAfterZeroArgQueryOff: 0,
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('scrubs volatile run paths and hostnames and matches offline firebase-admin context semantics', async () => {
    const rawMsg =
      'Index not defined, add ".indexOn": "score", for path "/pyric_oracle/rtdb_m9x_42/adminQuery/unindexedItems", to the rules at https://demo-oracle.firebaseio.com';
    const scrubbed = scrubAdminQueryError(rawMsg, 'pyric_oracle/rtdb_m9x_42');
    expect(scrubbed).toBe(
      'Index not defined, add ".indexOn": "score", for path "/<base>/adminQuery/unindexedItems", to the rules at https://<db-host>',
    );

    const upstreamApp = initializeUpstreamAdminApp(
      { projectId: 'offline-admin-ctx' },
      'offline-admin-ctx-app',
    );
    try {
      const upstreamDb = getUpstreamAdminDatabaseWithUrl(
        'https://offline-admin-ctx-default-rtdb.firebaseio.com',
        upstreamApp,
      );
      upstreamDb.goOffline();
      const target = upstreamDb.ref('ctxCheck');
      void target.set({ step: 1 });

      const seen: Array<{ tag: string | null; step: number }> = [];
      function onVal(this: { tag?: string } | undefined, snap: { val(): { step: number } }): void {
        let tag: string | null = null;
        if (this && typeof this.tag === 'string') {
          tag = this.tag;
        }
        seen.push({ tag, step: snap.val().step });
      }
      const ctxA = { tag: 'ctx-A' };
      const ctxB = { tag: 'ctx-B' };
      target.on('value', onVal, ctxA);
      target.on('value', onVal, () => undefined, ctxB);
      target.on('value', onVal);

      seen.length = 0;
      target.off('value', onVal, ctxA);
      void target.set({ step: 2 });
      expect(seen).toEqual([
        { tag: 'ctx-B', step: 2 },
        { tag: null, step: 2 },
      ]);

      seen.length = 0;
      target.off('value', onVal);
      void target.set({ step: 3 });
      expect(seen).toEqual([{ tag: 'ctx-B', step: 3 }]);
      target.off('value');
    } finally {
      await deleteUpstreamAdminApp(upstreamApp);
    }
  });
});
