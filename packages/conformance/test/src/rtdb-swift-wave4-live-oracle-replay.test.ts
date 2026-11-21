import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { mintCustomToken } from 'pyric/sandbox/internal';
import type {
  BridgeMessage,
  WorkerOpFrame,
  WorkerResFrame,
  WorkerSubFrame,
} from '../../../cli/dist/bridge/protocol.js';
import { createHostedRuntime } from '../../../cli/dist/serve/hosted/runtime.js';
import { REPO_ROOT } from '../../src/ledger.ts';
import { createObservationGate } from '../../src/observation-gate.ts';
import {
  DEDICATED_INSTANCE,
  extractRtdbSnap,
  type RtdbWireSnap,
} from './rtdb-kotlin-wave4-oracle-replay-harness.ts';

interface RtdbSwiftListenersTransactionsOnDisconnectObservation {
  childTimeline: string[];
  cleanupRemovedRunNode: boolean;
  infoConnectedToggleTrueFalseTrue: boolean;
  infoServerTimeOffsetIsNSNumber: boolean;
  infoUnknownKeyFiredValueEvent: boolean;
  infoUnknownKeyKey: string;
  observeSingleCountAfterUnsub: number;
  onDisconnect: {
    canceledPathValueAfterDisconnect: string;
    ephemeralExistsAfterDisconnect: boolean;
    metaKeepPreservedAfterDisconnect: number;
    metaStateAfterDisconnect: string;
    statusAfterDisconnect: string;
  };
  silentAfterRemoveObserver: boolean;
  txAbortCommitted: boolean;
  txCommitCommitted: boolean;
  txCommitFinalValue: number;
  txServerValueAfterAbort: number;
  valueListenerInitialCount: number;
  valueListenerObservedMutations: boolean;
}

const RTDB_SWIFT_OBSERVATIONS_DIR = join(
  REPO_ROOT,
  'packages',
  'conformance',
  'observations',
  'rtdb-swift',
);
const SWIFT_DATABASE_SOURCE_DIR = join(REPO_ROOT, 'packages', 'swift-client', 'Sources', 'PyricDatabase');

const gate = createObservationGate({
  dir: RTDB_SWIFT_OBSERVATIONS_DIR,
  match: (filename) =>
    filename === 'rtdb-swift-listeners-transactions-connection-and-ondisconnect.json',
});

function makeInMemoryHostedPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

