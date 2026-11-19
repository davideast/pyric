import { describe, expect, test } from 'bun:test';
import { getApps } from 'firebase/app';
import { probe as bundleSsrProbe } from '../../probes/firestore/firestore-offline-bundle-ssr-and-clear-persistence.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';

const PROBE_ID = 'firestore-offline-bundle-ssr-and-clear-persistence';

describe('firestore-offline-bundle-ssr-and-clear-persistence linked probe (sdk-probes)', () => {
  test('registers on sdk-probes linked to firestore#142, firestore#153, and firestore#154 with empty requires', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(bundleSsrProbe.rig).toBe('sdk-probes');
    expect(bundleSsrProbe.requires).toEqual([]);
    expect(bundleSsrProbe.pendingRowLink).toBeUndefined();
    expect(bundleSsrProbe.matrixRow).toBe('firestore#153');
    expect(bundleSsrProbe.rowIds).toEqual(['firestore#142', 'firestore#153', 'firestore#154']);
    expect(bundleSsrProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    expect(unfilteredIds.has(PROBE_ID)).toBe(true);
    const explicitSelected = selectModularProbes(
      loaded,
      ['--probe', PROBE_ID],
      'sdk-probes',
      { includeUncapturedStaged: false },
    );
    expect(explicitSelected.map((entry) => entry.id)).toEqual([PROBE_ID]);

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    expect(previewLines.some((line) => line.includes(PROBE_ID))).toBe(true);
  });

  test('executes deterministically with fetchCalls === 0 and records bundle loading, SSR JSON hydration/resume, and clearIndexedDbPersistence preconditions', async () => {
    const run1 = await bundleSsrProbe.observe();
    const run2 = await bundleSsrProbe.observe();
    expect(run1).toEqual(run2);
    expect(getApps()).toEqual([]);
    expect(run1.fetchCalls).toBe(0);

    const bundleLoading = run1.bundleLoading as {
      isLoadBundleTaskInstance: boolean;
      onProgressCompleted: boolean;
      progressEvents: Array<{ taskState: string; documentsLoaded: number; totalDocuments: number }>;
      finalStringProgress: { taskState: string; documentsLoaded: number; totalDocuments: number; bytesLoaded: number; totalBytes: number };
      finalBytesProgress: { taskState: string; documentsLoaded: number; totalDocuments: number; bytesLoaded: number; totalBytes: number };
      uint8AlphaExists: boolean;
      arrayBufferOnNodePlatform: { threw: boolean; threwSynchronously: boolean; code: string | null };
      malformedBundle: { threw: boolean; threwSynchronously: boolean; progressErrorInvoked: boolean };
      cachedDocuments: {
        alpha: { exists: boolean; id: string; fromCache: boolean; data: unknown };
        beta: { exists: boolean; id: string; fromCache: boolean; data: unknown };
        ghost: { exists: boolean; id: string; fromCache: boolean; dataIsUndefined: boolean };
      };
      namedQueries: {
        foundIsQueryInstance: boolean;
        missingQueryIsNull: boolean;
        publishedQueryResult: { size: number; empty: boolean; fromCache: boolean; ids: string[] };
      };
    };
    expect(bundleLoading.isLoadBundleTaskInstance).toBe(true);
    expect(bundleLoading.onProgressCompleted).toBe(true);
    expect(bundleLoading.progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(bundleLoading.finalStringProgress.taskState).toBe('Success');
    expect(bundleLoading.finalStringProgress.documentsLoaded).toBe(3);
    expect(bundleLoading.finalStringProgress.totalDocuments).toBe(3);
    expect(bundleLoading.finalStringProgress.bytesLoaded).toBe(
      bundleLoading.finalStringProgress.totalBytes,
    );
    expect(bundleLoading.finalBytesProgress).toEqual(bundleLoading.finalStringProgress);
    expect(bundleLoading.uint8AlphaExists).toBe(true);
    expect(bundleLoading.arrayBufferOnNodePlatform).toMatchObject({
      threw: true,
      threwSynchronously: true,
      code: 'invalid-argument',
    });
    expect(bundleLoading.malformedBundle).toMatchObject({
      threw: true,
      threwSynchronously: false,
      progressErrorInvoked: true,
    });
    expect(bundleLoading.cachedDocuments.alpha).toEqual({
      exists: true,
      id: 'alpha',
      fromCache: true,
      data: { title: 'First Post', published: true, rank: 1 },
    });
    expect(bundleLoading.cachedDocuments.beta).toEqual({
      exists: true,
      id: 'beta',
      fromCache: true,
      data: { title: 'Draft Note', published: false, rank: 2 },
    });
    expect(bundleLoading.cachedDocuments.ghost).toEqual({
      exists: false,
      id: 'ghost',
      fromCache: true,
      dataIsUndefined: true,
    });
    expect(bundleLoading.namedQueries.foundIsQueryInstance).toBe(true);
    expect(bundleLoading.namedQueries.missingQueryIsNull).toBe(true);
    expect(bundleLoading.namedQueries.publishedQueryResult).toMatchObject({
      size: 1,
      empty: false,
      fromCache: true,
      ids: ['alpha'],
    });

    const ssrHydration = run1.ssrSnapshotHydration as {
      serializedEnvelope: {
        docJsonType: string | null;
        docJsonKeys: string[];
        queryJsonType: string | null;
        queryJsonKeys: string[];
      };
      hydratedExistingDoc: {
        isDocumentSnapshotInstance: boolean;
        exists: boolean;
        id: string;
        path: string;
        fromCache: boolean;
        hasPendingWrites: boolean;
        data: unknown;
        titleViaGet: unknown;
      };
      hydratedMissingDoc: {
        serializedType: string | null;
        serializedBundleIsEmpty: boolean;
        fromJsonOutcome: { threw: boolean; threwSynchronously: boolean };
      };
      hydratedQuerySnapshot: {
        isQuerySnapshotInstance: boolean;
        size: number;
        empty: boolean;
        fromCache: boolean;
        hasPendingWrites: boolean;
        docs: Array<{ id: string; path: string; isQueryDocumentSnapshotInstance: boolean }>;
      };
      resumedDocumentListener: {
        unsubscribeReturnType: string;
        snapshot: { isDocumentSnapshotInstance: boolean; exists: boolean; id: string; path: string; fromCache: boolean };
      };
      resumedQueryListener: {
        unsubscribeReturnType: string;
        snapshot: { isQuerySnapshotInstance: boolean; size: number; ids: string[]; fromCache: boolean };
      };
      invalidSsrJsonChecks: Record<string, { threw: boolean; threwSynchronously: boolean; code: string | null }>;
    };
    expect(ssrHydration.serializedEnvelope).toEqual({
      docJsonType: 'firestore/documentSnapshot/1.0',
      docJsonKeys: ['bundle', 'bundleName', 'bundleSource', 'type'],
      queryJsonType: 'firestore/querySnapshot/1.0',
      queryJsonKeys: ['bundle', 'bundleName', 'bundleSource', 'type'],
    });
    expect(ssrHydration.hydratedExistingDoc).toEqual({
      isDocumentSnapshotInstance: true,
      exists: true,
      id: 'alpha',
      path: 'articles/alpha',
      fromCache: false,
      hasPendingWrites: false,
      data: { title: 'First Post', published: true, rank: 1 },
      titleViaGet: 'First Post',
    });
    expect(ssrHydration.hydratedMissingDoc.serializedType).toBe('firestore/documentSnapshot/1.0');
    expect(ssrHydration.hydratedMissingDoc.serializedBundleIsEmpty).toBe(true);
    expect(ssrHydration.hydratedMissingDoc.fromJsonOutcome).toMatchObject({
      threw: true,
      threwSynchronously: true,
    });
    expect(ssrHydration.hydratedQuerySnapshot).toMatchObject({
      isQuerySnapshotInstance: true,
      size: 1,
      empty: false,
      fromCache: false,
      hasPendingWrites: false,
      docs: [
        {
          id: 'alpha',
          path: 'articles/alpha',
          isQueryDocumentSnapshotInstance: true,
        },
      ],
    });
    expect(ssrHydration.resumedDocumentListener).toMatchObject({
      unsubscribeReturnType: 'function',
      snapshot: {
        isDocumentSnapshotInstance: true,
        exists: true,
        id: 'alpha',
        path: 'articles/alpha',
        fromCache: true,
      },
    });
    expect(ssrHydration.resumedQueryListener).toMatchObject({
      unsubscribeReturnType: 'function',
      snapshot: {
        isQuerySnapshotInstance: true,
        size: 1,
        ids: ['alpha'],
        fromCache: true,
      },
    });
    expect(ssrHydration.invalidSsrJsonChecks.docFromEmptyObject.code).toBe('invalid-argument');
    expect(ssrHydration.invalidSsrJsonChecks.docFromQueryJson.code).toBe('invalid-argument');
    expect(ssrHydration.invalidSsrJsonChecks.queryFromEmptyObject.code).toBe('invalid-argument');
    expect(ssrHydration.invalidSsrJsonChecks.queryFromDocJson.code).toBe('invalid-argument');

    const clearLifecycle = run1.clearPersistenceLifecycle as {
      beforeStart: { threw: boolean; isPromise: boolean; resolvedUndefined: boolean };
      whileRunning: { threw: boolean; threwSynchronously: boolean; code: string | null };
      afterTerminate: { threw: boolean; isPromise: boolean; resolvedUndefined: boolean };
    };
    expect(clearLifecycle.beforeStart).toMatchObject({
      threw: false,
      isPromise: true,
      resolvedUndefined: true,
    });
    expect(clearLifecycle.whileRunning).toMatchObject({
      threw: true,
      threwSynchronously: true,
      code: 'failed-precondition',
    });
    expect(clearLifecycle.afterTerminate).toMatchObject({
      threw: false,
      isPromise: true,
      resolvedUndefined: true,
    });
  });
});
