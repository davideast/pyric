import { describe, it } from 'bun:test';
import { FirebaseError, deleteApp, getApps, initializeApp, type FirebaseApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  applySettingsCacheMode,
  assertAndRecordAppFirestoreSettings,
  clearAppFirestoreSettings,
  recordImplicitAppFirestoreSettings,
} from 'pyric/firestore/internal';
import * as surface from '../../../../src/serve/entries/firestore-surface.js';
import * as workerClient from '../../../../src/serve/worker/index.js';
import { refEqual as workerRefEqual } from '../../../../src/serve/worker/client/firestore-reference-equality.js';
import { connectClientToHost, makeHostCtx } from '../integration-support.js';
import { hostedFirestoreContext } from './hosted-firestore-support.ts';
import { expectReplay, load, restoreSharedWorker, type Pin } from './support.ts';
import type { Behavior } from '../../../../../conformance/src/capture/sdk-scenarios/replay-comparison.ts';

restoreSharedWorker();

interface PlaneDriver {
  getFirestore(app: FirebaseApp, databaseId?: string): unknown;
  initializeFirestore(app: FirebaseApp, settings?: surface.FirestoreSettings, databaseId?: string): unknown;
  doc(parent: unknown, path: string, ...segments: string[]): unknown;
  collection(parent: unknown, path: string, ...segments: string[]): unknown;
  refEqual(left: unknown, right: unknown): boolean;
  terminate(db: unknown): Promise<void>;
}

interface ObservedCallOutcome {
  threw: boolean;
  threwSynchronously: boolean;
  code: string | null;
  errorName: string | null;
  isFirestoreError: boolean;
  isFirebaseError: boolean;
  isTypeError: boolean;
}
type ObservedSyncReturnOutcome = ObservedCallOutcome & { returnType: string | null; isPromise: boolean };
type ObservedRefEqualOutcome = ObservedCallOutcome & { result: boolean | null };
interface ObservedTokenShape { kind: string | null; toJson: unknown }

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
    if (typeof record.code === 'string') code = record.code;
    if (typeof record.name === 'string') errorName = record.name;
  }
  return {
    threw: true,
    threwSynchronously,
    code,
    errorName,
    isFirestoreError: err instanceof surface.FirestoreError,
    isFirebaseError: err instanceof FirebaseError,
    isTypeError: err instanceof TypeError,
  };
}

function inspectToken(token: unknown): ObservedTokenShape {
  let kind: string | null = null;
  let toJson: unknown = null;
  if (token !== null && typeof token === 'object') {
    const candidate = token as { kind?: unknown; toJSON?: unknown };
    if (typeof candidate.kind === 'string') kind = candidate.kind;
    if (typeof candidate.toJSON === 'function') toJson = (candidate.toJSON as () => unknown).call(token);
  }
  return { kind, toJson };
}

function observeSyncVoidCall(fn: () => unknown): ObservedSyncReturnOutcome {
  try {
    const value = fn();
    return { ...noErrorOutcome(), returnType: typeof value, isPromise: value instanceof Promise };
  } catch (err) {
    return { ...errorOutcomeOf(err, true), returnType: null, isPromise: false };
  }
}

function observeInitializeThrow(
  driver: PlaneDriver,
  app: FirebaseApp,
  settings: surface.FirestoreSettings,
  databaseId?: string,
): ObservedCallOutcome {
  try {
    driver.initializeFirestore(app, settings, databaseId);
    return noErrorOutcome();
  } catch (err) {
    return errorOutcomeOf(err, true);
  }
}

