import { describe, expect, test } from 'bun:test';
import { getApps } from 'firebase/app';
import { probe as cacheInitProbe } from '../../probes/firestore/firestore-offline-cache-init-index-and-refequal.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const PROBE_ID = 'firestore-offline-cache-init-index-and-refequal';

describe('firestore-offline-cache-init-index-and-refequal staged probe (sdk-probes)', () => {
  test('registers on sdk-probes with pendingRowLink and empty requires and stays skipped in unfiltered runs until captured', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(cacheInitProbe.rig).toBe('sdk-probes');
    expect(cacheInitProbe.requires).toEqual([]);
    expect(cacheInitProbe.pendingRowLink).toBe(true);
    expect(cacheInitProbe.matrixRow).toBe('');
    expect(cacheInitProbe.rowIds).toEqual([]);
    expect(cacheInitProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    const explicitSelected = selectModularProbes(
      loaded,
      ['--probe', PROBE_ID],
      'sdk-probes',
      { includeUncapturedStaged: false },
    );
    expect(explicitSelected.map((entry) => entry.id)).toEqual([PROBE_ID]);

    expectStagedUntilCaptured(PROBE_ID, {
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

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    expect(previewLines.some((line) => line.includes(PROBE_ID))).toBe(true);
  });

  test('executes deterministically with fetchCalls === 0 and records cache tokens, initializeFirestore guards, index manager, setLogLevel, and refEqual behavior', async () => {
    const run1 = await cacheInitProbe.observe();
    const run2 = await cacheInitProbe.observe();
    expect(run1).toEqual(run2);
    expect(getApps()).toEqual([]);
    expect(run1.fetchCalls).toBe(0);

    const tokens = run1.cacheTokens as {
      cacheSizeUnlimitedConstant: number;
      singleTabDefault: { kind: string | null };
      multiTab: { kind: string | null };
      eagerGc: { kind: string | null };
      lruGcBounded: { kind: string | null };
      memCacheDefault: { kind: string | null };
      persCacheDefault: { kind: string | null };
      distinctIdentities: Record<string, boolean>;
    };
    expect(tokens.cacheSizeUnlimitedConstant).toBe(-1);
    expect(tokens.singleTabDefault.kind).toBe('persistentSingleTab');
    expect(tokens.multiTab.kind).toBe('PersistentMultipleTab');
    expect(tokens.eagerGc.kind).toBe('memoryEager');
    expect(tokens.lruGcBounded.kind).toBe('memoryLru');
    expect(tokens.memCacheDefault.kind).toBe('memory');
    expect(tokens.persCacheDefault.kind).toBe('persistent');
    expect(tokens.distinctIdentities).toEqual({
      singleTabEqualsMultiTab: false,
      eagerGcEqualsLruGc: false,
      memCacheEqualsPersCache: false,
    });

    const initHandles = run1.initializeFirestoreHandles as {
      isFirestoreInstance: boolean;
      typeProperty: string;
      appMatches: boolean;
      repeatEquivalentSettingsSameHandle: boolean;
      getFirestoreReturnsInitializedHandle: boolean;
      conflictingSettingsAfterInit: { threw: boolean; threwSynchronously: boolean; code: string | null };
      emptySettingsAfterDefaultGetFirestoreSameHandle: boolean;
      conflictingSettingsAfterDefaultGetFirestore: { threw: boolean; code: string | null };
      namedDatabaseDistinctFromDefault: boolean;
      namedDatabaseMatchesGetFirestoreNamed: boolean;
      conflictingSettingsOnNamedDatabase: { threw: boolean; code: string | null };
      otherAppDistinctHandle: boolean;
    };
    expect(initHandles.isFirestoreInstance).toBe(true);
    expect(initHandles.typeProperty).toBe('firestore');
    expect(initHandles.appMatches).toBe(true);
    expect(initHandles.repeatEquivalentSettingsSameHandle).toBe(true);
    expect(initHandles.getFirestoreReturnsInitializedHandle).toBe(true);
    expect(initHandles.conflictingSettingsAfterInit.threw).toBe(true);
    expect(initHandles.conflictingSettingsAfterInit.threwSynchronously).toBe(true);
    expect(initHandles.conflictingSettingsAfterInit.code).toBe('failed-precondition');
    expect(initHandles.emptySettingsAfterDefaultGetFirestoreSameHandle).toBe(true);
    expect(initHandles.conflictingSettingsAfterDefaultGetFirestore.code).toBe(
      'failed-precondition',
    );
    expect(initHandles.namedDatabaseDistinctFromDefault).toBe(true);
    expect(initHandles.namedDatabaseMatchesGetFirestoreNamed).toBe(true);
    expect(initHandles.conflictingSettingsOnNamedDatabase.code).toBe('failed-precondition');
    expect(initHandles.otherAppDistinctHandle).toBe(true);

    const indexManager = run1.persistentCacheIndexManager as {
      onMemoryLocalCacheIsNull: boolean;
      onPersistentLocalCacheIsNull: boolean;
      isPersistentCacheIndexManagerInstance: boolean;
      repeatGetReturnsSameInstance: boolean;
      typeTag: string | null;
      enableAutoCreation: { threw: boolean; returnType: string | null; isPromise: boolean } | null;
      disableAutoCreation: { threw: boolean; returnType: string | null; isPromise: boolean } | null;
      deleteAllIndexes: { threw: boolean; returnType: string | null; isPromise: boolean } | null;
      setIndexConfigurationStructured: { threw: boolean; isPromise: boolean; resolvedUndefined: boolean };
      setIndexConfigurationJson: { threw: boolean; isPromise: boolean; resolvedUndefined: boolean };
    };
    expect(indexManager.onMemoryLocalCacheIsNull).toBe(true);
    expect(indexManager.onPersistentLocalCacheIsNull).toBe(false);
    expect(indexManager.isPersistentCacheIndexManagerInstance).toBe(true);
    expect(indexManager.repeatGetReturnsSameInstance).toBe(true);
    expect(indexManager.typeTag).toBe('PersistentCacheIndexManager');
    expect(indexManager.enableAutoCreation).toMatchObject({
      threw: false,
      returnType: 'undefined',
      isPromise: false,
    });
    expect(indexManager.disableAutoCreation).toMatchObject({
      threw: false,
      returnType: 'undefined',
      isPromise: false,
    });
    expect(indexManager.deleteAllIndexes).toMatchObject({
      threw: false,
      returnType: 'undefined',
      isPromise: false,
    });
    expect(indexManager.setIndexConfigurationStructured).toMatchObject({
      threw: false,
      isPromise: true,
      resolvedUndefined: true,
    });
    expect(indexManager.setIndexConfigurationJson).toMatchObject({
      threw: false,
      isPromise: true,
      resolvedUndefined: true,
    });

    const refChecks = run1.refEqualChecks as Record<
      string,
      { threw: boolean; result: boolean | null }
    >;
    expect(refChecks.sameDocPathSameDb).toMatchObject({ threw: false, result: true });
    expect(refChecks.differentDocPathSameDb).toMatchObject({ threw: false, result: false });
    expect(refChecks.sameDocPathNamedVsDefaultDb).toMatchObject({ threw: false, result: false });
    expect(refChecks.sameDocPathDifferentApp).toMatchObject({ threw: false, result: false });
    expect(refChecks.docRefVsCollectionRef).toMatchObject({ threw: false, result: false });
    expect(refChecks.docRefVsPlainForeignObject).toMatchObject({ threw: false, result: false });
    expect(refChecks.collectionRefVsPlainForeignObject).toMatchObject({
      threw: false,
      result: false,
    });
  });
});
