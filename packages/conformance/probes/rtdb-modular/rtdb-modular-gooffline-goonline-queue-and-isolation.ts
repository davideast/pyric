import type { Database, DataSnapshot, TransactionResult } from 'firebase/database';
import type { Probe } from '../../rigs/types.ts';
import { withRtdbProbeSession } from '../../src/sdk-probe-runtime.ts';

interface SyncThrowSummary {
  threw: boolean;
  isErrorInstance: boolean;
  message: string | null;
}

export interface DeletedDatabaseGuardSubject {
  openDeletedDatabase(): Promise<{
    db: Database;
    goOffline(db: Database): unknown;
    goOnline(db: Database): unknown;
  }>;
}

export interface DeletedDatabaseGuardsObservation {
  goOfflineOnDeleted: SyncThrowSummary;
  goOnlineOnDeleted: SyncThrowSummary;
}

export interface GoOfflineGoOnlineProbeSubject {
  writerDb: Database;
  observerDb: Database;
  basePath: string;
  goOffline(db: Database): unknown;
  goOnline(db: Database): unknown;
  ref: typeof import('firebase/database').ref;
  get: typeof import('firebase/database').get;
  set: typeof import('firebase/database').set;
  update: typeof import('firebase/database').update;
  remove: typeof import('firebase/database').remove;
  onValue: typeof import('firebase/database').onValue;
  onDisconnect: typeof import('firebase/database').onDisconnect;
  runTransaction: typeof import('firebase/database').runTransaction;
}

export interface GoOfflineGoOnlineContractObservation {
  returnValues: {
    goOfflineReturnsUndefined: boolean;
    goOnlineReturnsUndefined: boolean;
  };
  connectionAndDisconnect: {
    writerConnectedTransitions: boolean[];
    observerStayedConnected: boolean;
    observerPresenceAfterFirstGoOffline: unknown;
    observerPresenceAfterOverwriteWhileWriterOffline: unknown;
    redundantGoOfflineDidNotRedrain: boolean;
    goOnlineDidNotResurrectDrainedOp: boolean;
  };
  offlineWriteQueueAndSyncTreeGet: {
    writerEventsWhileOffline: unknown[];
    observerValWhileWriterOffline: unknown;
    warmListenerGetWhileOffline: {
      settledWhileOffline: boolean;
      val: unknown;
    };
    uncachedCoveringSetGetWhileOffline: {
      setSettledWhileOffline: boolean;
      getSettledWhileOffline: boolean;
      val: unknown;
    };
    coldUncachedGetWhileOffline: {
      settledWhileOffline: boolean;
      resolvedValAfterGoOnline: unknown;
    };
    setSettledWhileOffline: boolean;
    updateSettledWhileOffline: boolean;
    removeSettledWhileOffline: boolean;
    finalObserverQueueStateAfterGoOnline: unknown;
  };
  offlineTransactionDisconnectAndRemoteDeferral: {
    txInputsWhileOffline: unknown[];
    txSettledWhileOffline: boolean;
    onDisconnectArmSettledWhileOffline: boolean;
    writerRemoteFeedEventsWhileOffline: number;
    txInputsTotal: unknown[];
    txCommittedAfterGoOnline: boolean;
    txValAfterGoOnline: unknown;
    writerRemoteFeedLatestAfterGoOnline: unknown;
    queuedWhileOfflineOnDisconnectExecutedOnNextOffline: unknown;
  };
}

function captureSyncCall(invoke: () => unknown): SyncThrowSummary {
  try {
    invoke();
    return {
      threw: false,
      isErrorInstance: false,
      message: null,
    };
  } catch (err) {
    let message: string | null = String(err);
    if (err instanceof Error) {
      message = err.message;
    }
    return {
      threw: true,
      isErrorInstance: err instanceof Error,
      message,
    };
  }
}

