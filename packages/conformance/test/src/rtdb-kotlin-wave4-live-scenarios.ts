import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEDICATED_INSTANCE,
  extractRtdbSnap,
  KT_MAIN_ROOT,
  openMultiSessionDedicatedRtdbBridge,
  type RtdbKotlinListenersTxConnectionOnDisconnectObservation,
  type RtdbWireSnap,
} from './rtdb-kotlin-wave4-oracle-replay-harness.ts';

export async function verifyWave4ListenersTransactionsAndOnDisconnect(
  obs: RtdbKotlinListenersTxConnectionOnDisconnectObservation,
): Promise<void> {
  const connInfoKt = readFileSync(
    join(KT_MAIN_ROOT, 'dev', 'pyric', 'database', 'internal', 'ConnectionInfo.kt'),
    'utf8',
  );
  expect(connInfoKt).toContain('state == BridgeConnectionState.ATTACHED && online');
  expect(connInfoKt).toContain('internal const val SERVER_TIME_OFFSET = 0L');
  expect(obs.infoConnectedToggleTrueFalseTrue).toBe(true);
  expect(obs.infoServerTimeOffsetClass).toBe('java.lang.Long');

  const runId = 'replay_rtdb_live_1';
  const observerSession = 'kt-rtdb-observer';
  const writerSession = 'kt-rtdb-writer';
  const bridge = await openMultiSessionDedicatedRtdbBridge(
    `demo-kt-rtdb-live-${Date.now()}`,
    runId,
    'android-rtdb-live-uid',
  );

  try {
    const { actAs } = bridge;
    const basePath = `pyric_oracle/${runId}/rtdb_kotlin`;
    const watchPath = `${basePath}/watched_scores`;

    await bridge.sendOpAsSession(observerSession, {
      method: 'rtdb.set',
      instance: DEDICATED_INSTANCE,
      path: watchPath,
      value: { a: 1, b: 2 },
      actAs,
    });

    const valueCounts: number[] = [];
    const addedAndRemovedEvents: string[] = [];
    const waitTimers = new Set<ReturnType<typeof setTimeout>>();
    let prevEntries: Array<{ key: string; value: unknown }> | null = null;
    let notifyWatch: (() => void) | null = null;

    const waitWatch = (predicate: () => boolean, label: string) => {
      if (predicate()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          waitTimers.delete(timer);
          rejectWait(new Error(`Timed out waiting for RTDB watch '${label}'`));
        }, 5_000);
        waitTimers.add(timer);
        notifyWatch = () => {
          if (predicate()) {
            clearTimeout(timer);
            waitTimers.delete(timer);
            notifyWatch = null;
            resolveWait();
          }
        };
      });
    };

    try {
      bridge.subscribeAsSession(
        observerSession,
        'rsub-rtdb-val',
        { target: { service: 'rtdb', instance: DEDICATED_INSTANCE, path: watchPath }, actAs },
        (raw) => {
          const snap = raw as RtdbWireSnap;
          valueCounts.push(snap.size);
          if (notifyWatch !== null) {
            notifyWatch();
          }
        },
      );
      bridge.subscribeAsSession(
        observerSession,
        'rsub-rtdb-child',
        {
          target: {
            service: 'rtdb',
            instance: DEDICATED_INSTANCE,
            path: watchPath,
            query: { orderBy: { kind: 'value' }, bounds: [], limit: null },
          },
          actAs,
        },
        (raw) => {
          const snap = raw as RtdbWireSnap;
          const current = snap.entries.map((e) => ({ key: e.key, value: e.value }));
          if (prevEntries === null) {
            let prevKey = 'null';
            for (const item of current) {
              addedAndRemovedEvents.push(`added:${item.key}:prev=${prevKey}`);
              prevKey = item.key;
            }
          } else {
            const currentKeys = new Set(current.map((e) => e.key));
            const prevKeys = new Set(prevEntries.map((e) => e.key));
            for (const oldItem of prevEntries) {
              if (!currentKeys.has(oldItem.key)) {
                addedAndRemovedEvents.push(`removed:${oldItem.key}:${String(oldItem.value)}`);
              }
            }
            let prevKey = 'null';
            for (const item of current) {
              if (!prevKeys.has(item.key)) {
                addedAndRemovedEvents.push(`added:${item.key}:prev=${prevKey}`);
              }
              prevKey = item.key;
            }
          }
          prevEntries = current;
          if (notifyWatch !== null) {
            notifyWatch();
          }
        },
      );

      await waitWatch(() => valueCounts.length >= 1 && addedAndRemovedEvents.length >= 2, 'initial');
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${watchPath}/c`,
        value: 3,
        actAs,
      });
      await waitWatch(() => addedAndRemovedEvents.includes('added:c:prev=b'), 'added-c');

      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${watchPath}/a`,
        value: 10,
        actAs,
      });
      await waitWatch(() => valueCounts.length >= 3, 'updated-a');

      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: `${watchPath}/b`,
        actAs,
      });
      await waitWatch(() => addedAndRemovedEvents.includes('removed:b:2'), 'removed-b');

      expect(valueCounts[0]).toBe(obs.valueListenerInitialCount);
      expect(valueCounts.length >= 3).toBe(obs.valueListenerObservedMutations);
      expect(obs.childTimeline).toContain('added:a:prev=null');
      expect(obs.childTimeline).toContain('added:b:prev=a');
      expect(obs.childTimeline).toContain('added:c:prev=b');
      expect(obs.childTimeline).toContain('removed:b:2');
      expect(addedAndRemovedEvents).toEqual([
        'added:a:prev=null',
        'added:b:prev=a',
        'added:c:prev=b',
        'removed:b:2',
      ]);

      bridge.unsubscribeAsSession(observerSession, 'rsub-rtdb-val');
      bridge.unsubscribeAsSession(observerSession, 'rsub-rtdb-child');
      const valCountAtUnsub = valueCounts.length;
      const childCountAtUnsub = addedAndRemovedEvents.length;

      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${watchPath}/d`,
        value: 4,
        actAs,
      });
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: watchPath,
        actAs,
      });
      const quiet =
        valueCounts.length === valCountAtUnsub &&
        addedAndRemovedEvents.length === childCountAtUnsub;
      expect(quiet).toBe(obs.silentAfterRemoveEventListener);
    } finally {
      for (const timer of waitTimers) {
        clearTimeout(timer);
      }
      waitTimers.clear();
      notifyWatch = null;
      bridge.unsubscribeAsSession(observerSession, 'rsub-rtdb-val');
      bridge.unsubscribeAsSession(observerSession, 'rsub-rtdb-child');
    }

    const txPath = `${basePath}/tx_counter`;
    await bridge.sendOpAsSession(observerSession, {
      method: 'rtdb.set',
      instance: DEDICATED_INSTANCE,
      path: txPath,
      value: 10,
      actAs,
    });

    const txGet1 = extractRtdbSnap(
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: txPath,
        transaction: true,
        actAs,
      }),
    );
    const txCommitRes = await bridge.sendOpAsSession(observerSession, {
      method: 'rtdb.transactionCommit',
      instance: DEDICATED_INSTANCE,
      path: txPath,
      expected: txGet1.value,
      value: (txGet1.value as number) + 7,
      applyLocally: true,
      actAs,
    });
    expect(txCommitRes.ok).toBe(obs.txCommitErrorNull);
    const txCommitWire = txCommitRes.value as { committed: boolean; snapshot: RtdbWireSnap };
    expect(txCommitWire.committed).toBe(obs.txCommitCommitted);
    expect(txCommitWire.snapshot.value).toBe(obs.txCommitFinalValue);

    const txGetAbort = extractRtdbSnap(
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: txPath,
        transaction: true,
        actAs,
      }),
    );
    expect(txGetAbort.value).toBe(17);
    expect(obs.txAbortErrorNull).toBe(true);
    expect(obs.txAbortCommitted).toBe(false);
    const txAfterAbort = extractRtdbSnap(
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: txPath,
        actAs,
      }),
    );
    expect(txAfterAbort.value).toBe(obs.txServerValueAfterAbort);

    const presenceBase = `${basePath}/presence`;
    await bridge.sendOpAsSession(observerSession, {
      method: 'rtdb.set',
      instance: DEDICATED_INSTANCE,
      path: `${presenceBase}/status`,
      value: 'online',
      actAs,
    });
    await bridge.sendOpAsSession(observerSession, {
      method: 'rtdb.set',
      instance: DEDICATED_INSTANCE,
      path: `${presenceBase}/ephemeral_session`,
      value: 'active-ephemeral',
      actAs,
    });
    await bridge.sendOpAsSession(observerSession, {
      method: 'rtdb.set',
      instance: DEDICATED_INSTANCE,
      path: `${presenceBase}/kept_after_cancel`,
      value: 'kept-alive',
      actAs,
    });

    await bridge.sendOpAsSession(writerSession, {
      method: 'rtdb.onDisconnectSet',
      instance: DEDICATED_INSTANCE,
      path: `${presenceBase}/status`,
      value: 'offline-by-ondisconnect',
      actAs,
    });
    await bridge.sendOpAsSession(writerSession, {
      method: 'rtdb.onDisconnectRemove',
      instance: DEDICATED_INSTANCE,
      path: `${presenceBase}/ephemeral_session`,
      actAs,
    });
    await bridge.sendOpAsSession(writerSession, {
      method: 'rtdb.onDisconnectSet',
      instance: DEDICATED_INSTANCE,
      path: `${presenceBase}/kept_after_cancel`,
      value: 'must-not-run',
      actAs,
    });
    await bridge.sendOpAsSession(writerSession, {
      method: 'rtdb.onDisconnectCancel',
      instance: DEDICATED_INSTANCE,
      path: `${presenceBase}/kept_after_cancel`,
      actAs,
    });

    const goOfflineRes = await bridge.sendOpAsSession(writerSession, {
      method: 'rtdb.goOffline',
      instance: DEDICATED_INSTANCE,
      actAs,
    });
    expect(goOfflineRes.ok).toBe(true);

    const statusAfter = extractRtdbSnap(
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: `${presenceBase}/status`,
        actAs,
      }),
    );
    const ephemeralAfter = extractRtdbSnap(
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: `${presenceBase}/ephemeral_session`,
        actAs,
      }),
    );
    const canceledAfter = extractRtdbSnap(
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.get',
        instance: DEDICATED_INSTANCE,
        path: `${presenceBase}/kept_after_cancel`,
        actAs,
      }),
    );

    expect(statusAfter.value).toBe(obs.onDisconnect.statusAfterDisconnect);
    expect(ephemeralAfter.exists).toBe(obs.onDisconnect.ephemeralExistsAfterDisconnect);
    expect(canceledAfter.value).toBe(obs.onDisconnect.canceledPathValueAfterDisconnect);
  } finally {
    await bridge.close();
  }
}
