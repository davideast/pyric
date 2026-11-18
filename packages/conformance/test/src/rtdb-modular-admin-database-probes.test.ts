import { describe, expect, test } from 'bun:test';
import {
  deleteApp as deleteUpstreamAdminApp,
  initializeApp as initializeUpstreamAdminApp,
} from 'firebase-admin/app';
import { getDatabase as getUpstreamAdminDatabase } from 'firebase-admin/database';
import { deleteApp as deletePyricAdminApp, initializeApp as initializePyricAdminApp } from 'pyric-admin/app';
import { getDatabase as getPyricAdminDatabase, ServerValue } from 'pyric-admin/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeAdminConnectionAndOnDisconnect,
  probe as adminDisconnectProbe,
} from '../../probes/rtdb-modular/rtdb-modular-admin-connection-and-ondisconnect.ts';
import {
  observeAdminRefNavigationAndUrlErrors,
  probe as adminRefNavProbe,
  type SyncThrowSummary,
} from '../../probes/rtdb-modular/rtdb-modular-admin-ref-navigation-and-url-errors.ts';
import {
  observeAdminWritesSentinelsAndValidation,
  probe as adminWritesProbe,
  type AdminServerValueApi,
  type AdminWriteValidationCase,
} from '../../probes/rtdb-modular/rtdb-modular-admin-writes-sentinels-and-validation.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';

const RTDB_ADMIN_PROBE_IDS = [
  'rtdb-modular-admin-connection-and-ondisconnect',
  'rtdb-modular-admin-ref-navigation-and-url-errors',
  'rtdb-modular-admin-writes-sentinels-and-validation',
] as const;

let seq = 0;

function createSharedAdminHandles() {
  seq += 1;
  const databaseUrl = `https://demo-rtdb-admin-${seq}-default-rtdb.firebaseio.com`;
  const sandbox = initializeSandbox({ projectId: `demo-rtdb-admin-${seq}` });
  const appA = initializePyricAdminApp(
    { sandbox, projectId: `demo-rtdb-admin-${seq}`, databaseURL: databaseUrl },
    `pyric-admin-probe-a-${seq}`,
  );
  const appB = initializePyricAdminApp(
    { sandbox, projectId: `demo-rtdb-admin-${seq}`, databaseURL: databaseUrl },
    `pyric-admin-probe-b-${seq}`,
  );
  return {
    databaseUrl,
    appA,
    appB,
    dbA: getPyricAdminDatabase(appA),
    dbB: getPyricAdminDatabase(appB),
    async cleanup() {
      await Promise.all([deletePyricAdminApp(appA), deletePyricAdminApp(appB)]);
    },
  };
}

