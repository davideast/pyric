import { describe, expect, test } from 'bun:test';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';
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

describe('staged messaging client and sw probes (sdk-probes)', () => {
  test('registers all 4 messaging probes under sdk-probes with pendingRowLink and empty rowIds', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    for (const id of MESSAGING_CLIENT_SW_PROBE_IDS) {
      expect(loadedIds).toContain(id);
    }

    const probes = [
      errorCodesProbe,
      moduleBoundaryProbe,
      observerProbe,
      swMetricsToggleProbe,
    ];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('sdk-probes');
      expect(probeRecord.requires).toEqual(['web-config']);
      expect(probeRecord.pendingRowLink).toBe(true);
      expect(probeRecord.matrixRow).toBe('');
      expect(probeRecord.rowIds).toEqual([]);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

    expectStagedUntilCaptured(MESSAGING_CLIENT_SW_PROBE_IDS, {
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
    expect(boundaryRun1.clientExports.hasGetToken).toBe(true);
    expect(boundaryRun1.clientExports.hasOnBackgroundMessage).toBe(false);
    expect(boundaryRun1.swExports.hasOnBackgroundMessage).toBe(true);
    expect(boundaryRun1.swExports.hasGetToken).toBe(false);
    expect(boundaryRun1.noDefaultApp.clientGetMessaging.code).toBe('app/no-app');
    expect(boundaryRun1.noDefaultApp.swGetMessaging.code).toBe('app/no-app');
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
    expect(observerRun1.foregroundOnMessage.nextFn.countBeforeUnsubscribe).toBe(1);
    expect(observerRun1.foregroundOnMessage.nextFn.countAfterUnsubscribeAndRedeliver).toBe(1);
    expect(observerRun1.foregroundOnMessage.observer.countBeforeUnsubscribe).toBe(1);
    expect(observerRun1.foregroundOnMessage.observer.countAfterUnsubscribeAndRedeliver).toBe(1);
    expect(observerRun1.backgroundOnBackgroundMessage.nextFn.countBeforeUnsubscribe).toBe(1);
    expect(
      observerRun1.backgroundOnBackgroundMessage.nextFn.countAfterUnsubscribeAndRedeliver,
    ).toBe(1);
    expect(observerRun1.backgroundOnBackgroundMessage.observer.countBeforeUnsubscribe).toBe(1);
    expect(
      observerRun1.backgroundOnBackgroundMessage.observer.countAfterUnsubscribeAndRedeliver,
    ).toBe(1);

    const toggleRun1 = await observeMessagingSwDeliveryMetricsToggle();
    const toggleRun2 = await observeMessagingSwDeliveryMetricsToggle();
    expect(toggleRun1).toEqual(toggleRun2);
    expect(toggleRun1.enableReturnsUndefined).toBe(true);
    expect(toggleRun1.disableReturnsUndefined).toBe(true);
    expect(toggleRun1.deliveredStepsAcrossToggleStates).toEqual(['enabled', 'disabled']);
    expect(toggleRun1.nullMessagingThrowsSynchronously).toBe(true);

    const errorsRun1 = await observeMessagingClientErrorCodes();
    const errorsRun2 = await observeMessagingClientErrorCodes();
    expect(errorsRun1).toEqual(errorsRun2);
    expect(errorsRun1.hasClientErrorCodeExport).toBe(false);
    expect(errorsRun1.hasSwErrorCodeExport).toBe(false);
    expect(errorsRun1.permissionDeniedGetToken.code).toBe('messaging/permission-blocked');
    expect(errorsRun1.primitiveSwRegistrationGetToken.code).toBe(
      'messaging/invalid-sw-registration',
    );
    expect(errorsRun1.malformedObjectSwRegistrationGetToken.code).toBe(
      'messaging/invalid-sw-registration',
    );
  });
});