async function openTwoAppSwiftRtdbBridge(projectId: string, runId: string, uid: string) {
  const pendingReplies = new Map<string, (frame: WorkerResFrame) => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const subListeners = new Map<string, (value: unknown) => void>();
  const persistence = makeInMemoryHostedPersistence();
  const defaultRules = { rules: { '.read': false, '.write': false } };
  const dedicatedRules = {
    rules: {
      pyric_oracle: {
        [runId]: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          watched_scores: { '.indexOn': '.value' },
        },
      },
    },
  };

  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: defaultRules,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${projectId}-default-rtdb`,
        projectId,
        rules: {
          [`${projectId}-default-rtdb`]: defaultRules,
          [DEDICATED_INSTANCE]: dedicatedRules,
        },
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: projectId,
      sessionToken: `tok-${projectId}`,
    },
    'http://127.0.0.1:4400',
    (frame: BridgeMessage) => {
      if (frame.type === 'worker-res') {
        const resolver = pendingReplies.get(frame.id);
        if (resolver !== undefined) {
          pendingReplies.delete(frame.id);
          resolver(frame);
        }
      } else if (frame.type === 'worker-snap') {
        const listener = subListeners.get(frame.subId);
        if (listener !== undefined) {
          listener(frame.value);
        }
      }
    },
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  let seq = 0;
  const sendOpAsSession = (
    clientSessionId: string,
    op: Record<string, unknown>,
  ): Promise<WorkerResFrame> => {
    seq += 1;
    const id = `ios-rtdb-ms-${seq}`;
    return new Promise<WorkerResFrame>((resolveReply, rejectReply) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        pendingReplies.delete(id);
        rejectReply(new Error(`Hosted RTDB multi-session op '${id}' timed out`));
      }, 5_000);
      pendingTimers.add(timer);
      pendingReplies.set(id, (frame) => {
        clearTimeout(timer);
        pendingTimers.delete(timer);
        resolveReply(frame);
      });
      runtime.receive({
        type: 'worker-op',
        id,
        clientSessionId,
        op: op as unknown as WorkerOpFrame['op'],
      });
    });
  };

  const close = async (): Promise<void> => {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    pendingReplies.clear();
    subListeners.clear();
    await runtime.close();
  };

  try {
    const customToken = mintCustomToken({ uid, projectId, nowMs: Date.now() });
    const obsSignIn = await sendOpAsSession('ios-rtdb-observer', {
      method: 'auth.signInWithCustomToken',
      customToken,
    });
    const writerSignIn = await sendOpAsSession('ios-rtdb-writer', {
      method: 'auth.signInWithCustomToken',
      customToken,
    });
    if (!obsSignIn.ok || !writerSignIn.ok) {
      throw new Error('Multi-session custom token sign-in failed');
    }
  } catch (err) {
    await close();
    throw err;
  }

  return {
    actAs: { mode: 'as' as const, uid },
    sendOpAsSession,
    subscribeAsSession(
      clientSessionId: string,
      subId: string,
      sub: Record<string, unknown>,
      onSnap: (value: unknown) => void,
    ): void {
      subListeners.set(subId, onSnap);
      runtime.receive({
        type: 'worker-sub',
        subId,
        clientSessionId,
        sub: sub as unknown as WorkerSubFrame['sub'],
      });
    },
    unsubscribeAsSession(clientSessionId: string, subId: string): void {
      subListeners.delete(subId);
      runtime.receive({ type: 'worker-unsub', subId, clientSessionId });
    },
    close,
  };
}

describe('rtdb-swift Wave 4 listeners, .info connection, transactions, and two-app OnDisconnect replay', () => {
  test('replays .info/connected + unknown .info silence, value/child event ordering, removeObserver, transactions, and OnDisconnect', async () => {
    const obs = gate.load<RtdbSwiftListenersTransactionsOnDisconnectObservation>(
      'rtdb-swift-listeners-transactions-connection-and-ondisconnect',
    );

    const connInfoSwift = readFileSync(join(SWIFT_DATABASE_SOURCE_DIR, 'ConnectionInfo.swift'), 'utf8');
    const coordinatorSwift = readFileSync(
      join(SWIFT_DATABASE_SOURCE_DIR, 'DatabaseViewCoordinator.swift'),
      'utf8',
    );
    const eventsSwift = readFileSync(
      join(SWIFT_DATABASE_SOURCE_DIR, 'DatabaseSnapshotEvents.swift'),
      'utf8',
    );
    const onDisconnectSwift = readFileSync(join(SWIFT_DATABASE_SOURCE_DIR, 'OnDisconnect.swift'), 'utf8');

    expect(connInfoSwift).toContain('state == .attached && online');
    expect(coordinatorSwift).toContain('guard wire["exists"]?.boolValue == true else { continue }');
    expect(eventsSwift.indexOf('type: .childMoved')).toBeLessThan(
      eventsSwift.indexOf('type: .childChanged'),
    );
    expect(onDisconnectSwift).toContain('method: "rtdb.onDisconnectSet"');
    expect(onDisconnectSwift).toContain('method: "rtdb.onDisconnectUpdate"');
    expect(onDisconnectSwift).toContain('method: "rtdb.onDisconnectRemove"');
    expect(onDisconnectSwift).toContain('method: "rtdb.onDisconnectCancel"');

    expect(obs.infoConnectedToggleTrueFalseTrue).toBe(true);
    expect(obs.infoServerTimeOffsetIsNSNumber).toBe(true);
    expect(obs.infoUnknownKeyKey).toBe('nonexistent_key');
    expect(obs.infoUnknownKeyFiredValueEvent).toBe(false);

    const runId = 'replay_ios_rtdb_live_1';
    const observerSession = 'ios-rtdb-observer';
    const writerSession = 'ios-rtdb-writer';
    const bridge = await openTwoAppSwiftRtdbBridge(
      `demo-ios-rtdb-live-${Date.now()}`,
      runId,
      'ios-rtdb-live-uid',
    );

    try {
      const { actAs } = bridge;
      const runPath = `pyric_oracle/${runId}`;
      const watchPath = `${runPath}/watched_scores`;

      const setAs = (session: string, path: string, value: unknown) =>
        bridge.sendOpAsSession(session, {
          method: 'rtdb.set',
          instance: DEDICATED_INSTANCE,
          path,
          value,
          actAs,
        });
      const getAs = (session: string, path: string, extra?: Record<string, unknown>) => {
        const op: Record<string, unknown> = {
          method: 'rtdb.get',
          instance: DEDICATED_INSTANCE,
          path,
          actAs,
        };
        if (extra !== undefined) {
          Object.assign(op, extra);
        }
        return bridge.sendOpAsSession(session, op).then(extractRtdbSnap);
      };

      await setAs(observerSession, watchPath, { a: 1, b: 2 });

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
          'rsub-ios-val',
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
          'rsub-ios-child',
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
            const current = snap.entries.map((entry) => ({ key: entry.key, value: entry.value }));
            const prevKeyByChild = new Map<string, string>();
            let runningPrev = 'nil';
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
              const currentByKey = new Map(current.map((entry) => [entry.key, entry]));
              const prevByKey = new Map(prevEntries.map((entry) => [entry.key, entry]));
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

        await waitWatch(() => valueCounts.length >= 1 && childTimelineEvents.length >= 2, 'init');
        await setAs(observerSession, `${watchPath}/c`, 3);
        await waitWatch(() => childTimelineEvents.includes('added:c:prev=b'), 'added-c');

        await setAs(observerSession, `${watchPath}/a`, 10);
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
        expect(valueCounts.length >= 4).toBe(obs.valueListenerObservedMutations);
        expect(childTimelineEvents).toEqual(obs.childTimeline);

        bridge.unsubscribeAsSession(observerSession, 'rsub-ios-val');
        bridge.unsubscribeAsSession(observerSession, 'rsub-ios-child');
        const valCountAtUnsub = valueCounts.length;
        const childCountAtUnsub = childTimelineEvents.length;

        await setAs(observerSession, `${watchPath}/d`, 4);
        const fenceSingleSnap = await getAs(observerSession, watchPath);
        expect(fenceSingleSnap.size).toBe(obs.observeSingleCountAfterUnsub);
        const quiet =
          valueCounts.length === valCountAtUnsub &&
          childTimelineEvents.length === childCountAtUnsub;
        expect(quiet).toBe(obs.silentAfterRemoveObserver);
      } finally {
        for (const timer of waitTimers) {
          clearTimeout(timer);
        }
        waitTimers.clear();
        notifyWatch = null;
        bridge.unsubscribeAsSession(observerSession, 'rsub-ios-val');
        bridge.unsubscribeAsSession(observerSession, 'rsub-ios-child');
      }

      const txPath = `${runPath}/tx_counter`;
      await setAs(observerSession, txPath, 10);

      const txRead = await getAs(observerSession, txPath, { transaction: true });
      const txCommitRes = await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.transactionCommit',
        instance: DEDICATED_INSTANCE,
        path: txPath,
        expected: txRead.value,
        value: Number(txRead.value) + 7,
        applyLocally: true,
        actAs,
      });
      expect(txCommitRes.ok).toBe(true);
      const txCommitWire = txCommitRes.value as { committed: boolean; snapshot: RtdbWireSnap };
      expect(txCommitWire.committed).toBe(obs.txCommitCommitted);
      expect(txCommitWire.snapshot.value).toBe(obs.txCommitFinalValue);

      expect(obs.txAbortCommitted).toBe(false);
      const txAfterAbort = await getAs(observerSession, txPath);
      expect(txAfterAbort.value).toBe(obs.txServerValueAfterAbort);

      const presencePath = `${runPath}/presence`;
      await setAs(observerSession, `${presencePath}/status`, 'online');
      await setAs(observerSession, `${presencePath}/meta`, { state: 'active', keep: 1 });
      await setAs(observerSession, `${presencePath}/ephemeral_session`, 'active-ephemeral');
      await setAs(observerSession, `${presencePath}/kept_after_cancel`, 'kept-alive');

      await bridge.sendOpAsSession(writerSession, {
        method: 'rtdb.onDisconnectSet',
        instance: DEDICATED_INSTANCE,
        path: `${presencePath}/status`,
        value: 'offline-by-ondisconnect',
        actAs,
      });
      await bridge.sendOpAsSession(writerSession, {
        method: 'rtdb.onDisconnectUpdate',
        instance: DEDICATED_INSTANCE,
        path: `${presencePath}/meta`,
        values: { state: 'ended' },
        actAs,
      });
      await bridge.sendOpAsSession(writerSession, {
        method: 'rtdb.onDisconnectRemove',
        instance: DEDICATED_INSTANCE,
        path: `${presencePath}/ephemeral_session`,
        actAs,
      });
      await bridge.sendOpAsSession(writerSession, {
        method: 'rtdb.onDisconnectSet',
        instance: DEDICATED_INSTANCE,
        path: `${presencePath}/kept_after_cancel`,
        value: 'must-not-run',
        actAs,
      });
      await bridge.sendOpAsSession(writerSession, {
        method: 'rtdb.onDisconnectCancel',
        instance: DEDICATED_INSTANCE,
        path: `${presencePath}/kept_after_cancel`,
        actAs,
      });

      const goOfflineRes = await bridge.sendOpAsSession(writerSession, {
        method: 'rtdb.goOffline',
        instance: DEDICATED_INSTANCE,
        actAs,
      });
      expect(goOfflineRes.ok).toBe(true);

      const statusAfter = await getAs(observerSession, `${presencePath}/status`);
      const metaAfter = await getAs(observerSession, `${presencePath}/meta`);
      const ephemeralAfter = await getAs(observerSession, `${presencePath}/ephemeral_session`);
      const canceledAfter = await getAs(observerSession, `${presencePath}/kept_after_cancel`);

      const metaMap = metaAfter.value as Record<string, unknown>;
      expect(statusAfter.value).toBe(obs.onDisconnect.statusAfterDisconnect);
      expect(metaMap.state).toBe(obs.onDisconnect.metaStateAfterDisconnect);
      expect(metaMap.keep).toBe(obs.onDisconnect.metaKeepPreservedAfterDisconnect);
      expect(ephemeralAfter.exists).toBe(obs.onDisconnect.ephemeralExistsAfterDisconnect);
      expect(canceledAfter.value).toBe(obs.onDisconnect.canceledPathValueAfterDisconnect);

      await bridge.sendOpAsSession(observerSession, {
        method: 'rtdb.remove',
        instance: DEDICATED_INSTANCE,
        path: runPath,
        actAs,
      });
      const removedRunSnap = await getAs(observerSession, runPath);
      expect(!removedRunSnap.exists).toBe(obs.cleanupRemovedRunNode);
    } finally {
      await bridge.close();
    }
  });

  test('covers rtdb-swift-listeners-transactions-connection-and-ondisconnect through createObservationGate', () => {
    const report = gate.report();
    expect(report.committed).toEqual([
      'rtdb-swift-listeners-transactions-connection-and-ondisconnect',
    ]);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
