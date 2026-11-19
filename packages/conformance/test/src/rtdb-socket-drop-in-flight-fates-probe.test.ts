import { describe, expect, test } from 'bun:test';
import {
  observeSocketDropInFlightFates,
  probe as socketDropProbe,
  type CapturedInFlightOnDisconnectFates,
  type CapturedInFlightTransactionFate,
  type CapturedPushKeyStability,
  type CapturedRestoredWireFrameShape,
  type CapturedWireFrameShape,
  type SocketDropInFlightFatesObservation,
} from '../../probes/rtdb-modular/rtdb-modular-socket-drop-in-flight-fates.ts';
import { auditProbeSessionAuthModes } from '../../src/sdk-probe-runtime.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const PROBE_ID = 'rtdb-modular-socket-drop-in-flight-fates';

describe('rtdb-modular-socket-drop-in-flight-fates staged probe (sdk-probes)', () => {
  test('registers on sdk-probes with requires: [] and passes staged capture + authMode audits', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const byId = new Map(loaded.map((entry) => [entry.id, entry]));

    expect(byId.get(PROBE_ID)?.surfaceDir).toBe('rtdb-modular');
    expect(socketDropProbe.rig).toBe('sdk-probes');
    expect(socketDropProbe.requires).toEqual([]);
    expect(socketDropProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    if (socketDropProbe.rowIds.length === 0) {
      expect(socketDropProbe.pendingRowLink).toBe(true);
      expect(socketDropProbe.matrixRow).toBe('');
      expectStagedUntilCaptured(PROBE_ID, {
        rig: 'sdk-probes',
        filterFlag: '--probe',
        filterValueFor: (name) => name,
        whenUncaptured(name) {
          expect(unfilteredIds.has(name)).toBe(false);
        },
        whenCaptured(name) {
          expect(unfilteredIds.has(name)).toBe(true);
        },
      });
    } else {
      expect(socketDropProbe.pendingRowLink).toBeUndefined();
      expect(unfilteredIds.has(PROBE_ID)).toBe(true);
    }

    const previewLines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => previewLines.push(line),
    });
    expect(previewLines.some((line) => line.includes(PROBE_ID))).toBe(true);
    expect(auditProbeSessionAuthModes()).toEqual([]);
  });

  test('executes deterministically across repeated runs with zero volatile fields', async () => {
    const run1 = (await socketDropProbe.observe()) as unknown as SocketDropInFlightFatesObservation;
    const run2 = await observeSocketDropInFlightFates();

    expect(run1).toEqual(run2);

    const expectedSentBeforeDrop: CapturedWireFrameShape[] = [
      { action: 'q', pathPattern: '/watched/node', conditionalHash: true },
      { action: 'p', pathPattern: '/inflight/set', conditionalHash: false },
      { action: 'm', pathPattern: '/inflight/update', conditionalHash: false },
      { action: 'p', pathPattern: '/inflight/remove', conditionalHash: false },
      { action: 'p', pathPattern: '/inflight/prio/.priority', conditionalHash: false },
      { action: 'p', pathPattern: '/inflight/withPrio', conditionalHash: false },
      { action: 'p', pathPattern: '/inflight/push/<pushKey>', conditionalHash: false },
      { action: 'g', pathPattern: '/inflight/get', conditionalHash: false },
      { action: 'o', pathPattern: '/inflight/onDiscSet', conditionalHash: false },
      { action: 'o', pathPattern: '/inflight/onDiscWithPrio', conditionalHash: false },
      { action: 'om', pathPattern: '/inflight/onDiscUpdate', conditionalHash: false },
      { action: 'o', pathPattern: '/inflight/onDiscRemove', conditionalHash: false },
      { action: 'oc', pathPattern: '/inflight/onDiscCancel', conditionalHash: false },
      { action: 'q', pathPattern: '/tx/item', conditionalHash: true },
      { action: 'p', pathPattern: '/tx/item', conditionalHash: true },
    ];

    const expectedRestoredOnReconnect: CapturedRestoredWireFrameShape[] = [
      {
        action: 'q',
        pathPattern: '/watched/node',
        conditionalHash: true,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'p',
        pathPattern: '/inflight/set',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'm',
        pathPattern: '/inflight/update',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'p',
        pathPattern: '/inflight/remove',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'p',
        pathPattern: '/inflight/prio/.priority',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'p',
        pathPattern: '/inflight/withPrio',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'p',
        pathPattern: '/inflight/push/<pushKey>',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'p',
        pathPattern: '/queued/setWhileDown',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'o',
        pathPattern: '/queued/onDiscWhileDown',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
      {
        action: 'g',
        pathPattern: '/inflight/get',
        conditionalHash: false,
        newRequestIdGreaterThanMaxBeforeDrop: true,
      },
    ];

    const expectedPushStability: CapturedPushKeyStability = {
      keyLength: 20,
      matchesPushCharset: true,
      resentIdenticalKey: true,
    };

    const expectedOnDisconnectFates: CapturedInFlightOnDisconnectFates = {
      setResent: false,
      setSettled: false,
      setWithPriorityResent: false,
      setWithPrioritySettled: false,
      updateResent: false,
      updateSettled: false,
      removeResent: false,
      removeSettled: false,
      cancelResent: false,
      cancelSettled: false,
    };

    const expectedTxFate: CapturedInFlightTransactionFate = {
      commitResent: false,
      settledBeforeReconnectHandshake: true,
      outcome: 'rejected',
      errorName: 'Error',
      errorMessage: 'disconnect',
      hasCode: false,
    };

    expect(run1.combinedRestoreWave).toEqual({
      sentBeforeDrop: expectedSentBeforeDrop,
      restoredOnReconnect: expectedRestoredOnReconnect,
      pushKeyStability: expectedPushStability,
      staleWriteReplyToOldRequestIdIgnored: true,
      staleGetReplyToOldRequestIdIgnored: true,
      settledAfterReconnectReplies: {
        setResolved: true,
        updateResolved: true,
        removeResolved: true,
        setPriorityResolved: true,
        setWithPriorityResolved: true,
        pushResolved: true,
        getResolvedValue: { fetched: 42 },
        queuedWhileDisconnectedSetResolved: true,
        queuedWhileDisconnectedOnDisconnectResolved: true,
      },
      inFlightOnDisconnectFates: expectedOnDisconnectFates,
      inFlightTransactionFate: expectedTxFate,
    });

    const serialized = JSON.stringify(run1);
    expect(serialized).not.toContain('socket-drop-fates-');
    expect(serialized).not.toContain('127.0.0.1');
  });
});
