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
  const childEventDiffKt = readFileSync(
    join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'database', 'ChildEventDiff.kt'),
    'utf8',
  );
  const queryKt = readFileSync(
    join(KT_MAIN_ROOT, 'com', 'google', 'firebase', 'database', 'Query.kt'),
    'utf8',
  );
  expect(connInfoKt).toContain('state == BridgeConnectionState.ATTACHED && online');
  expect(connInfoKt).toContain('internal const val SERVER_TIME_OFFSET = 0L');
  expect(queryKt).toContain('diffChildSnapshots(previousChildren, currentList, querySpec)');
  expect(childEventDiffKt).toContain('indexedSortValueChanged(oldSnap, child, querySpec)');
  expect(childEventDiffKt.indexOf('ChildEvent.Moved(')).toBeLessThan(
    childEventDiffKt.indexOf('ChildEvent.Changed('),
  );
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
    const childTimelineEvents: string[] = [];
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
          const prevKeyByChild = new Map<string, string>();
          let runningPrev = 'null';
          for (const item of current) {
            prevKeyByChild.set(item.key, runningPrev);
            runningPrev = item.key;
          }
          if (prevEntries === null) {
            for (const item of current) {
              const prevName = prevKeyByChild.get(item.key);
              childTimelineEvents.push(`added:${item.key}:prev=${String(prevName)}`);
            }
          } else {
            const currentByKey = new Map(current.map((e) => [e.key, e]));
            const prevByKey = new Map(prevEntries.map((e) => [e.key, e]));
            for (const oldItem of prevEntries) {
              if (!currentByKey.has(oldItem.key)) {
                childTimelineEvents.push(`removed:${oldItem.key}:${String(oldItem.value)}`);
              }
            }
            for (const item of current) {
              if (!prevByKey.has(item.key)) {
                const prevName = prevKeyByChild.get(item.key);
                childTimelineEvents.push(`added:${item.key}:prev=${String(prevName)}`);
              }
            }
            for (const item of current) {
              const oldItem = prevByKey.get(item.key);
              if (oldItem !== undefined && oldItem.value !== item.value) {
                const prevName = prevKeyByChild.get(item.key);
                childTimelineEvents.push(`moved:${item.key}:prev=${String(prevName)}`);
              }
            }
            for (const item of current) {
              const oldItem = prevByKey.get(item.key);
              if (oldItem !== undefined && oldItem.value !== item.value) {
                childTimelineEvents.push(`changed:${item.key}:${String(item.value)}`);
              }
            }
          }
          prevEntries = current;
          if (notifyWatch !== null) {
            notifyWatch();
          }
        },
      );

      await waitWatch(() => valueCounts.length >= 1 && childTimelineEvents.length >= 2, 'initial');
      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${watchPath}/c`,
        value: 3,
        actAs,
      });
      await waitWatch(() => childTimelineEvents.includes('added:c:prev=b'), 'added-c');

      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.set',
        instance: DEDICATED_INSTANCE,
        path: `${watchPath}/a`,
        value: 10,
        actAs,
      });
      await waitWatch(
        () =>
          childTimelineEvents.includes('moved:a:prev=c') &&
          childTimelineEvents.includes('changed:a:10'),
        'updated-a',
      );

      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: `${watchPath}/b`,
        actAs,
      });
      await waitWatch(() => childTimelineEvents.includes('removed:b:2'), 'removed-b');

      expect(valueCounts[0]).toBe(obs.valueListenerInitialCount);
      expect(valueCounts.length >= 3).toBe(obs.valueListenerObservedMutations);
      expect(childTimelineEvents).toEqual(obs.childTimeline);

      bridge.unsubscribeAsSession(observerSession, 'rsub-rtdb-val');
      bridge.unsubscribeAsSession(observerSession, 'rsub-rtdb-child');
      const valCountAtUnsub = valueCounts.length;
      const childCountAtUnsub = childTimelineEvents.length;

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
        childTimelineEvents.length === childCountAtUnsub;
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
