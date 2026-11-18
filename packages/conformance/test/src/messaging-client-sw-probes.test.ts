import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import {
  observeMessagingClientErrorCodes,
  probe as errorCodesProbe,
} from '../../probes/messaging/messaging-web-client-error-codes.ts';
import {
  observeMessagingModuleBoundaryAndAccessors,
  probe as moduleBoundaryProbe,
} from '../../probes/messaging/messaging-web-module-boundary-and-accessors.ts';
import {
  observeMessagingObserverAndUnsubscribe,
  probe as observerProbe,
} from '../../probes/messaging/messaging-web-observer-and-unsubscribe.ts';
import {
  observeMessagingSwDeliveryMetricsToggle,
  probe as swMetricsToggleProbe,
} from '../../probes/messaging/messaging-web-sw-delivery-metrics-toggle.ts';

const MESSAGING_CLIENT_SW_PROBE_IDS = [
  'messaging-web-client-error-codes',
  'messaging-web-module-boundary-and-accessors',
  'messaging-web-observer-and-unsubscribe',
  'messaging-web-sw-delivery-metrics-toggle',
] as const;

describe('linked messaging client and sw probes (sdk-probes)', () => {
  test('registers all 4 messaging probes under sdk-probes with linked rowIds and pendingRowLink dropped', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of MESSAGING_CLIENT_SW_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    expect(moduleBoundaryProbe.pendingRowLink).toBeUndefined();
    expect(moduleBoundaryProbe.matrixRow).toBe('messaging#1');
    expect(moduleBoundaryProbe.rowIds).toEqual(['messaging#1', 'messaging#13', 'messaging#17']);

    expect(observerProbe.pendingRowLink).toBeUndefined();
    expect(observerProbe.matrixRow).toBe('messaging#11');
    expect(observerProbe.rowIds).toEqual(['messaging#11']);

    expect(swMetricsToggleProbe.pendingRowLink).toBeUndefined();
    expect(swMetricsToggleProbe.matrixRow).toBe('messaging#15');
    expect(swMetricsToggleProbe.rowIds).toEqual(['messaging#15']);

    expect(errorCodesProbe.pendingRowLink).toBeUndefined();
    expect(errorCodesProbe.matrixRow).toBe('messaging#12');
    expect(errorCodesProbe.rowIds).toEqual(['messaging#12']);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );
    for (const id of MESSAGING_CLIENT_SW_PROBE_IDS) {
      expect(unfilteredIds.has(id)).toBe(true);
    }

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(
      lines.some((line) => line.includes('messaging-web-module-boundary-and-accessors')),
    ).toBe(true);
  });

  test('produces deterministic two-run observations across module boundaries, observers, SW metrics toggle, and error codes', async () => {
    const boundaryRun1 = await observeMessagingModuleBoundaryAndAccessors();
    const boundaryRun2 = await observeMessagingModuleBoundaryAndAccessors();
    expect(boundaryRun1).toEqual(boundaryRun2);
    expect(boundaryRun1.cachingAndPlaneSeparation.clientAndSwDistinctOnSameApp).toBe(true);
    expect(boundaryRun1.afterDeleteApp.priorClientInstanceReturnedAfterDelete).toBe(true);
    expect(boundaryRun1.afterDeleteApp.priorSwInstanceReturnedAfterDelete).toBe(true);
    expect(boundaryRun1.afterDeleteApp.firstClientGetMessagingAfterDelete.code).toBe(
      'app/app-deleted',
    );
    expect(boundaryRun1.afterDeleteApp.firstSwGetMessagingAfterDelete.code).toBe(
      'app/app-deleted',
    );

    const observerRun1 = await observeMessagingObserverAndUnsubscribe();
    const observerRun2 = await observeMessagingObserverAndUnsubscribe();
    expect(observerRun1).toEqual(observerRun2);
    expect(observerRun1.foregroundOnMessage.nextFn.countAfterUnsubscribeAndRedeliver).toBe(1);
    expect(observerRun1.foregroundOnMessage.observer.countAfterUnsubscribeAndRedeliver).toBe(1);
    expect(
      observerRun1.backgroundOnBackgroundMessage.nextFn.countAfterUnsubscribeAndRedeliver,
    ).toBe(1);
    expect(
      observerRun1.backgroundOnBackgroundMessage.observer.countAfterUnsubscribeAndRedeliver,
    ).toBe(1);

    const toggleRun1 = await observeMessagingSwDeliveryMetricsToggle();
    const toggleRun2 = await observeMessagingSwDeliveryMetricsToggle();
    expect(toggleRun1).toEqual(toggleRun2);
    expect(toggleRun1.deliveredStepsAcrossToggleStates).toEqual(['enabled', 'disabled']);
    expect(toggleRun1.nullMessagingThrowsSynchronously).toBe(true);

    const errorsRun1 = await observeMessagingClientErrorCodes();
    const errorsRun2 = await observeMessagingClientErrorCodes();
    expect(errorsRun1).toEqual(errorsRun2);
    expect(errorsRun1.permissionDeniedGetToken.code).toBe('messaging/permission-blocked');
    expect(errorsRun1.primitiveSwRegistrationGetToken.code).toBe(
      'messaging/invalid-sw-registration',
    );
    expect(errorsRun1.malformedObjectSwRegistrationGetToken.code).toBe(
      'messaging/invalid-sw-registration',
    );
  });
});