function observeRefEqualCall(driver: PlaneDriver, left: unknown, right: unknown): ObservedRefEqualOutcome {
  try {
    return { ...noErrorOutcome(), result: driver.refEqual(left, right) };
  } catch (err) {
    return { ...errorOutcomeOf(err, true), result: null };
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

async function replayOfflineCacheInitWithDriver(
  driver: PlaneDriver,
  labelPrefix: string,
): Promise<Behavior> {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error('Unexpected outbound fetch in served offline firestore replay');
    },
    { preconnect: originalFetch.preconnect },
  );

  if (getApps().length === 0) {
    await resetAppRegistryForTests();
  }
  const existingApp = getApps()[0];
  let appOptions = { apiKey: 'fake-api-key', projectId: 'demo-firestore-offline-probe' };
  if (existingApp !== undefined) {
    appOptions = existingApp.options as typeof appOptions;
  }

  const apps: FirebaseApp[] = [];
  const handles: unknown[] = [];
  const openApp = (label: string): FirebaseApp => {
    const created = initializeApp(appOptions, `${labelPrefix}-${label}`);
    apps.push(created);
    return created;
  };

  try {
    const logLevels = ['debug', 'verbose', 'info', 'warn', 'error', 'silent'] as const;
    const setLogLevelOutcomes: Record<string, ObservedSyncReturnOutcome> = {};
    for (const level of logLevels) {
      setLogLevelOutcomes[level] = observeSyncVoidCall(() => surface.setLogLevel(level));
    }

    const singleTabDefault = surface.persistentSingleTabManager(undefined);
    const singleTabForced = surface.persistentSingleTabManager({ forceOwnership: true });
    const multiTab = surface.persistentMultipleTabManager();
    const eagerGc = surface.memoryEagerGarbageCollector();
    const lruGcBounded = surface.memoryLruGarbageCollector({ cacheSizeBytes: 2_097_152 });
    const lruGcUnlimited = surface.memoryLruGarbageCollector({
      cacheSizeBytes: surface.CACHE_SIZE_UNLIMITED,
    });
    const memCacheDefault = surface.memoryLocalCache();
    const memCacheEager = surface.memoryLocalCache({ garbageCollector: eagerGc });
    const memCacheLru = surface.memoryLocalCache({ garbageCollector: lruGcBounded });
    const persCacheDefault = surface.persistentLocalCache();
    const persCacheMultiTab = surface.persistentLocalCache({
      tabManager: multiTab,
      cacheSizeBytes: 41_943_040,
    });

    const appMemory = openApp('memory');
    const appDefaultFirst = openApp('default-first');
    const appPersistent = openApp('persistent');
    const appOther = openApp('other');

    const dbMem = driver.initializeFirestore(appMemory, {
      localCache: surface.memoryLocalCache({
        garbageCollector: surface.memoryEagerGarbageCollector(),
      }),
    }) as { type?: unknown; app?: unknown };
    handles.push(dbMem);
    const dbMemRepeat = driver.initializeFirestore(appMemory, {
      localCache: surface.memoryLocalCache({
        garbageCollector: surface.memoryEagerGarbageCollector(),
      }),
    });
    const dbNamed = driver.initializeFirestore(
      appMemory,
      { localCache: surface.memoryLocalCache() },
      'analytics-db',
    );
    handles.push(dbNamed);
    const dbOtherApp = driver.initializeFirestore(appOther, {
      localCache: surface.memoryLocalCache(),
    });
    handles.push(dbOtherApp);

    const dbDefaultFirst = driver.getFirestore(appDefaultFirst);
    handles.push(dbDefaultFirst);
    const dbInitEmptyAfterGet = driver.initializeFirestore(appDefaultFirst, {});

    const dbPers = driver.initializeFirestore(appPersistent, {
      localCache: surface.persistentLocalCache({
        tabManager: surface.persistentMultipleTabManager(),
      }),
    });
    handles.push(dbPers);

    const memIndexManager = surface.getPersistentCacheIndexManager(dbMem as never);
    const persIndexManager = surface.getPersistentCacheIndexManager(dbPers as never);
    const persIndexManagerRepeat = surface.getPersistentCacheIndexManager(dbPers as never);

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
        surface.enablePersistentCacheIndexAutoCreation(persIndexManager),
      );
      disableAutoOutcome = observeSyncVoidCall(() =>
        surface.disablePersistentCacheIndexAutoCreation(persIndexManager),
      );
      deleteAllIndexesOutcome = observeSyncVoidCall(() =>
        surface.deleteAllPersistentCacheIndexes(persIndexManager),
      );
    }

    const setIndexStructured = await observeAsyncVoidCall(() =>
      surface.setIndexConfiguration(dbPers as never, {
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
      surface.setIndexConfiguration(
        dbPers as never,
        JSON.stringify({ indexes: [], fieldOverrides: [] }),
      ),
    );

    const ordersDocA = driver.doc(dbMem, 'orders/item-1');
    const ordersDocASame = driver.doc(dbMem, 'orders', 'item-1');
    const ordersDocB = driver.doc(dbMem, 'orders/item-2');
    const ordersDocNamedDb = driver.doc(dbNamed, 'orders/item-1');
    const ordersDocOtherApp = driver.doc(dbOtherApp, 'orders/item-1');
    const ordersCollection = driver.collection(dbMem, 'orders');

    return {
      fetchCalls,
      cacheTokens: {
        cacheSizeUnlimitedConstant: surface.CACHE_SIZE_UNLIMITED,
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
        isFirestoreInstance: dbMem instanceof surface.Firestore,
        typeProperty: dbMem.type,
        appMatches: dbMem.app === appMemory,
        repeatEquivalentSettingsSameHandle: dbMem === dbMemRepeat,
        getFirestoreReturnsInitializedHandle: driver.getFirestore(appMemory) === dbMem,
        conflictingSettingsAfterInit: observeInitializeThrow(driver, appMemory, {
          host: '127.0.0.1:8080',
          ssl: false,
        }),
        emptySettingsAfterDefaultGetFirestoreSameHandle: dbInitEmptyAfterGet === dbDefaultFirst,
        conflictingSettingsAfterDefaultGetFirestore: observeInitializeThrow(
          driver,
          appDefaultFirst,
          { host: '127.0.0.1:8080', ssl: false },
        ),
        namedDatabaseDistinctFromDefault: dbNamed !== dbMem,
        namedDatabaseMatchesGetFirestoreNamed:
          driver.getFirestore(appMemory, 'analytics-db') === dbNamed,
        conflictingSettingsOnNamedDatabase: observeInitializeThrow(
          driver,
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
          persIndexManager instanceof surface.PersistentCacheIndexManager,
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
        sameDocPathSameDb: observeRefEqualCall(driver, ordersDocA, ordersDocASame),
        differentDocPathSameDb: observeRefEqualCall(driver, ordersDocA, ordersDocB),
        sameDocPathNamedVsDefaultDb: observeRefEqualCall(driver, ordersDocA, ordersDocNamedDb),
        sameDocPathDifferentApp: observeRefEqualCall(driver, ordersDocA, ordersDocOtherApp),
        docRefVsCollectionRef: observeRefEqualCall(driver, ordersDocA, ordersCollection),
        docRefVsPlainForeignObject: observeRefEqualCall(driver, ordersDocA, {
          id: 'item-1',
          path: 'orders/item-1',
          type: 'document',
        }),
        collectionRefVsPlainForeignObject: observeRefEqualCall(driver, ordersCollection, {
          id: 'orders',
          path: 'orders',
          type: 'collection',
        }),
      },
    };
  } finally {
    globalThis.fetch = originalFetch;
    surface.setLogLevel('error');
    for (const handle of handles) {
      await driver.terminate(handle).catch(() => {});
    }
    await Promise.all(apps.map((app) => deleteApp(app)));
  }
}

function buildNamedDbPins(production: Behavior): Pin[] {
  const prodInit = production.initializeFirestoreHandles as Record<string, unknown>;
  const prodRefEqual = production.refEqualChecks as Record<string, Record<string, unknown>>;
  const namedSameOutcome = {
    ...prodRefEqual.sameDocPathNamedVsDefaultDb,
    result: true,
  };
  return [
    {
      key: 'initializeFirestoreHandles',
      finding: 'MD2: served getFirestore(app, databaseId) resolves every database id to the (default) handle',
      production: prodInit,
      pyric: {
        ...prodInit,
        namedDatabaseDistinctFromDefault: false,
      },
    },
    {
      key: 'refEqualChecks',
      finding: 'MD2: served getFirestore(app, databaseId) resolves every database id to the (default) handle',
      production: prodRefEqual,
      pyric: {
        ...prodRefEqual,
        sameDocPathNamedVsDefaultDb: namedSameOutcome,
      },
    },
  ];
}

describe('firestore-offline-cache-init-index-and-refequal oracle capture (served worker + Node host)', () => {
  it('replays over SharedWorker client + host handles (firestore#112, #115, #145, #146, #149, #157)', async () => {
    const production = load('firestore-offline-cache-init-index-and-refequal');
    const host = await makeHostCtx();
    const byApp = new WeakMap<FirebaseApp, unknown>();
    const driver: PlaneDriver = {
      getFirestore(app: FirebaseApp, databaseId?: string) {
        const existing = byApp.get(app);
        if (existing !== undefined) {
          recordImplicitAppFirestoreSettings(app, databaseId, existing as object);
          return existing;
        }
        const connected = connectClientToHost(host, `worker://cache-init-${app.name}`).db;
        const handle = Object.assign(connected, {
          app,
          type: 'firestore' as const,
        });
        byApp.set(app, handle);
        recordImplicitAppFirestoreSettings(app, databaseId, handle);
        return handle;
      },
      initializeFirestore(app: FirebaseApp, settings?: surface.FirestoreSettings, databaseId?: string) {
        assertAndRecordAppFirestoreSettings(app, settings, databaseId);
        const handle = driver.getFirestore(app, databaseId) as object;
        applySettingsCacheMode(handle, settings, databaseId, app);
        return handle;
      },
      doc: (parent, path, ...segments) =>
        workerClient.doc(parent as never, path, ...segments),
      collection: (parent, path, ...segments) =>
        workerClient.collection(parent as never, path, ...segments),
      refEqual: (left, right) => workerRefEqual(left as never, right as never),
      async terminate(db) {
        if (db !== null && typeof db === 'object' && 'app' in db) {
          const owner = (db as { app?: unknown }).app;
          if (owner !== null && typeof owner === 'object') {
            clearAppFirestoreSettings(owner);
          }
        }
      },
    };
    try {
      const pyric = await replayOfflineCacheInitWithDriver(driver, 'served-worker-cache-init');
      expectReplay({
        production,
        pyric,
        pins: buildNamedDbPins(production),
      });
    } finally {
      host.sandbox.dispose();
    }
  });

  it('replays over Node-hosted loopback WebSocket handles (firestore#112, #115, #145, #146, #149, #157)', async () => {
    const production = load('firestore-offline-cache-init-index-and-refequal');
    const hosted = await hostedFirestoreContext();
    const preAllocated = new Map<string, unknown>();
    for (const label of ['memory', 'default-first', 'persistent', 'other']) {
      const opened = await hosted.newClient(`hosted-${label}`);
      preAllocated.set(`served-hosted-cache-init-${label}`, opened.db);
    }
    const byApp = new WeakMap<FirebaseApp, unknown>();
    const driver: PlaneDriver = {
      getFirestore(app: FirebaseApp, databaseId?: string) {
        const existing = byApp.get(app);
        if (existing !== undefined) {
          recordImplicitAppFirestoreSettings(app, databaseId, existing as object);
          return existing;
        }
        const rawClient = preAllocated.get(app.name) ?? hosted.db;
        const handle = Object.assign(rawClient as object, {
          app,
          type: 'firestore' as const,
        });
        byApp.set(app, handle);
        recordImplicitAppFirestoreSettings(app, databaseId, handle);
        return handle;
      },
      initializeFirestore(app: FirebaseApp, settings?: surface.FirestoreSettings, databaseId?: string) {
        assertAndRecordAppFirestoreSettings(app, settings, databaseId);
        const handle = driver.getFirestore(app, databaseId) as object;
        applySettingsCacheMode(handle, settings, databaseId, app);
        return handle;
      },
      doc: (parent, path, ...segments) =>
        hosted.fs.doc(parent as never, path, ...segments),
      collection: (parent, path, ...segments) =>
        hosted.fs.collection(parent as never, path, ...segments),
      refEqual: (left, right) => hosted.fs.refEqual(left as never, right as never),
      async terminate(db) {
        if (db !== null && typeof db === 'object' && 'app' in db) {
          const owner = (db as { app?: unknown }).app;
          if (owner !== null && typeof owner === 'object') {
            clearAppFirestoreSettings(owner);
          }
        }
      },
    };
    const pyric = await replayOfflineCacheInitWithDriver(driver, 'served-hosted-cache-init');
    expectReplay({
      production,
      pyric,
      pins: buildNamedDbPins(production),
    });
  });

  it('routes surface.initializeFirestore and surface.getPersistentCacheIndexManager end-to-end', async () => {
    const host = await makeHostCtx();
    connectClientToHost(host, 'worker://surface-direct-cache-init');
    if (getApps().length === 0) {
      await resetAppRegistryForTests();
    }
    const existingApp = getApps()[0];
    let appOptions = { apiKey: 'fake-api-key', projectId: 'demo-firestore-offline-probe' };
    if (existingApp !== undefined) {
      appOptions = existingApp.options as typeof appOptions;
    }
    const app = initializeApp(appOptions, 'served-surface-direct-cache-init');
    try {
      const db = surface.initializeFirestore(app, {
        localCache: surface.persistentLocalCache({
          tabManager: surface.persistentMultipleTabManager(),
        }),
      });
      const repeat = surface.initializeFirestore(app, {
        localCache: surface.persistentLocalCache({
          tabManager: surface.persistentMultipleTabManager(),
        }),
      });
      if (repeat !== db) {
        throw new Error('Expected repeat initializeFirestore with equivalent settings to return same handle');
      }
      let conflictCode: string | null = null;
      try {
        surface.initializeFirestore(app, { host: '127.0.0.1:8080', ssl: false });
      } catch (err) {
        if (err instanceof FirebaseError) {
          conflictCode = err.code;
        }
      }
      if (conflictCode !== 'failed-precondition') {
        throw new Error(`Expected failed-precondition, got ${String(conflictCode)}`);
      }
      const manager = surface.getPersistentCacheIndexManager(db);
      if (!(manager instanceof surface.PersistentCacheIndexManager)) {
        throw new Error('Expected PersistentCacheIndexManager instance on persistent localCache');
      }
      surface.enablePersistentCacheIndexAutoCreation(manager);
      surface.disablePersistentCacheIndexAutoCreation(manager);
      surface.deleteAllPersistentCacheIndexes(manager);
      await surface.setIndexConfiguration(db, { indexes: [] });
      await surface.terminate(db);
    } finally {
      await deleteApp(app);
      host.sandbox.dispose();
    }
  });
});