async function waitForCondition(
  label: string,
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function settleWindow(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function observeDeletedDatabaseConnectionGuards(
  subject: DeletedDatabaseGuardSubject,
): Promise<DeletedDatabaseGuardsObservation> {
  const handle = await subject.openDeletedDatabase();
  return {
    goOfflineOnDeleted: captureSyncCall(() => handle.goOffline(handle.db)),
    goOnlineOnDeleted: captureSyncCall(() => handle.goOnline(handle.db)),
  };
}

export async function observeGoOfflineGoOnlineContract(
  subject: GoOfflineGoOnlineProbeSubject,
): Promise<GoOfflineGoOnlineContractObservation> {
  const {
    writerDb,
    observerDb,
    basePath,
    goOffline,
    goOnline,
    ref,
    get,
    set,
    update,
    remove,
    onValue,
    onDisconnect,
    runTransaction,
  } = subject;

  const unsubs: Array<() => void> = [];
  try {
    // Seed initial baseline paths while both clients are online (coldTarget and txCounter via observerDb
    // so writerDb has neither a listener nor a prior local write on those paths).
    await set(ref(writerDb, `${basePath}/presence`), 'online-v1');
    await set(ref(writerDb, `${basePath}/watched`), { step: 0, keep: true });
    await set(ref(writerDb, `${basePath}/toRemove`), 'present');
    await set(ref(observerDb, `${basePath}/coldTarget`), { serverSeed: 42 });
    await set(ref(writerDb, `${basePath}/remoteFeed`), { seq: 1 });
    await set(ref(observerDb, `${basePath}/txCounter`), 10);

    const writerConnected: boolean[] = [];
    const observerConnected: boolean[] = [];
    unsubs.push(
      onValue(ref(writerDb, '.info/connected'), (snap: DataSnapshot) => {
        const val = snap.val();
        if (typeof val === 'boolean') {
          if (writerConnected.length === 0 || writerConnected[writerConnected.length - 1] !== val) {
            writerConnected.push(val);
          }
        }
      }),
    );
    unsubs.push(
      onValue(ref(observerDb, '.info/connected'), (snap: DataSnapshot) => {
        const val = snap.val();
        if (typeof val === 'boolean') {
          if (
            observerConnected.length === 0 ||
            observerConnected[observerConnected.length - 1] !== val
          ) {
            observerConnected.push(val);
          }
        }
      }),
    );

    await waitForCondition(
      'both clients initially connected',
      () => writerConnected.includes(true) && observerConnected.includes(true),
    );

    let observerPresenceLatest: unknown = null;
    unsubs.push(
      onValue(ref(observerDb, `${basePath}/presence`), (snap: DataSnapshot) => {
        observerPresenceLatest = snap.val();
      }),
    );
    await waitForCondition(
      'observer initial presence read',
      () => observerPresenceLatest === 'online-v1',
    );

    // Attach active listeners on writerDb before going offline:
    // 1. watched: verifies local optimistic listener updates + SyncTree get() hit while offline.
    // 2. remoteFeed: verifies remote writes from observerDb are deferred while writerDb is offline.
    const writerWatchedEvents: unknown[] = [];
    unsubs.push(
      onValue(ref(writerDb, `${basePath}/watched`), (snap: DataSnapshot) => {
        writerWatchedEvents.push(snap.val());
      }),
    );
    const writerRemoteFeedEvents: unknown[] = [];
    unsubs.push(
      onValue(ref(writerDb, `${basePath}/remoteFeed`), (snap: DataSnapshot) => {
        writerRemoteFeedEvents.push(snap.val());
      }),
    );
    await waitForCondition(
      'writer initial watched and remoteFeed listeners synced',
      () => writerWatchedEvents.length >= 1 && writerRemoteFeedEvents.length >= 1,
    );

    let observerWatchedLatest: unknown = null;
    unsubs.push(
      onValue(ref(observerDb, `${basePath}/watched`), (snap: DataSnapshot) => {
        observerWatchedLatest = snap.val();
      }),
    );
    await waitForCondition(
      'observer initial watched listener synced',
      () => observerWatchedLatest !== null,
    );

    // Arm onDisconnect on presence while online, then take writerDb offline.
    await onDisconnect(ref(writerDb, `${basePath}/presence`)).set('dropped-once');

    const offResult = goOffline(writerDb);
    await waitForCondition(
      'writer .info/connected false and observer sees onDisconnect drain',
      () =>
        writerConnected[writerConnected.length - 1] === false &&
        observerPresenceLatest === 'dropped-once',
    );
    const observerPresenceAfterFirstGoOffline = observerPresenceLatest;

    // Overwrite presence from online observerDb, then call redundant goOffline(writerDb):
    // must NOT re-drain the already-executed onDisconnect operation.
    await set(ref(observerDb, `${basePath}/presence`), 'observer-override');
    await waitForCondition(
      'observer presence updated to observer-override',
      () => observerPresenceLatest === 'observer-override',
    );
    goOffline(writerDb);
    await settleWindow();
    const observerPresenceAfterOverwriteWhileWriterOffline = observerPresenceLatest;
    const redundantGoOfflineDidNotRedrain = observerPresenceLatest === 'observer-override';

    // Record baseline counts right before issuing offline operations on writerDb.
    const watchedCountBeforeOfflineWrites = writerWatchedEvents.length;
    const remoteFeedCountBeforeRemoteWrite = writerRemoteFeedEvents.length;

    // Issue offline set, update, and remove on writerDb.
    let setSettled = false;
    const setPromise = set(ref(writerDb, `${basePath}/watched`), { step: 1, keep: true }).then(
      () => {
        setSettled = true;
      },
    );
    let updateSettled = false;
    const updatePromise = update(ref(writerDb, `${basePath}/watched`), {
      step: 2,
      added: 'offline',
    }).then(() => {
      updateSettled = true;
    });
    let removeSettled = false;
    const removePromise = remove(ref(writerDb, `${basePath}/toRemove`)).then(() => {
      removeSettled = true;
    });

    // Issue warm-listener get(), uncached covering-set get(), and cold-uncached get() while offline.
    let warmGetSettled = false;
    let warmGetVal: unknown = null;
    const warmGetPromise = get(ref(writerDb, `${basePath}/watched`)).then((snap) => {
      warmGetSettled = true;
      warmGetVal = snap.val();
    });

    let coveringSetSettled = false;
    const coveringSetPromise = set(ref(writerDb, `${basePath}/coveringSet`), {
      localCover: 7,
    }).then(() => {
      coveringSetSettled = true;
    });
    let coveringGetSettled = false;
    let coveringGetVal: unknown = null;
    const coveringGetPromise = get(ref(writerDb, `${basePath}/coveringSet`)).then((snap) => {
      coveringGetSettled = true;
      coveringGetVal = snap.val();
    });

    let coldGetSettled = false;
    let coldGetVal: unknown = null;
    const coldGetPromise = get(ref(writerDb, `${basePath}/coldTarget`)).then((snap) => {
      coldGetSettled = true;
      coldGetVal = snap.val();
    });

    // Issue offline runTransaction and offline onDisconnect registration on writerDb.
    const txInputs: unknown[] = [];
    let txSettled = false;
    let txFinalResult: TransactionResult | null = null;
    const txPromise = runTransaction(ref(writerDb, `${basePath}/txCounter`), (current) => {
      txInputs.push(structuredClone(current));
      let base = 0;
      if (typeof current === 'number') {
        base = current;
      }
      return base + 5;
    }).then((res) => {
      txSettled = true;
      txFinalResult = res;
    });

    let onDiscArmSettled = false;
    const onDiscArmPromise = onDisconnect(ref(writerDb, `${basePath}/offlineArmed`)).set(
      'armed-while-offline',
    ).then(() => {
      onDiscArmSettled = true;
    });

    // Simultaneously write to remoteFeed from online observerDb while writerDb is offline.
    await set(ref(observerDb, `${basePath}/remoteFeed`), { seq: 2, from: 'observer' });
    await settleWindow();

    await Promise.all([warmGetPromise, coveringGetPromise]);
    const writerEventsWhileOffline = writerWatchedEvents.slice(watchedCountBeforeOfflineWrites);
    const observerValWhileWriterOffline = (await get(ref(observerDb, `${basePath}/watched`))).val();
    const setSettledWhileOffline = setSettled;
    const updateSettledWhileOffline = updateSettled;
    const removeSettledWhileOffline = removeSettled;
    const warmSettledWhileOffline = warmGetSettled;
    const coveringSetSettledWhileOffline = coveringSetSettled;
    const coveringGetSettledWhileOffline = coveringGetSettled;
    const coldSettledWhileOffline = coldGetSettled;
    const txInputsWhileOffline = [...txInputs];
    const txSettledWhileOffline = txSettled;
    const onDisconnectArmSettledWhileOffline = onDiscArmSettled;
    const writerRemoteFeedEventsWhileOffline =
      writerRemoteFeedEvents.length - remoteFeedCountBeforeRemoteWrite;

    // Now bring writerDb back online: queued writes, cold get, transaction, onDisconnect arm,
    // and deferred remoteFeed update must all flush and converge.
    const onResult = goOnline(writerDb);
    await Promise.all([
      setPromise,
      updatePromise,
      removePromise,
      coveringSetPromise,
      coldGetPromise,
      txPromise,
      onDiscArmPromise,
    ]);

    await waitForCondition(
      'writer reconnected, remoteFeed delivered, and observer sees flushed watched state',
      () =>
        writerConnected[writerConnected.length - 1] === true &&
        writerRemoteFeedEvents.length > remoteFeedCountBeforeRemoteWrite &&
        typeof observerWatchedLatest === 'object' &&
        observerWatchedLatest !== null &&
        (observerWatchedLatest as { step?: unknown }).step === 2,
    );

    const removedSnap = await get(ref(observerDb, `${basePath}/toRemove`));
    const finalWatchedSnap = await get(ref(observerDb, `${basePath}/watched`));
    const presenceAfterGoOnline = (await get(ref(observerDb, `${basePath}/presence`))).val();
    const goOnlineDidNotResurrectDrainedOp = presenceAfterGoOnline === 'observer-override';

    let txCommittedAfterGoOnline = false;
    let txValAfterGoOnline: unknown = null;
    if (txFinalResult !== null) {
      const settledTx = txFinalResult as TransactionResult;
      txCommittedAfterGoOnline = settledTx.committed;
      txValAfterGoOnline = settledTx.snapshot.val();
    }

    // Finally, verify the onDisconnect armed while offline was registered upon goOnline
    // by taking writerDb offline one more time and reading from observerDb, then reconnecting.
    let observerOfflineArmedVal: unknown = null;
    unsubs.push(
      onValue(ref(observerDb, `${basePath}/offlineArmed`), (snap: DataSnapshot) => {
        observerOfflineArmedVal = snap.val();
      }),
    );
    goOffline(writerDb);
    await waitForCondition(
      'queued-while-offline onDisconnect executed on subsequent goOffline',
      () => observerOfflineArmedVal === 'armed-while-offline',
    );
    const queuedWhileOfflineOnDisconnectExecutedOnNextOffline = observerOfflineArmedVal;
    goOnline(writerDb);
    await waitForCondition(
      'writer restored online at end of probe',
      () => writerConnected[writerConnected.length - 1] === true,
    );

    return {
      returnValues: {
        goOfflineReturnsUndefined: offResult === undefined,
        goOnlineReturnsUndefined: onResult === undefined,
      },
      connectionAndDisconnect: {
        writerConnectedTransitions: writerConnected.slice(0, 4),
        observerStayedConnected: observerConnected.every((v) => v === true),
        observerPresenceAfterFirstGoOffline,
        observerPresenceAfterOverwriteWhileWriterOffline,
        redundantGoOfflineDidNotRedrain,
        goOnlineDidNotResurrectDrainedOp,
      },
      offlineWriteQueueAndSyncTreeGet: {
        writerEventsWhileOffline,
        observerValWhileWriterOffline,
        warmListenerGetWhileOffline: {
          settledWhileOffline: warmSettledWhileOffline,
          val: warmGetVal,
        },
        uncachedCoveringSetGetWhileOffline: {
          setSettledWhileOffline: coveringSetSettledWhileOffline,
          getSettledWhileOffline: coveringGetSettledWhileOffline,
          val: coveringGetVal,
        },
        coldUncachedGetWhileOffline: {
          settledWhileOffline: coldSettledWhileOffline,
          resolvedValAfterGoOnline: coldGetVal,
        },
        setSettledWhileOffline,
        updateSettledWhileOffline,
        removeSettledWhileOffline,
        finalObserverQueueStateAfterGoOnline: {
          watched: finalWatchedSnap.val(),
          toRemoveVal: removedSnap.val(),
        },
      },
      offlineTransactionDisconnectAndRemoteDeferral: {
        txInputsWhileOffline,
        txSettledWhileOffline,
        onDisconnectArmSettledWhileOffline,
        writerRemoteFeedEventsWhileOffline,
        txInputsTotal: txInputs,
        txCommittedAfterGoOnline,
        txValAfterGoOnline,
        writerRemoteFeedLatestAfterGoOnline:
          writerRemoteFeedEvents[writerRemoteFeedEvents.length - 1],
        queuedWhileOfflineOnDisconnectExecutedOnNextOffline,
      },
    };
  } finally {
    for (const unsub of unsubs) {
      unsub();
    }
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'dedicated-rtdb'],
  matrixRow: '',
  rowIds: [],
  pendingRowLink: true,
  description:
    'firebase/database modular goOffline(db) and goOnline(db): observes per-client .info/connected transitions and one-shot onDisconnect drain without resurrection, offline set/update/remove local SyncTree listener firing with pending outbound Promises until goOnline flushes in FIFO order, warm-listener immediate SyncTree get() vs cold uncached get() waiting for goOnline, offline runTransaction and onDisconnect queueing, remote write listener deferral while offline, and deleted-database synchronous fatal errors.',
  observe() {
    return withRtdbProbeSession({}, async ({ runId, runPath, db, rtdbSdk, openClient }) => {
      const { deleteApp, initializeApp } = await import('firebase/app');
      const observer = await openClient('observer');

      const live = await observeGoOfflineGoOnlineContract({
        writerDb: db,
        observerDb: observer.db,
        basePath: runPath,
        goOffline: rtdbSdk.goOffline,
        goOnline: rtdbSdk.goOnline,
        ref: rtdbSdk.ref,
        get: rtdbSdk.get,
        set: rtdbSdk.set,
        update: rtdbSdk.update,
        remove: rtdbSdk.remove,
        onValue: rtdbSdk.onValue,
        onDisconnect: rtdbSdk.onDisconnect,
        runTransaction: rtdbSdk.runTransaction,
      });

      const deletedGuards = await observeDeletedDatabaseConnectionGuards({
        async openDeletedDatabase() {
          const tempApp = initializeApp(
            {
              projectId: 'demo-deleted-gooffline',
              databaseURL: 'https://demo-deleted-gooffline-default-rtdb.firebaseio.com',
            },
            `sdk-probe-del-${runId}`,
          );
          const tempDb = rtdbSdk.getDatabase(tempApp);
          rtdbSdk.goOffline(tempDb);
          await deleteApp(tempApp);
          return {
            db: tempDb,
            goOffline: rtdbSdk.goOffline,
            goOnline: rtdbSdk.goOnline,
          };
        },
      });

      return {
        live,
        deletedGuards,
      };
    });
  },
};
