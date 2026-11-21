import { describe, expect, test } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { getMessaging, onMessage } from 'pyric/messaging';
import { getMessagingBroker } from 'pyric/messaging/internal';
import {
  getMessaging as getMessagingInSw,
  onBackgroundMessage,
} from 'pyric/messaging/sw';
import { initializeSandbox } from 'pyric/sandbox';
import {
  observeMessagingMultiTabRouting,
  probe as multiTabRoutingProbe,
} from '../../probes/messaging/messaging-web-multi-tab-routing.ts';
import { replayMessagingMultiTabRouting } from '../../src/messaging-multi-tab-replay.ts';
import {
  loadModularProbes,
  printModularProbePreview,
  selectModularProbes,
} from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const PROBE_ID = 'messaging-web-multi-tab-routing';

describe('staged messaging multi-tab routing probe (sdk-probes)', () => {
  test('registers messaging-web-multi-tab-routing under sdk-probes with pendingRowLink', async () => {
    const loaded = await loadModularProbes('sdk-probes');
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(multiTabRoutingProbe.rig).toBe('sdk-probes');
    expect(multiTabRoutingProbe.requires).toEqual(['web-config']);
    expect(multiTabRoutingProbe.pendingRowLink).toBe(true);
    expect(multiTabRoutingProbe.matrixRow).toBe('');
    expect(multiTabRoutingProbe.rowIds).toEqual([]);
    expect(multiTabRoutingProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(
      selectModularProbes(loaded, [], 'sdk-probes', {
        includeUncapturedStaged: false,
      }).map((entry) => entry.id),
    );

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

    const lines: string[] = [];
    printModularProbePreview({
      rig: 'sdk-probes',
      scriptPath: 'packages/conformance/src/sdk-probes.ts',
      probes: loaded,
      log: (line) => lines.push(line),
    });
    expect(
      lines.some(
        (line) =>
          line.includes(PROBE_ID) &&
          line.includes('observations/messaging/messaging-web-multi-tab-routing.json') &&
          line.includes('[pendingRowLink]'),
      ),
    ).toBe(true);
  });

  test('produces deterministic multi-tab routing observations and matches in-page pyric/messaging + pyric/messaging/sw', async () => {
    const run1 = await observeMessagingMultiTabRouting();
    const run2 = await observeMessagingMultiTabRouting();
    expect(run1).toEqual(run2);

    expect(run1.deliveryRouting.bothTabsVisible).toEqual({
      tabACount: 1,
      tabBCount: 1,
      swBackgroundCount: 0,
      tabADataStep: 'both-visible',
      tabBDataStep: 'both-visible',
      swDataStep: null,
    });
    expect(run1.deliveryRouting.oneVisibleOneHidden).toEqual({
      tabACount: 1,
      tabBCount: 1,
      swBackgroundCount: 0,
      tabADataStep: 'one-visible',
      tabBDataStep: 'one-visible',
      swDataStep: null,
    });
    expect(run1.deliveryRouting.allTabsHidden).toEqual({
      tabACount: 0,
      tabBCount: 0,
      swBackgroundCount: 1,
      tabADataStep: null,
      tabBDataStep: null,
      swDataStep: 'all-hidden',
    });

    expect(run1.swNativeIntegration).toEqual({
      showNotificationCounts: {
        bothTabsVisible: 0,
        oneVisibleOneHidden: 0,
        allTabsHidden: 1,
      },
      chromeExtensionVisibleIgnoredWhenAppTabsHidden: true,
      notificationClickExistingTabs: {
        notificationClosed: true,
        tabAFocusCount: 1,
        tabBFocusCount: 0,
        openWindowCount: 0,
        tabAReceivedNotificationClickedMessage: true,
        tabBReceivedNotificationClickedMessage: false,
        tabAOnMessageCountAfterClick: 0,
        tabBOnMessageCountAfterClick: 0,
      },
    });

    const inPageActual = await replayMessagingMultiTabRouting(async () => {
      const sandbox = initializeSandbox();
      const tabAApp = createAppForSandbox(
        sandbox,
        { projectId: 'demo-fcm-project' },
        `inpage-mt-tab-a-${Date.now()}`,
      );
      const tabBApp = createAppForSandbox(
        sandbox,
        { projectId: 'demo-fcm-project' },
        `inpage-mt-tab-b-${Date.now()}`,
      );
      const swApp = createAppForSandbox(
        sandbox,
        { projectId: 'demo-fcm-project' },
        `inpage-mt-sw-${Date.now()}`,
      );
      const tabAMessaging = getMessaging(tabAApp);
      const tabBMessaging = getMessaging(tabBApp);
      const swMessaging = getMessagingInSw(swApp);
      const broker = getMessagingBroker(sandbox);

      return {
        onTabAMessage(listener) {
          return onMessage(tabAMessaging, listener);
        },
        onTabBMessage(listener) {
          return onMessage(tabBMessaging, listener);
        },
        onSwBackgroundMessage(listener) {
          return onBackgroundMessage(swMessaging, listener);
        },
        setTabVisibilities(tabAState, tabBState) {
          broker.setClientVisibility('tab-a', tabAState);
          broker.setClientVisibility('tab-b', tabBState);
        },
        async deliver(spec) {
          broker.deliver(spec);
        },
        async close() {
          await deleteApp(tabAApp).catch(() => undefined);
          await deleteApp(tabBApp).catch(() => undefined);
          await deleteApp(swApp).catch(() => undefined);
          sandbox.dispose();
        },
      };
    });

    expect(inPageActual).toEqual(run1.deliveryRouting);
  });
});
