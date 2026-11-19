import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { FirebaseError, deleteApp, getApps, initializeApp, type FirebaseApp } from 'pyric/app';
import { resetAppRegistryForTests } from 'pyric/app/internal';
import {
  FirestoreError,
  PersistentCacheIndexManager,
  getFirestore,
  getPersistentCacheIndexManager,
  initializeFirestore,
  memoryEagerGarbageCollector,
  memoryLocalCache,
  memoryLruGarbageCollector,
  persistentLocalCache,
  persistentMultipleTabManager,
  persistentSingleTabManager,
  terminate,
  type Firestore,
} from 'pyric/firestore';
import {
  applySettingsCacheMode,
  assertAndRecordAppFirestoreSettings,
  clearAppFirestoreSettings,
  recordImplicitAppFirestoreSettings,
} from 'pyric/firestore/internal';
import { initializeSandbox } from 'pyric/sandbox';

describe('init-settings', () => {
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
      `init-settings-${label}-${Math.random().toString(36).slice(2, 8)}`,
    );
    apps.push(app);
    return app;
  }

  it('reuses app handle on equivalent settings and throws synchronous FirebaseError on conflict', () => {
    const app = createApp('conflict');
    const db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager({ forceOwnership: true }),
      }),
    });
    handles.push(db);

    const dbSame = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager({ forceOwnership: true }),
      }),
    });
    expect(dbSame).toBe(db);
    expect(getFirestore(app)).toBe(db);

    let caught: unknown;
    try {
      initializeFirestore(app, {
        localCache: memoryLocalCache({ garbageCollector: memoryLruGarbageCollector() }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FirebaseError);
    expect(caught).not.toBeInstanceOf(FirestoreError);
    expect((caught as FirebaseError).code).toBe('failed-precondition');
  });

  it('prevents non-(default) databaseId settings from clobbering the shared (default) cache tier', () => {
    const appMemFirst = createApp('mem-first');
    const dbMem = initializeFirestore(appMemFirst, {
      localCache: memoryLocalCache({ garbageCollector: memoryEagerGarbageCollector() }),
    });
    const dbNamedPers = initializeFirestore(
      appMemFirst,
      { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) },
      'analytics-db',
    );
    handles.push(dbMem, dbNamedPers);
    expect(getPersistentCacheIndexManager(dbMem)).toBeNull();

    const appNamedFirst = createApp('named-first');
    const dbOnlyNamed = initializeFirestore(
      appNamedFirst,
      { localCache: persistentLocalCache() },
      'analytics-db',
    );
    expect(getPersistentCacheIndexManager(dbOnlyNamed)).toBeInstanceOf(PersistentCacheIndexManager);

    const dbDefaultImplicit = getFirestore(appNamedFirst);
    handles.push(dbOnlyNamed, dbDefaultImplicit);
    expect(getPersistentCacheIndexManager(dbDefaultImplicit)).toBeNull();
  });

  it('resets handle cache tier when terminate or clearAppFirestoreSettings clears app state', async () => {
    const app = createApp('reset');
    const dbPers = initializeFirestore(app, { localCache: persistentLocalCache() });
    expect(getPersistentCacheIndexManager(dbPers)).toBeInstanceOf(PersistentCacheIndexManager);

    await terminate(dbPers);
    expect(getPersistentCacheIndexManager(dbPers)).toBeNull();

    const dbMemAfterTerminate = initializeFirestore(app, { localCache: memoryLocalCache() });
    handles.push(dbMemAfterTerminate);
    expect(getPersistentCacheIndexManager(dbMemAfterTerminate)).toBeNull();

    const reusedApp = createApp('reused-handle');
    const sharedHandle = getFirestore(reusedApp);
    handles.push(sharedHandle);
    clearAppFirestoreSettings(reusedApp);
    assertAndRecordAppFirestoreSettings(reusedApp, { localCache: persistentLocalCache() });
    applySettingsCacheMode(sharedHandle, { localCache: persistentLocalCache() }, undefined, reusedApp);
    expect(getPersistentCacheIndexManager(sharedHandle)).toBeInstanceOf(PersistentCacheIndexManager);

    clearAppFirestoreSettings(reusedApp);
    recordImplicitAppFirestoreSettings(reusedApp, undefined, sharedHandle);
    expect(getPersistentCacheIndexManager(sharedHandle)).toBeNull();
  });

  it('allows independent Sandbox handles without per-app singleton conflict rejection', () => {
    const sandbox = initializeSandbox();
    const dbA = initializeFirestore(sandbox, { localCache: memoryLocalCache() });
    const dbB = initializeFirestore(sandbox, { localCache: persistentLocalCache() });
    handles.push(dbA, dbB);
    expect(dbA).not.toBe(dbB);
    expect(getPersistentCacheIndexManager(dbA)).toBeNull();
    expect(getPersistentCacheIndexManager(dbB)).toBeInstanceOf(PersistentCacheIndexManager);
  });
});