describe('RTDB modular firebase-admin probes (sdk-probes)', () => {
  test('registers all 3 firebase-admin RTDB probes on sdk-probes with linked rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of RTDB_ADMIN_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const expectedLinks: ReadonlyArray<[typeof adminDisconnectProbe, string[]]> = [
      [adminDisconnectProbe, ['rtdb-admin#6']],
      [adminRefNavProbe, ['rtdb-admin#2']],
      [adminWritesProbe, ['rtdb-admin#3']],
    ];
    for (const [probeRecord, rowIds] of expectedLinks) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'dedicated-rtdb']);
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow).toBe(rowIds.join(', '));
      expect(probeRecord.rowIds).toEqual(rowIds);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of RTDB_ADMIN_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    for (const id of RTDB_ADMIN_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('observes Reference navigation, scrubbed URLs, and upstream empty-path/null-isEqual throws', async () => {
    const handles = createSharedAdminHandles();
    try {
      const adminAdapter = handles.dbA as unknown as Parameters<
        typeof observeAdminRefNavigationAndUrlErrors
      >[0];
      const result = await observeAdminRefNavigationAndUrlErrors(
        adminAdapter,
        handles.databaseUrl,
        '/pyric_oracle/rtdb_nav_1',
      );

      expect(result.rootRef).toEqual({
        noArgKey: null,
        noArgParentIsNull: true,
        noArgToString: '<databaseOrigin>/',
        slashArgEqualsNoArg: true,
        undefinedArgEqualsNoArg: true,
      });
      expect(result.nestedNavigation).toEqual({
        leafKey: 'ord-1',
        parentKey: 'orders',
        rootKey: null,
        rootParentIsNull: true,
        toString: '<databaseOrigin>/<runPath>/nav/orders/ord-1',
        toJSONEqualsToString: true,
        slashNormalizedIsEqual: true,
        siblingIsEqual: false,
        childChainingIsEqual: true,
      });
      expect(result.refFromUrlLiveRouting).toEqual({
        urlRefEqualsPathRef: true,
        queryStringIgnoredKey: 'urlTarget',
        writtenViaRefFromUrlReadViaRef: { routed: 'ok', count: 3 },
      });

      const hostMismatch: SyncThrowSummary = result.syncThrows.refFromUrlHostMismatch;
      expect(hostMismatch.threw).toBe(true);
      expect(hostMismatch.message !== null && !hostMismatch.message.includes('demo-rtdb-admin')).toBe(
        true,
      );
      expect(result.syncThrows.refFromUrlWithFragment.threw).toBe(true);
      expect(result.syncThrows.refFromUrlMalformed.threw).toBe(true);
    } finally {
      await handles.cleanup();
    }

    const upstreamApp = initializeUpstreamAdminApp(
      {
        projectId: 'demo-upstream-admin',
        databaseURL: 'https://demo-upstream-admin-default-rtdb.firebaseio.com',
      },
      'upstream-admin-ref-check',
    );
    try {
      const upstreamDb = getUpstreamAdminDatabase(upstreamApp);
      upstreamDb.goOffline();
      expect(() => upstreamDb.ref('')).toThrow(/Paths must be non-empty strings/);
      expect(() => upstreamDb.ref('orders/ord-1').isEqual(null as never)).toThrow(/Query\.isEqual/);
    } finally {
      await deleteUpstreamAdminApp(upstreamApp);
    }
  });

  test('observes writes, ServerValue sentinels, ordered push keys, callbacks, and sync validation', async () => {
    const handles = createSharedAdminHandles();
    try {
      const adminAdapter = handles.dbA as unknown as Parameters<
        typeof observeAdminWritesSentinelsAndValidation
      >[0];
      const svAdapter: AdminServerValueApi = ServerValue;
      const result = await observeAdminWritesSentinelsAndValidation(
        adminAdapter,
        svAdapter,
        '/pyric_oracle/rtdb_writes_1',
      );

      expect(result.setUpdateRemove).toEqual({
        afterMultiPathUpdate: {
          profile: { name: 'Ada', role: 'engineer' },
          keep: true,
          count: 1,
        },
        afterRemoveExists: false,
      });

      expect(result.pushAndCallbacks).toEqual({
        pushKeyCount: 3,
        allKeysLength20: true,
        keysStrictlyIncreasing: true,
        syncKeyAvailableBeforeAwait: true,
        pushedValuesInOrder: ['first', 'second', 'third'],
        callbacksDeliveredNullError: {
          set: true,
          update: true,
          remove: true,
          push: true,
        },
      });

      expect(result.sentinels).toEqual({
        timestampIsFiniteInteger: true,
        timestampWithinPlausibleWindow: true,
        incrementFromMissing: 5,
        incrementPositiveThenNegative: 7,
        incrementFloatFromNumber: 3.75,
      });

      expect(result.validationCases.length).toBe(9);
      for (const c of result.validationCases) {
        const typedCase: AdminWriteValidationCase = c;
        expect(typedCase.threwSynchronously).toBe(true);
        expect(typedCase.errorName).toBe('Error');
        expect(typedCase.message !== null && !typedCase.message.includes('rtdb_writes_1')).toBe(
          true,
        );
      }
      expect(result.baselineUnchangedAfterRefusedWrites).toEqual({ intact: true });
    } finally {
      await handles.cleanup();
    }
  });

  test('observes goOffline()/goOnline() and queued onDisconnect set, setWithPriority, update, remove, and cancel', async () => {
    const handles = createSharedAdminHandles();
    try {
      const writerAdapter = handles.dbA as unknown as Parameters<
        typeof observeAdminConnectionAndOnDisconnect
      >[0];
      const observerAdapter = handles.dbB as unknown as Parameters<
        typeof observeAdminConnectionAndOnDisconnect
      >[1];

      const result = await observeAdminConnectionAndOnDisconnect(
        writerAdapter,
        observerAdapter,
        '/pyric_oracle/rtdb_disc_1',
      );

      expect(result.beforeGoOffline).toEqual({
        s1Val: { state: 'online', retries: 1 },
        ephemeralExists: true,
        cancelledVal: { keep: 'untouched' },
      });
      expect(result.afterFirstGoOffline).toEqual({
        s1Val: { state: 'offline' },
        s2Val: {
          state: 'disconnected',
          keep: 'yes',
          meta: { reason: 'goOffline' },
        },
        prioVal: 'offline-prio',
        prioPriority: 42,
        ephemeralExists: false,
        cancelledVal: { keep: 'untouched' },
      });
      expect(result.afterGoOnlineAndSecondGoOfflineWithoutRequeue).toEqual({
        reconnectedWriteVal: { state: 'reconnected' },
        remainedUnchangedOnSecondGoOffline: { state: 'reconnected' },
      });
    } finally {
      await handles.cleanup();
    }
  });
});
