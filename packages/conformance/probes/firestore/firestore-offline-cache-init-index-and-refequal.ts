import { FirebaseError, deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  CACHE_SIZE_UNLIMITED,
  Firestore,
  FirestoreError,
  PersistentCacheIndexManager,
  collection,
  deleteAllPersistentCacheIndexes,
  disablePersistentCacheIndexAutoCreation,
  doc,
  enablePersistentCacheIndexAutoCreation,
  getFirestore,
  getPersistentCacheIndexManager,
  initializeFirestore,
  memoryEagerGarbageCollector,
  memoryLocalCache,
  memoryLruGarbageCollector,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  refEqual,
  setIndexConfiguration,
  setLogLevel,
  terminate,
  type FirestoreSettings,
  type LogLevel,
} from 'firebase/firestore';
import type { Probe } from '../../rigs/types.ts';

interface ObservedCallOutcome {
  threw: boolean;
  threwSynchronously: boolean;
  code: string | null;
  errorName: string | null;
  isFirestoreError: boolean;
  isFirebaseError: boolean;
  isTypeError: boolean;
}

interface ObservedSyncReturnOutcome extends ObservedCallOutcome {
  returnType: string | null;
  isPromise: boolean;
}

interface ObservedRefEqualOutcome extends ObservedCallOutcome {
  result: boolean | null;
}

interface ObservedTokenShape {
  kind: string | null;
  toJson: unknown;
}

function noErrorOutcome(): ObservedCallOutcome {
  return {
    threw: false,
    threwSynchronously: false,
    code: null,
    errorName: null,
    isFirestoreError: false,
    isFirebaseError: false,
    isTypeError: false,
  };
}

function errorOutcomeOf(err: unknown, threwSynchronously: boolean): ObservedCallOutcome {
  let code: string | null = null;
  let errorName: string | null = null;
  if (err !== null && typeof err === 'object') {
    const record = err as { code?: unknown; name?: unknown };
    if (typeof record.code === 'string') {
      code = record.code;
    }
    if (typeof record.name === 'string') {
      errorName = record.name;
    }
  }
  return {
    threw: true,
    threwSynchronously,
    code,
    errorName,
    isFirestoreError: err instanceof FirestoreError,
    isFirebaseError: err instanceof FirebaseError,
    isTypeError: err instanceof TypeError,
  };
}

function inspectToken(token: unknown): ObservedTokenShape {
  let kind: string | null = null;
  let toJson: unknown = null;
  if (token !== null && typeof token === 'object') {
    const candidate = token as { kind?: unknown; toJSON?: unknown };
    if (typeof candidate.kind === 'string') {
      kind = candidate.kind;
    }
    if (typeof candidate.toJSON === 'function') {
      toJson = (candidate.toJSON as () => unknown).call(token);
    }
  }
  return { kind, toJson };
}

function observeSyncVoidCall(fn: () => unknown): ObservedSyncReturnOutcome {
  try {
    const value = fn();
    return {
      ...noErrorOutcome(),
      returnType: typeof value,
      isPromise: value instanceof Promise,
    };
  } catch (err) {
    return {
      ...errorOutcomeOf(err, true),
      returnType: null,
      isPromise: false,
    };
  }
}

function observeInitializeThrow(
  app: FirebaseApp,
  settings: FirestoreSettings,
  databaseId?: string,
): ObservedCallOutcome {
  try {
    if (databaseId === undefined) {
      initializeFirestore(app, settings);
    } else {
      initializeFirestore(app, settings, databaseId);
    }
    return noErrorOutcome();
  } catch (err) {
    return errorOutcomeOf(err, true);
  }
}

function observeRefEqualCall(left: unknown, right: unknown): ObservedRefEqualOutcome {
  try {
    const equal = refEqual(
      left as Parameters<typeof refEqual>[0],
      right as Parameters<typeof refEqual>[1],
    );
    return {
      ...noErrorOutcome(),
      result: equal,
    };
  } catch (err) {
    return {
      ...errorOutcomeOf(err, true),
      result: null,
    };
  }
}

