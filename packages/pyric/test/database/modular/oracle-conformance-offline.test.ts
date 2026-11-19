import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from '../../../src/app/index.js';
import { resetAppRegistryForTests } from '../../../src/app/registry.js';
import {
  get,
  getDatabase,
  goOffline,
  goOnline,
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
  sandbox as rtdbSandbox,
  set,
  update,
} from '../../../src/database/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeDeletedDatabaseConnectionGuards,
  observeGoOfflineGoOnlineContract,
  type GoOfflineGoOnlineObservation,
} from '../../../../conformance/probes/rtdb-modular/rtdb-modular-gooffline-goonline-queue-and-isolation.ts';
import { load } from './oracle-conformance.support.js';

beforeEach(() => {
  resetAppRegistryForTests();
});

afterEach(() => {
  resetAppRegistryForTests();
});

describe('oracle conformance (rtdb-modular): goOffline and goOnline isolation and queue (#163, #164)', () => {
  it('replays rtdb-modular-gooffline-goonline-queue-and-isolation on the in-process sandbox plane', async () => {
    const expected = load(
      'rtdb-modular-gooffline-goonline-queue-and-isolation.json',
    ) as unknown as GoOfflineGoOnlineObservation;

    const sandbox = initializeSandbox({ projectId: 'demo-offline-conformance' });
    try {
      const writerDb = getDatabase(sandbox.withAuth({ uid: 'writer-1' }));
      const observerDb = getDatabase(sandbox.withAuth({ uid: 'observer-1' }));
      rtdbSandbox.setDefaultPolicy(writerDb, 'allow');

      const live = await observeGoOfflineGoOnlineContract({
        writerDb: writerDb as never,
        observerDb: observerDb as never,
        basePath: 'pyric_oracle/offline_replay',
        goOffline: goOffline as never,
        goOnline: goOnline as never,
        ref: ref as never,
        get: get as never,
        set: set as never,
        update: update as never,
        remove: remove as never,
        onValue: onValue as never,
        onDisconnect: onDisconnect as never,
        runTransaction: runTransaction as never,
      });

      const deletedGuards = await observeDeletedDatabaseConnectionGuards({
        async openDeletedDatabase() {
          const tempApp = initializeApp(
            {
              projectId: 'demo-deleted-offline',
              databaseURL: 'https://demo-deleted-offline-default-rtdb.firebaseio.com',
            },
            `inproc-del-${Date.now()}`,
          );
          const tempDb = getDatabase(tempApp);
          goOffline(tempDb);
          await deleteApp(tempApp);
          return {
            db: tempDb as never,
            goOffline: goOffline as never,
            goOnline: goOnline as never,
          };
        },
      });

      expect({ live, deletedGuards }).toEqual(expected);
    } finally {
      await sandbox.dispose();
    }
  });
});
