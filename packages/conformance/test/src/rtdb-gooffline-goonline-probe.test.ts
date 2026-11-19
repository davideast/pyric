import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import * as fdb from 'firebase/database';
import {
  observeDeletedDatabaseConnectionGuards,
  observeGoOfflineGoOnlineContract,
  probe,
  type DeletedDatabaseGuardSubject,
  type DeletedDatabaseGuardsObservation,
  type GoOfflineGoOnlineContractObservation,
  type GoOfflineGoOnlineProbeSubject,
} from '../../probes/rtdb-modular/rtdb-modular-gooffline-goonline-queue-and-isolation.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';

const PROBE_NAME = 'rtdb-modular-gooffline-goonline-queue-and-isolation';

interface HarnessRef {
  readonly dbTag: 'writer' | 'observer';
  readonly path: string;
}

function makeFakeSnap(val: unknown): fdb.DataSnapshot {
  return {
    val() {
      return structuredClone(val);
    },
  } as unknown as fdb.DataSnapshot;
}

function buildTwoClientHarness(): GoOfflineGoOnlineProbeSubject {
  const serverStore = new Map<string, unknown>();
  const localOverlay = new Map<string, unknown>();
  const activeWriterWatchedPaths = new Set<string>();
  const writerListeners = new Map<string, Set<(snap: fdb.DataSnapshot) => void>>();
  const observerListeners = new Map<string, Set<(snap: fdb.DataSnapshot) => void>>();
  const pendingFlushTasks: Array<() => void> = [];
  const serverArmedDisconnects = new Map<string, unknown>();
  let writerOnline = true;

  const writerDb = { tag: 'writer' } as unknown as fdb.Database;
  const observerDb = { tag: 'observer' } as unknown as fdb.Database;

  const effectiveWriterVal = (path: string): unknown => {
    if (path === '.info/connected') {
      return writerOnline;
    }
    if (localOverlay.has(path)) {
      return localOverlay.get(path);
    }
    if (serverStore.has(path)) {
      return serverStore.get(path);
    }
    return null;
  };

  const effectiveServerVal = (path: string): unknown => {
    if (path === '.info/connected') {
      return true;
    }
    if (serverStore.has(path)) {
      return serverStore.get(path);
    }
    return null;
  };

  const notifyMap = (
    map: Map<string, Set<(snap: fdb.DataSnapshot) => void>>,
    path: string,
    val: unknown,
  ): void => {
    const setForPath = map.get(path);
    if (setForPath === undefined) {
      return;
    }
    for (const cb of [...setForPath]) {
      cb(makeFakeSnap(val));
    }
  };

  const applyServerWrite = (path: string, val: unknown): void => {
    if (val === null) {
      serverStore.delete(path);
    } else {
      serverStore.set(path, structuredClone(val));
    }
    notifyMap(observerListeners, path, effectiveServerVal(path));
    if (writerOnline) {
      notifyMap(writerListeners, path, effectiveWriterVal(path));
    }
  };

  return {
    writerDb,
    observerDb,
    basePath: '/pyric_oracle/offline_harness_run',
    goOffline(db: fdb.Database) {
      if (db === writerDb && writerOnline) {
        writerOnline = false;
        notifyMap(writerListeners, '.info/connected', false);
        const armed = [...serverArmedDisconnects.entries()];
        serverArmedDisconnects.clear();
        for (const [path, val] of armed) {
          applyServerWrite(path, val);
        }
      }
      return undefined;
    },
    goOnline(db: fdb.Database) {
      if (db === writerDb && !writerOnline) {
        writerOnline = true;
        notifyMap(writerListeners, '.info/connected', true);
        const tasks = pendingFlushTasks.splice(0, pendingFlushTasks.length);
        for (const task of tasks) {
          task();
        }
        for (const path of writerListeners.keys()) {
          if (path !== '.info/connected') {
            notifyMap(writerListeners, path, effectiveWriterVal(path));
          }
        }
      }
      return undefined;
    },
    ref: ((db: fdb.Database, path = '') => {
      let dbTag: 'writer' | 'observer' = 'observer';
      if (db === writerDb) {
        dbTag = 'writer';
      }
      return { dbTag, path } as unknown as fdb.DatabaseReference;
    }) as unknown as typeof fdb.ref,
    get: ((r: fdb.Query) => {
      const hr = r as unknown as HarnessRef;
      if (hr.dbTag === 'observer' || writerOnline) {
        return Promise.resolve(makeFakeSnap(effectiveServerVal(hr.path)));
      }
      if (activeWriterWatchedPaths.has(hr.path) || localOverlay.has(hr.path)) {
        return Promise.resolve(makeFakeSnap(effectiveWriterVal(hr.path)));
      }
      return new Promise<fdb.DataSnapshot>((resolve) => {
        pendingFlushTasks.push(() => {
          resolve(makeFakeSnap(effectiveServerVal(hr.path)));
        });
      });
    }) as unknown as typeof fdb.get,
    set: ((r: fdb.DatabaseReference, val: unknown) => {
      const hr = r as unknown as HarnessRef;
      if (hr.dbTag === 'observer' || writerOnline) {
        applyServerWrite(hr.path, val);
        return Promise.resolve();
      }
      localOverlay.set(hr.path, structuredClone(val));
      notifyMap(writerListeners, hr.path, effectiveWriterVal(hr.path));
      return new Promise<void>((resolve) => {
        pendingFlushTasks.push(() => {
          localOverlay.delete(hr.path);
          applyServerWrite(hr.path, val);
          resolve();
        });
      });
    }) as unknown as typeof fdb.set,
    update: ((r: fdb.DatabaseReference, patch: Record<string, unknown>) => {
      const hr = r as unknown as HarnessRef;
      const mergeInto = (current: unknown): Record<string, unknown> => {
        let baseObj: Record<string, unknown> = {};
        if (typeof current === 'object' && current !== null) {
          baseObj = Object.assign({}, current as Record<string, unknown>);
        }
        return { ...baseObj, ...structuredClone(patch) };
      };
      if (hr.dbTag === 'observer' || writerOnline) {
        applyServerWrite(hr.path, mergeInto(effectiveServerVal(hr.path)));
        return Promise.resolve();
      }
      const nextVal = mergeInto(effectiveWriterVal(hr.path));
      localOverlay.set(hr.path, nextVal);
      notifyMap(writerListeners, hr.path, nextVal);
      return new Promise<void>((resolve) => {
        pendingFlushTasks.push(() => {
          localOverlay.delete(hr.path);
          applyServerWrite(hr.path, mergeInto(effectiveServerVal(hr.path)));
          resolve();
        });
      });
    }) as unknown as typeof fdb.update,
    remove: ((r: fdb.DatabaseReference) => {
      const hr = r as unknown as HarnessRef;
      if (hr.dbTag === 'observer' || writerOnline) {
        applyServerWrite(hr.path, null);
        return Promise.resolve();
      }
      localOverlay.set(hr.path, null);
      notifyMap(writerListeners, hr.path, null);
      return new Promise<void>((resolve) => {
        pendingFlushTasks.push(() => {
          localOverlay.delete(hr.path);
          applyServerWrite(hr.path, null);
          resolve();
        });
      });
    }) as unknown as typeof fdb.remove,
    onValue: ((q: fdb.Query, cb: (snap: fdb.DataSnapshot) => void) => {
      const hr = q as unknown as HarnessRef;
      let targetMap = observerListeners;
      if (hr.dbTag === 'writer') {
        targetMap = writerListeners;
        activeWriterWatchedPaths.add(hr.path);
      }
      let bucket = targetMap.get(hr.path);
      if (bucket === undefined) {
        bucket = new Set();
        targetMap.set(hr.path, bucket);
      }
      bucket.add(cb);
      if (hr.dbTag === 'observer') {
        cb(makeFakeSnap(effectiveServerVal(hr.path)));
      } else if (writerOnline || hr.path === '.info/connected') {
        cb(makeFakeSnap(effectiveWriterVal(hr.path)));
      }
      return () => {
        bucket?.delete(cb);
        if (hr.dbTag === 'writer' && bucket !== undefined && bucket.size === 0) {
          activeWriterWatchedPaths.delete(hr.path);
        }
      };
    }) as unknown as typeof fdb.onValue,
    onDisconnect: ((r: fdb.DatabaseReference) => {
      const hr = r as unknown as HarnessRef;
      return {
        set(val: unknown) {
          if (writerOnline) {
            serverArmedDisconnects.set(hr.path, structuredClone(val));
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            pendingFlushTasks.push(() => {
              serverArmedDisconnects.set(hr.path, structuredClone(val));
              resolve();
            });
          });
        },
      };
    }) as unknown as typeof fdb.onDisconnect,
    runTransaction: ((r: fdb.DatabaseReference, updateFn: (cur: unknown) => unknown) => {
      const hr = r as unknown as HarnessRef;
      const runCommit = (): fdb.TransactionResult => {
        const nextVal = updateFn(effectiveServerVal(hr.path));
        applyServerWrite(hr.path, nextVal);
        return {
          committed: true,
          snapshot: makeFakeSnap(nextVal),
          toJSON() {
            return {};
          },
        } as fdb.TransactionResult;
      };
      if (writerOnline) {
        return Promise.resolve(runCommit());
      }
      updateFn(null);
      return new Promise<fdb.TransactionResult>((resolve) => {
        pendingFlushTasks.push(() => {
          resolve(runCommit());
        });
      });
    }) as unknown as typeof fdb.runTransaction,
  };
}