async function observeAsyncVoidCall(
  fn: () => Promise<void>,
): Promise<ObservedCallOutcome & { isPromise: boolean; resolvedUndefined: boolean }> {
  let promiseValue: Promise<void>;
  try {
    promiseValue = fn();
  } catch (err) {
    return {
      ...errorOutcomeOf(err, true),
      isPromise: false,
      resolvedUndefined: false,
    };
  }
  const isPromise = promiseValue instanceof Promise;
  try {
    const settled = await promiseValue;
    return {
      ...noErrorOutcome(),
      isPromise,
      resolvedUndefined: settled === undefined,
    };
  } catch (err) {
    return {
      ...errorOutcomeOf(err, false),
      isPromise,
      resolvedUndefined: false,
    };
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Pure offline firebase/firestore cache and garbage-collector token shapes, initializeFirestore handle caching and failed-precondition guards, PersistentCacheIndexManager and setIndexConfiguration behavior, setLogLevel acceptance, and refEqual foreign-object comparisons with zero network calls.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1;
        throw new Error('Unexpected outbound fetch in offline firestore probe');
      },
      { preconnect: originalFetch.preconnect },
    );

    const apps: FirebaseApp[] = [];
    const handles: Firestore[] = [];
    const openApp = (label: string): FirebaseApp => {
      const created = initializeApp(
        { apiKey: 'fake-api-key', projectId: 'demo-firestore-offline-probe' },
        `firestore-offline-probe-${label}`,
      );
      apps.push(created);
      return created;
    };

    try {
      const logLevels: readonly LogLevel[] = [
        'debug',
        'verbose',
        'info',
        'warn',
        'error',
        'silent',
      ];
      const setLogLevelOutcomes: Record<string, ObservedSyncReturnOutcome> = {};
      for (const level of logLevels) {
        setLogLevelOutcomes[level] = observeSyncVoidCall(() => setLogLevel(level));
      }

      const singleTabDefault = persistentSingleTabManager(undefined);
      const singleTabForced = persistentSingleTabManager({ forceOwnership: true });
      const multiTab = persistentMultipleTabManager();
      const eagerGc = memoryEagerGarbageCollector();
      const lruGcBounded = memoryLruGarbageCollector({ cacheSizeBytes: 2_097_152 });
      const lruGcUnlimited = memoryLruGarbageCollector({
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      });
      const memCacheDefault = memoryLocalCache();
      const memCacheEager = memoryLocalCache({ garbageCollector: eagerGc });
      const memCacheLru = memoryLocalCache({ garbageCollector: lruGcBounded });
      const persCacheDefault = persistentLocalCache();
      const persCacheMultiTab = persistentLocalCache({
        tabManager: multiTab,
        cacheSizeBytes: 41_943_040,
      });

      const appMemory = openApp('memory');
      const appDefaultFirst = openApp('default-first');
      const appPersistent = openApp('persistent');
      const appOther = openApp('other');

      const dbMem = initializeFirestore(appMemory, {
        localCache: memoryLocalCache({ garbageCollector: memoryEagerGarbageCollector() }),
      });
      handles.push(dbMem);
      const dbMemRepeat = initializeFirestore(appMemory, {
        localCache: memoryLocalCache({ garbageCollector: memoryEagerGarbageCollector() }),
      });
      const dbNamed = initializeFirestore(
        appMemory,
        { localCache: memoryLocalCache() },
        'analytics-db',
      );
      handles.push(dbNamed);
      const dbOtherApp = initializeFirestore(appOther, { localCache: memoryLocalCache() });
      handles.push(dbOtherApp);

      const dbDefaultFirst = getFirestore(appDefaultFirst);
      handles.push(dbDefaultFirst);
      const dbInitEmptyAfterGet = initializeFirestore(appDefaultFirst, {});

      const dbPers = initializeFirestore(appPersistent, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
      handles.push(dbPers);

      const memIndexManager = getPersistentCacheIndexManager(dbMem);
      const persIndexManager = getPersistentCacheIndexManager(dbPers);
      const persIndexManagerRepeat = getPersistentCacheIndexManager(dbPers);

      let indexManagerTypeTag: string | null = null;
      if (persIndexManager !== null && typeof persIndexManager === 'object') {
        const record = persIndexManager as { type?: unknown };
        if (typeof record.type === 'string') {
          indexManagerTypeTag = record.type;
        }
      }

      let enableAutoOutcome: ObservedSyncReturnOutcome | null = null;
      let disableAutoOutcome: ObservedSyncReturnOutcome | null = null;
      let deleteAllIndexesOutcome: ObservedSyncReturnOutcome | null = null;
      if (persIndexManager !== null) {
        enableAutoOutcome = observeSyncVoidCall(() =>
          enablePersistentCacheIndexAutoCreation(persIndexManager),
        );
        disableAutoOutcome = observeSyncVoidCall(() =>
          disablePersistentCacheIndexAutoCreation(persIndexManager),
        );
        deleteAllIndexesOutcome = observeSyncVoidCall(() =>
          deleteAllPersistentCacheIndexes(persIndexManager),
        );
      }

      const setIndexStructured = await observeAsyncVoidCall(() =>
        setIndexConfiguration(dbPers, {
          indexes: [
            {
              collectionGroup: 'orders',
              queryScope: 'COLLECTION',
              fields: [
                { fieldPath: 'status', order: 'ASCENDING' },
                { fieldPath: 'createdAt', order: 'DESCENDING' },
              ],
            },
          ],
        }),
      );
      const setIndexJson = await observeAsyncVoidCall(() =>
        setIndexConfiguration(
          dbPers,
          JSON.stringify({ indexes: [], fieldOverrides: [] }),
        ),
      );

      const ordersDocA = doc(dbMem, 'orders/item-1');
      const ordersDocASame = doc(dbMem, 'orders', 'item-1');
      const ordersDocB = doc(dbMem, 'orders/item-2');
      const ordersDocNamedDb = doc(dbNamed, 'orders/item-1');
      const ordersDocOtherApp = doc(dbOtherApp, 'orders/item-1');
      const ordersCollection = collection(dbMem, 'orders');

      return {
        fetchCalls,
        cacheTokens: {
          cacheSizeUnlimitedConstant: CACHE_SIZE_UNLIMITED,
          singleTabDefault: inspectToken(singleTabDefault),
          singleTabForced: inspectToken(singleTabForced),
          multiTab: inspectToken(multiTab),
          eagerGc: inspectToken(eagerGc),
          lruGcBounded: inspectToken(lruGcBounded),
          lruGcUnlimited: inspectToken(lruGcUnlimited),
          memCacheDefault: inspectToken(memCacheDefault),
          memCacheEager: inspectToken(memCacheEager),
          memCacheLru: inspectToken(memCacheLru),
          persCacheDefault: inspectToken(persCacheDefault),
          persCacheMultiTab: inspectToken(persCacheMultiTab),
          distinctIdentities: {
            singleTabEqualsMultiTab: Object.is(singleTabDefault, multiTab),
            eagerGcEqualsLruGc: Object.is(eagerGc, lruGcBounded),
            memCacheEqualsPersCache: Object.is(memCacheDefault, persCacheDefault),
          },
        },
        initializeFirestoreHandles: {
          isFirestoreInstance: dbMem instanceof Firestore,
          typeProperty: dbMem.type,
          appMatches: dbMem.app === appMemory,
          repeatEquivalentSettingsSameHandle: dbMem === dbMemRepeat,
          getFirestoreReturnsInitializedHandle: getFirestore(appMemory) === dbMem,
          conflictingSettingsAfterInit: observeInitializeThrow(appMemory, {
            host: '127.0.0.1:8080',
            ssl: false,
          }),
          emptySettingsAfterDefaultGetFirestoreSameHandle:
            dbInitEmptyAfterGet === dbDefaultFirst,
          conflictingSettingsAfterDefaultGetFirestore: observeInitializeThrow(
            appDefaultFirst,
            { host: '127.0.0.1:8080', ssl: false },
          ),
          namedDatabaseDistinctFromDefault: dbNamed !== dbMem,
          namedDatabaseMatchesGetFirestoreNamed:
            getFirestore(appMemory, 'analytics-db') === dbNamed,
          conflictingSettingsOnNamedDatabase: observeInitializeThrow(
            appMemory,
            { host: '127.0.0.1:8080', ssl: false },
            'analytics-db',
          ),
          otherAppDistinctHandle: dbOtherApp !== dbMem,
        },
        persistentCacheIndexManager: {
          onMemoryLocalCacheIsNull: memIndexManager === null,
          onPersistentLocalCacheIsNull: persIndexManager === null,
          isPersistentCacheIndexManagerInstance:
            persIndexManager instanceof PersistentCacheIndexManager,
          repeatGetReturnsSameInstance: persIndexManager === persIndexManagerRepeat,
          typeTag: indexManagerTypeTag,
          enableAutoCreation: enableAutoOutcome,
          disableAutoCreation: disableAutoOutcome,
          deleteAllIndexes: deleteAllIndexesOutcome,
          setIndexConfigurationStructured: setIndexStructured,
          setIndexConfigurationJson: setIndexJson,
        },
        setLogLevelOutcomes,
        refEqualChecks: {
          sameDocPathSameDb: observeRefEqualCall(ordersDocA, ordersDocASame),
          differentDocPathSameDb: observeRefEqualCall(ordersDocA, ordersDocB),
          sameDocPathNamedVsDefaultDb: observeRefEqualCall(ordersDocA, ordersDocNamedDb),
          sameDocPathDifferentApp: observeRefEqualCall(ordersDocA, ordersDocOtherApp),
          docRefVsCollectionRef: observeRefEqualCall(ordersDocA, ordersCollection),
          docRefVsPlainForeignObject: observeRefEqualCall(ordersDocA, {
            id: 'item-1',
            path: 'orders/item-1',
            type: 'document',
          }),
          collectionRefVsPlainForeignObject: observeRefEqualCall(ordersCollection, {
            id: 'orders',
            path: 'orders',
            type: 'collection',
          }),
        },
      };
    } finally {
      globalThis.fetch = originalFetch;
      setLogLevel('error');
      for (const handle of handles) {
        await terminate(handle).catch(() => {});
      }
      await Promise.all(apps.map((app) => deleteApp(app)));
    }
  },
};
