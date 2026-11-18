import { describe, expect, test } from 'bun:test';
import { deleteApp as deleteUpstreamApp, initializeApp as initializeUpstreamApp } from 'firebase/app';
import * as upstreamRtdb from 'firebase/database';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getDatabase as getAdminDatabase } from 'pyric-admin/database';
import * as pyricRtdb from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeArrayWriteNormalization,
  probe as arrayWriteNormProbe,
  type ArrayWriteNormalizationSdk,
} from '../../probes/rtdb-modular/rtdb-modular-array-write-normalization.ts';
import {
  observeNullAndEmptyAncestorPruning,
  probe as ancestorPruningProbe,
  type AncestorPruningProbeSdk,
} from '../../probes/rtdb-modular/rtdb-modular-null-and-empty-ancestor-pruning.ts';
import {
  observeSparseIntegerArrayCoercion,
  probe as sparseArrayCoercionProbe,
  type SparseArrayCoercionClientSdk,
  type SparseArraySnapshotInspection,
} from '../../probes/rtdb-modular/rtdb-modular-sparse-integer-array-coercion.ts';
import {
  observeSyncWriteAndDisconnectValidation,
  probe as syncValidationProbe,
  scrubBasePathFromValidationMessage,
  type SyncWriteValidationProbeSdk,
  type ValidationCallOutcome,
} from '../../probes/rtdb-modular/rtdb-modular-sync-write-and-disconnect-validation.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const RTDB_NORM_AND_VALIDATION_PROBE_IDS = [
  'rtdb-modular-array-write-normalization',
  'rtdb-modular-null-and-empty-ancestor-pruning',
  'rtdb-modular-sparse-integer-array-coercion',
  'rtdb-modular-sync-write-and-disconnect-validation',
] as const;

let sandboxSeq = 0;

function createSandboxPair() {
  sandboxSeq += 1;
  const sandbox = initializeSandbox({ projectId: `demo-rtdb-norm-${sandboxSeq}` });
  const rawClientDb = pyricRtdb.getDatabase(sandbox.withAuth({ uid: 'probe-user' }));
  pyricRtdb.sandbox.setRules(rawClientDb, {
    rules: {
      '.read': 'auth != null',
      '.write': 'auth != null',
    },
  });
  const adminApp = initializeAdminApp({ sandbox }, `demo-rtdb-norm-admin-${sandboxSeq}`);
  const adminDb = getAdminDatabase(adminApp);
  return {
    clientDb: rawClientDb as unknown as ArrayWriteNormalizationSdk['db'],
    adminApp,
    adminDb: adminDb as unknown as Parameters<typeof observeSparseIntegerArrayCoercion>[1],
  };
}

