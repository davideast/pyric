import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FirebaseError, deleteApp, getApps, initializeApp, type FirebaseApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  PersistentCacheIndexManager,
  deleteAllPersistentCacheIndexes,
  disablePersistentCacheIndexAutoCreation,
  enableIndexedDbPersistence,
  enablePersistentCacheIndexAutoCreation,
  getFirestore,
  getPersistentCacheIndexManager,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  setIndexConfiguration,
  terminate,
  type Firestore,
} from 'pyric/firestore';

describe('cache-index-manager', () => {
  const apps: FirebaseApp[] = [];
  const handles: Firestore[] = [];

  let appOptions = { apiKey: 'fake-api-key', projectId: 'demo-cache-unit' };

  beforeEach(async () => {
    if (getApps().length === 0) {
      await resetAppRegistryForTests();
    }
    const existing = getApps()[0];
    if (existing !== undefined) {
      appOptions = existing.options as typeof appOptions;
    } else {
      appOptions = { apiKey: 'fake-api-key', projectId: 'demo-cache-unit' };
    }
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await terminate(handle).catch(() => {});
    }
    for (const app of apps.splice(0)) {
      await deleteApp(app).catch(() => {});
    }
  });

  function createApp(label: string): FirebaseApp {
    const app = initializeApp(
      appOptions,
      `cache-index-${label}-${Math.random().toString(36).slice(2, 8)}`,
    );
    apps.push(app);
    return app;
  }

  it('returns null on default and memoryLocalCache handles and a singleton on persistent handles', async () => {
    const appDefault = createApp('default');
    const appMem = createApp('mem');
    const appPers = createApp('pers');
    const appLegacy = createApp('legacy');

    const dbDefault = getFirestore(appDefault);
    const dbMem = initializeFirestore(appMem, { localCache: memoryLocalCache() });
    const dbPers = initializeFirestore(appPers, { localCache: persistentLocalCache() });
    const dbLegacy = getFirestore(appLegacy);
    handles.push(dbDefault, dbMem, dbPers, dbLegacy);

    expect(getPersistentCacheIndexManager(dbDefault)).toBeNull();
    expect(getPersistentCacheIndexManager(dbMem)).toBeNull();

    const mgrA = getPersistentCacheIndexManager(dbPers);
    const mgrB = getPersistentCacheIndexManager(dbPers);
    expect(mgrA).toBeInstanceOf(PersistentCacheIndexManager);
    expect(mgrA).toBe(mgrB);
    expect(mgrA?.type).toBe('PersistentCacheIndexManager');

    expect(getPersistentCacheIndexManager(dbLegacy)).toBeNull();
    await enableIndexedDbPersistence(dbLegacy);
    expect(getPersistentCacheIndexManager(dbLegacy)).toBeInstanceOf(PersistentCacheIndexManager);
  });

  it('executes index auto-creation and deleteAll controllers synchronously and rejects foreign inputs', () => {
    const appPers = createApp('controllers');
    const dbPers = initializeFirestore(appPers, { localCache: persistentLocalCache() });
    handles.push(dbPers);

    const mgr = getPersistentCacheIndexManager(dbPers);
    expect(mgr).not.toBeNull();
    if (mgr === null) return;

    expect(enablePersistentCacheIndexAutoCreation(mgr)).toBeUndefined();
    expect(disablePersistentCacheIndexAutoCreation(mgr)).toBeUndefined();
    expect(deleteAllPersistentCacheIndexes(mgr)).toBeUndefined();

    expect(() => getPersistentCacheIndexManager({} as Firestore)).toThrow(FirebaseError);
    expect(() =>
      enablePersistentCacheIndexAutoCreation({} as PersistentCacheIndexManager),
    ).toThrow(FirebaseError);
    expect(() =>
      disablePersistentCacheIndexAutoCreation({} as PersistentCacheIndexManager),
    ).toThrow(FirebaseError);
    expect(() => deleteAllPersistentCacheIndexes({} as PersistentCacheIndexManager)).toThrow(
      FirebaseError,
    );
  });

  it('accepts structured and valid JSON index configurations and rejects malformed JSON', async () => {
    const appPers = createApp('set-index');
    const dbPers = initializeFirestore(appPers, { localCache: persistentLocalCache() });
    handles.push(dbPers);

    await expect(
      setIndexConfiguration(dbPers, {
        indexes: [{ collectionGroup: 'orders', fields: [{ fieldPath: 'status', order: 'ASCENDING' }] }],
      }),
    ).resolves.toBeUndefined();
    await expect(
      setIndexConfiguration(dbPers, JSON.stringify({ indexes: [], fieldOverrides: [] })),
    ).resolves.toBeUndefined();
    await expect(setIndexConfiguration(dbPers, '{malformed-json')).rejects.toThrow(FirebaseError);
  });
});