describe('rtdb-modular-gooffline-goonline-queue-and-isolation probe', () => {
  it('registers on sdk-probes linked to rtdb-modular#163 and #164 and passes auditProbeSessionAuthModes', async () => {
    expect(probe.rig).toBe('sdk-probes');
    expect(probe.requires).toEqual(['web-config', 'dedicated-rtdb']);
    expect(probe.pendingRowLink).toBeUndefined();
    expect(probe.rowIds).toEqual(['rtdb-modular#163', 'rtdb-modular#164']);
    expect(probe.matrixRow).toBe('rtdb-modular#163, rtdb-modular#164');
    expect(auditProbeSessionAuthModes()).toEqual([]);

    const sdkProbes = await loadModularProbes('sdk-probes');
    expect(sdkProbes.map((entry) => entry.id)).toContain(PROBE_NAME);
  });

  it('executes deleted-database guards against firebase/database and offline queue contract without volatile leaks', async () => {
    const deletedGuardSubject: DeletedDatabaseGuardSubject = {
      async openDeletedDatabase() {
        const app = initializeApp(
          {
            projectId: 'demo-gooffline-guard',
            databaseURL: 'https://demo-gooffline-guard-default-rtdb.firebaseio.com',
          },
          `offline-guard-${Date.now()}`,
        );
        const db = fdb.getDatabase(app);
        fdb.goOffline(db);
        await deleteApp(app);
        return {
          db,
          goOffline: fdb.goOffline,
          goOnline: fdb.goOnline,
        };
      },
    };
    const deletedGuards: DeletedDatabaseGuardsObservation =
      await observeDeletedDatabaseConnectionGuards(deletedGuardSubject);
    expect(deletedGuards).toEqual({
      goOfflineOnDeleted: {
        threw: true,
        isErrorInstance: true,
        message: 'FIREBASE FATAL ERROR: Cannot call goOffline on a deleted database. ',
      },
      goOnlineOnDeleted: {
        threw: true,
        isErrorInstance: true,
        message: 'FIREBASE FATAL ERROR: Cannot call goOnline on a deleted database. ',
      },
    });

    const live: GoOfflineGoOnlineContractObservation = await observeGoOfflineGoOnlineContract(
      buildTwoClientHarness(),
    );
    expect(live.returnValues).toEqual({
      goOfflineReturnsUndefined: true,
      goOnlineReturnsUndefined: true,
    });
    expect(live.connectionAndDisconnect).toEqual({
      writerConnectedTransitions: [true, false, true, false],
      observerStayedConnected: true,
      observerPresenceAfterFirstGoOffline: 'dropped-once',
      observerPresenceAfterOverwriteWhileWriterOffline: 'observer-override',
      redundantGoOfflineDidNotRedrain: true,
      goOnlineDidNotResurrectDrainedOp: true,
    });
    expect(live.offlineWriteQueueAndSyncTreeGet).toEqual({
      writerEventsWhileOffline: [
        { step: 1, keep: true },
        { step: 2, keep: true, added: 'offline' },
      ],
      observerValWhileWriterOffline: { step: 0, keep: true },
      warmListenerGetWhileOffline: {
        settledWhileOffline: true,
        val: { step: 2, keep: true, added: 'offline' },
      },
      uncachedCoveringSetGetWhileOffline: {
        setSettledWhileOffline: false,
        getSettledWhileOffline: true,
        val: { localCover: 7 },
      },
      coldUncachedGetWhileOffline: {
        settledWhileOffline: false,
        resolvedValAfterGoOnline: { serverSeed: 42 },
      },
      setSettledWhileOffline: false,
      updateSettledWhileOffline: false,
      removeSettledWhileOffline: false,
      finalObserverQueueStateAfterGoOnline: {
        watched: { step: 2, keep: true, added: 'offline' },
        toRemoveVal: null,
      },
    });
    expect(live.offlineTransactionDisconnectAndRemoteDeferral).toEqual({
      txInputsWhileOffline: [null],
      txSettledWhileOffline: false,
      onDisconnectArmSettledWhileOffline: false,
      writerRemoteFeedEventsWhileOffline: 0,
      txInputsTotal: [null, 10],
      txCommittedAfterGoOnline: true,
      txValAfterGoOnline: 15,
      writerRemoteFeedLatestAfterGoOnline: { seq: 2, from: 'observer' },
      queuedWhileOfflineOnDisconnectExecutedOnNextOffline: 'armed-while-offline',
    });

    const serialized = JSON.stringify({ live, deletedGuards });
    expect(serialized.includes('offline_harness_run')).toBe(false);
    expect(serialized.includes('demo-gooffline-guard')).toBe(false);
  });
});