describe('RTDB modular normalization and validation staged probes (sdk-probes)', () => {
  test('registers all 4 normalization and validation probes on sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of RTDB_NORM_AND_VALIDATION_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      arrayWriteNormProbe,
      ancestorPruningProbe,
      sparseArrayCoercionProbe,
      syncValidationProbe,
    ];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config', 'dedicated-rtdb']);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(RTDB_NORM_AND_VALIDATION_PROBE_IDS, {
      rig: 'sdk-probes',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    for (const id of RTDB_NORM_AND_VALIDATION_PROBE_IDS) {
      expect(lines.some((line) => line.includes(id))).toBe(true);
    }
  });

  test('observes write-boundary array normalization and interior/trailing null pruning', async () => {
    const { clientDb, adminApp } = createSandboxPair();
    try {
      const sdk: ArrayWriteNormalizationSdk = {
        db: clientDb,
        ref: pyricRtdb.ref as unknown as ArrayWriteNormalizationSdk['ref'],
        child: pyricRtdb.child as unknown as ArrayWriteNormalizationSdk['child'],
        set: pyricRtdb.set as unknown as ArrayWriteNormalizationSdk['set'],
        get: pyricRtdb.get as unknown as ArrayWriteNormalizationSdk['get'],
      };

      const result = await observeArrayWriteNormalization(sdk, '/probe_run/arrayNorm');
      expect(result.denseArray).toEqual({
        isArray: true,
        val: ['alpha', 'beta', 'gamma'],
        exportVal: { '0': 'alpha', '1': 'beta', '2': 'gamma' },
        size: 3,
        hasChildren: true,
        hasChild1: true,
        hasLeadingZeroChild01: false,
        directChild1Exists: true,
        directChild1Val: 'beta',
        forEachEntries: [
          { key: '0', val: 'alpha' },
          { key: '1', val: 'beta' },
          { key: '2', val: 'gamma' },
        ],
        afterChild1OverwriteVal: ['alpha', 'BETA', 'gamma'],
      });

      expect(result.arrayWithNulls).toEqual({
        isArray: true,
        length: 3,
        ownKeys: ['0', '2'],
        hasIndex1InOperator: false,
        size: 2,
        hasChild1: false,
        directChild1Exists: false,
        exportVal: { '0': 'x', '2': 'z' },
        forEachEntries: [
          { key: '0', val: 'x' },
          { key: '2', val: 'z' },
        ],
      });
    } finally {
      await deleteAdminApp(adminApp);
    }
  });

  test('observes sparse integer-key array coercion across client and admin DataSnapshot surfaces', async () => {
    const { clientDb, adminApp, adminDb } = createSandboxPair();
    try {
      const clientSdk: SparseArrayCoercionClientSdk = {
        db: clientDb,
        ref: pyricRtdb.ref as unknown as SparseArrayCoercionClientSdk['ref'],
        set: pyricRtdb.set as unknown as SparseArrayCoercionClientSdk['set'],
        setWithPriority:
          pyricRtdb.setWithPriority as unknown as SparseArrayCoercionClientSdk['setWithPriority'],
        get: pyricRtdb.get as unknown as SparseArrayCoercionClientSdk['get'],
      };

      const result = await observeSparseIntegerArrayCoercion(
        clientSdk,
        adminDb,
        '/probe_run/sparseCoerce',
      );

      const expectedSparseShape: SparseArraySnapshotInspection = {
        exists: true,
        isArray: true,
        length: 4,
        ownKeys: ['0', '1', '3'],
        hasHoleIndexInOperator: false,
        holeIndexIsUndefined: true,
        exportVal: { '0': 'a', '1': 'b', '3': 'd' },
        toJSON: { '0': 'a', '1': 'b', '3': 'd' },
        priority: null,
        childCount: 3,
        hasChildren: true,
        hasPresentChild: true,
        hasMissingHoleChild: false,
        presentChildVal: 'b',
        missingHoleChildExists: false,
        forEachKeys: ['0', '1', '3'],
        earlyExitVisitedKeys: ['0', '1'],
        earlyExitReturnedTrue: true,
      };
      expect(result.sparseUnderThreshold.client).toEqual(expectedSparseShape);
      expect(result.sparseUnderThreshold.admin).toEqual(expectedSparseShape);

      expect(result.exactBoundaryCoerced.client.isArray).toBe(true);
      expect(result.exactBoundaryCoerced.client.length).toBe(4);
      expect(result.exactBoundaryCoerced.client.ownKeys).toEqual(['0', '3']);
      expect(result.exactBoundaryCoerced.admin.isArray).toBe(true);
      expect(result.exactBoundaryCoerced.admin.ownKeys).toEqual(['0', '3']);

      expect(result.exactBoundaryObject.client.isArray).toBe(false);
      expect(result.exactBoundaryObject.client.ownKeys).toEqual(['0', '4']);
      expect(result.exactBoundaryObject.admin.isArray).toBe(false);
      expect(result.exactBoundaryObject.admin.ownKeys).toEqual(['0', '4']);

      expect(result.nonCanonicalKeys).toEqual({
        leadingZeroClientIsArray: false,
        leadingZeroAdminIsArray: false,
        negativeKeyClientIsArray: false,
        negativeKeyAdminIsArray: false,
      });

      expect(result.arrayWithPriority.clientVal).toEqual(['p0', 'p1']);
      expect(result.arrayWithPriority.clientExportVal).toEqual({
        '0': 'p0',
        '1': 'p1',
        '.priority': 7,
      });
      expect(result.arrayWithPriority.clientPriority).toBe(7);
      expect(result.arrayWithPriority.adminVal).toEqual(['p0', 'p1']);
    } finally {
      await deleteAdminApp(adminApp);
    }
  });

  test('observes null child pruning, set(ref, {}) removal, and deep empty-ancestor collapse', async () => {
    const { clientDb, adminApp } = createSandboxPair();
    try {
      const sdk: AncestorPruningProbeSdk = {
        db: clientDb,
        ref: pyricRtdb.ref as unknown as AncestorPruningProbeSdk['ref'],
        set: pyricRtdb.set as unknown as AncestorPruningProbeSdk['set'],
        update: pyricRtdb.update as unknown as AncestorPruningProbeSdk['update'],
        get: pyricRtdb.get as unknown as AncestorPruningProbeSdk['get'],
      };

      const result = await observeNullAndEmptyAncestorPruning(sdk, '/probe_run/pruning');
      expect(result.setEmptyObjectRemovesSubtree).toEqual({
        beforeExists: true,
        afterLeafExists: false,
        afterLeafVal: null,
        afterParentExists: false,
      });
      expect(result.nestedNullAndEmptyObjectWrite).toEqual({
        exists: true,
        val: { a: 1 },
        forEachKeys: ['a'],
        hasNullChildB: false,
        hasEmptyNestedChildC: false,
        hasAllNullArrayChildF: false,
      });
      expect(result.deepLeafNullCollapsesAncestors).toEqual({
        beforeBranchExists: true,
        afterLeafExists: false,
        afterTwigExists: false,
        afterBranchExists: false,
        afterTreeExists: false,
      });
      expect(result.multiPathUpdateNullPruning).toEqual({
        val: { right: { b: 2 } },
        hasCollapsedLeftChild: false,
        hasRemainingRightChild: true,
      });
    } finally {
      await deleteAdminApp(adminApp);
    }
  });

  test('scrubs run basePath from validation messages and preserves baseline data across refused writes', async () => {
    const { clientDb, adminApp } = createSandboxPair();
    try {
      const sdk: SyncWriteValidationProbeSdk = {
        db: clientDb,
        ref: pyricRtdb.ref as unknown as SyncWriteValidationProbeSdk['ref'],
        set: pyricRtdb.set as unknown as SyncWriteValidationProbeSdk['set'],
        update: pyricRtdb.update as unknown as SyncWriteValidationProbeSdk['update'],
        push: pyricRtdb.push as unknown as SyncWriteValidationProbeSdk['push'],
        setPriority: pyricRtdb.setPriority as unknown as SyncWriteValidationProbeSdk['setPriority'],
        setWithPriority:
          pyricRtdb.setWithPriority as unknown as SyncWriteValidationProbeSdk['setWithPriority'],
        onDisconnect:
          pyricRtdb.onDisconnect as unknown as SyncWriteValidationProbeSdk['onDisconnect'],
        get: pyricRtdb.get as unknown as SyncWriteValidationProbeSdk['get'],
      };

      const result = await observeSyncWriteAndDisconnectValidation(
        sdk,
        '/pyric_oracle/rtdb-unit-run-1',
      );
      expect(result.cases.length).toBe(26);
      for (const entry of result.cases) {
        const typedEntry: ValidationCallOutcome = entry;
        expect(typedEntry.timing === 'synchronous-throw' || typedEntry.timing === 'asynchronous-reject').toBe(
          true,
        );
        expect(typedEntry.errorName).toBe('Error');
        expect(typedEntry.hasCode).toBe(false);
        expect(typedEntry.message !== null && !typedEntry.message.includes('rtdb-unit-run-1')).toBe(
          true,
        );
      }

      expect(result.pushUndefinedArgMintsKeyWithoutThrowing).toEqual({
        threwSynchronously: false,
        mintedKeyLength: 20,
      });
      expect(result.storedDataAfterRefusedCalls).toEqual({
        val: { baseline: 'intact' },
        priority: null,
      });
    } finally {
      await deleteAdminApp(adminApp);
    }

    const upstreamApp = initializeUpstreamApp(
      { databaseURL: 'https://demo-offline-sync-val-default-rtdb.firebaseio.com' },
      'offline-upstream-sync-val-check',
    );
    try {
      const upstreamDb = upstreamRtdb.getDatabase(upstreamApp);
      upstreamRtdb.goOffline(upstreamDb);
      const nodeRef = upstreamRtdb.ref(upstreamDb, 'pyric_oracle/rtdb-check-1/validation/node');
      expect(() => upstreamRtdb.set(nodeRef, { a: NaN })).toThrow(
        "set failed: value argument contains NaN in property 'pyric_oracle.rtdb-check-1.validation.node.a'",
      );
      expect(() => upstreamRtdb.push(nodeRef, NaN)).toThrow(
        "push failed: value argument contains NaN in property 'pyric_oracle.rtdb-check-1.validation.node'",
      );
      const keyOnlyRef = upstreamRtdb.push(nodeRef, undefined);
      expect(typeof keyOnlyRef.key).toBe('string');
      expect(
        scrubBasePathFromValidationMessage(
          "set failed: value argument contains NaN in property 'pyric_oracle.rtdb_176343_abcd.validation.node.a'",
          '/pyric_oracle/rtdb_176343_abcd',
        ),
      ).toBe("set failed: value argument contains NaN in property 'validation.node.a'");
    } finally {
      await deleteUpstreamApp(upstreamApp);
    }
  });
});
