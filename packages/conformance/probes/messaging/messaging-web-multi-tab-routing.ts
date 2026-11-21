import type { Probe } from '../../rigs/types.ts';
import { withMultiTabMessagingBrowserEnv } from '../../src/messaging-multi-tab-probe-env.ts';

export interface MultiTabDeliveryCaseOutcome {
  tabACount: number;
  tabBCount: number;
  swBackgroundCount: number;
  tabADataStep: string | null;
  tabBDataStep: string | null;
  swDataStep: string | null;
}

export interface MessagingMultiTabDeliveryRouting {
  bothTabsVisible: MultiTabDeliveryCaseOutcome;
  oneVisibleOneHidden: MultiTabDeliveryCaseOutcome;
  allTabsHidden: MultiTabDeliveryCaseOutcome;
}

export interface MessagingMultiTabSwNativeBehavior {
  showNotificationCounts: {
    bothTabsVisible: number;
    oneVisibleOneHidden: number;
    allTabsHidden: number;
  };
  chromeExtensionVisibleIgnoredWhenAppTabsHidden: boolean;
  notificationClickExistingTabs: {
    notificationClosed: boolean;
    tabAFocusCount: number;
    tabBFocusCount: number;
    openWindowCount: number;
    tabAReceivedNotificationClickedMessage: boolean;
    tabBReceivedNotificationClickedMessage: boolean;
    tabAOnMessageCountAfterClick: number;
    tabBOnMessageCountAfterClick: number;
  };
}

export interface MessagingMultiTabRoutingBehavior {
  deliveryRouting: MessagingMultiTabDeliveryRouting;
  swNativeIntegration: MessagingMultiTabSwNativeBehavior;
}

const VALID_FCM_OPTIONS = {
  projectId: 'demo-fcm-project',
  apiKey: 'demo-fcm-api-key',
  appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  messagingSenderId: '123456789012',
};

function lastDataStep(payloads: ReadonlyArray<{ data?: Record<string, string> }>): string | null {
  const latest = payloads[payloads.length - 1];
  if (latest?.data?.step !== undefined) {
    return latest.data.step;
  }
  return null;
}

export async function observeMessagingMultiTabRouting(): Promise<MessagingMultiTabRoutingBehavior> {
  const [appSdk, clientMod, swMod] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging'),
    import('firebase/messaging/sw'),
  ]);

  return withMultiTabMessagingBrowserEnv(async (env) => {
    const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tabAApp = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-tab-a-${runSuffix}`);
    const tabBApp = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-tab-b-${runSuffix}`);
    const swApp = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-sw-shared-${runSuffix}`);

    const tabA = env.createWindowTab('tab-a', '/items/1', 'visible');
    const tabB = env.createWindowTab('tab-b', '/items/2', 'visible');

    const tabAPayloads: Array<{ data?: Record<string, string> }> = [];
    const tabBPayloads: Array<{ data?: Record<string, string> }> = [];
    const swPayloads: Array<{ data?: Record<string, string> }> = [];

    let unsubTabA: (() => void) | null = null;
    let unsubTabB: (() => void) | null = null;
    let unsubSw: (() => void) | null = null;

    try {
      const tabAMessaging = tabA.bindWindowContext(() => clientMod.getMessaging(tabAApp));
      const tabBMessaging = tabB.bindWindowContext(() => clientMod.getMessaging(tabBApp));
      const swMessaging = swMod.getMessaging(swApp);

      unsubTabA = clientMod.onMessage(tabAMessaging, (payload) => {
        tabAPayloads.push(payload);
      });
      unsubTabB = clientMod.onMessage(tabBMessaging, (payload) => {
        tabBPayloads.push(payload);
      });
      unsubSw = swMod.onBackgroundMessage(swMessaging, (payload) => {
        swPayloads.push(payload);
      });

      // 1. Both tabs visible: foreground fan-out reaches both tabs, SW stays silent.
      tabA.setVisibility('visible');
      tabB.setVisibility('visible');
      await env.dispatchSwPush({
        from: '123456789012',
        fcmMessageId: 'mt-both-visible-1',
        collapseKey: 'mt-ck',
        notification: { title: 'Notice', body: 'Two visible tabs' },
        data: { step: 'both-visible' },
      });
      const showAfterBothVisible = env.showNotificationCount();
      const bothTabsVisible: MultiTabDeliveryCaseOutcome = {
        tabACount: tabAPayloads.length,
        tabBCount: tabBPayloads.length,
        swBackgroundCount: swPayloads.length,
        tabADataStep: lastDataStep(tabAPayloads),
        tabBDataStep: lastDataStep(tabBPayloads),
        swDataStep: lastDataStep(swPayloads),
      };

      // 2. One tab visible, one tab hidden: SW posts push-received to every matched
      // same-origin window client when hasVisibleClients(clientList) is true.
      tabAPayloads.length = 0;
      tabBPayloads.length = 0;
      swPayloads.length = 0;
      tabA.setVisibility('visible');
      tabB.setVisibility('hidden');
      await env.dispatchSwPush({
        from: '123456789012',
        fcmMessageId: 'mt-one-visible-1',
        collapseKey: 'mt-ck',
        notification: { title: 'Notice', body: 'Mixed visibility tabs' },
        data: { step: 'one-visible' },
      });
      const showAfterOneVisible = env.showNotificationCount() - showAfterBothVisible;
      const oneVisibleOneHidden: MultiTabDeliveryCaseOutcome = {
        tabACount: tabAPayloads.length,
        tabBCount: tabBPayloads.length,
        swBackgroundCount: swPayloads.length,
        tabADataStep: lastDataStep(tabAPayloads),
        tabBDataStep: lastDataStep(tabBPayloads),
        swDataStep: lastDataStep(swPayloads),
      };

      // 3. All app tabs hidden (even with a visible chrome-extension:// client present):
      // shared SW fires onBackgroundMessage once, and neither tab fires onMessage.
      tabAPayloads.length = 0;
      tabBPayloads.length = 0;
      swPayloads.length = 0;
      tabA.setVisibility('hidden');
      tabB.setVisibility('hidden');
      env.setChromeExtensionVisibleClient(true);
      const showBeforeHidden = env.showNotificationCount();
      await env.dispatchSwPush({
        from: '123456789012',
        fcmMessageId: 'mt-all-hidden-1',
        collapseKey: 'mt-ck',
        notification: { title: 'Notice', body: 'All tabs hidden' },
        data: { step: 'all-hidden' },
      });
      env.setChromeExtensionVisibleClient(false);
      const showAfterAllHidden = env.showNotificationCount() - showBeforeHidden;
      const allTabsHidden: MultiTabDeliveryCaseOutcome = {
        tabACount: tabAPayloads.length,
        tabBCount: tabBPayloads.length,
        swBackgroundCount: swPayloads.length,
        tabADataStep: lastDataStep(tabAPayloads),
        tabBDataStep: lastDataStep(tabBPayloads),
        swDataStep: lastDataStep(swPayloads),
      };

      // 4. Notification click when two same-origin tabs exist: closes notification,
      // focuses a single existing client rather than opening a duplicate window,
      // and posts notification-clicked (which does not re-fire onMessage).
      tabAPayloads.length = 0;
      tabBPayloads.length = 0;
      const clickResult = await env.dispatchSwNotificationClick({
        from: '123456789012',
        fcmMessageId: 'mt-click-1',
        collapseKey: 'mt-ck',
        notification: { title: 'Notice', body: 'Click target' },
        data: { step: 'clicked' },
        fcmOptions: { link: 'https://example.test/items/1' },
      });
      const tabAClickedMsg = tabA
        .receivedRawWindowMessages()
        .some((msg) => msg.messageType === 'notification-clicked');
      const tabBClickedMsg = tabB
        .receivedRawWindowMessages()
        .some((msg) => msg.messageType === 'notification-clicked');

      return {
        deliveryRouting: {
          bothTabsVisible,
          oneVisibleOneHidden,
          allTabsHidden,
        },
        swNativeIntegration: {
          showNotificationCounts: {
            bothTabsVisible: showAfterBothVisible,
            oneVisibleOneHidden: showAfterOneVisible,
            allTabsHidden: showAfterAllHidden,
          },
          chromeExtensionVisibleIgnoredWhenAppTabsHidden:
            allTabsHidden.swBackgroundCount === 1 &&
            allTabsHidden.tabACount === 0 &&
            allTabsHidden.tabBCount === 0,
          notificationClickExistingTabs: {
            notificationClosed: clickResult.notificationClosed,
            tabAFocusCount: tabA.focusCount(),
            tabBFocusCount: tabB.focusCount(),
            openWindowCount: clickResult.openWindowUrls.length,
            tabAReceivedNotificationClickedMessage: tabAClickedMsg,
            tabBReceivedNotificationClickedMessage: tabBClickedMsg,
            tabAOnMessageCountAfterClick: tabAPayloads.length,
            tabBOnMessageCountAfterClick: tabBPayloads.length,
          },
        },
      };
    } finally {
      unsubTabA?.();
      unsubTabB?.();
      unsubSw?.();
      await appSdk.deleteApp(tabAApp).catch(() => undefined);
      await appSdk.deleteApp(tabBApp).catch(() => undefined);
      await appSdk.deleteApp(swApp).catch(() => undefined);
    }
  });
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase/messaging and firebase/messaging/sw multi-tab delivery routing across shared ServiceWorkerRegistration window clients ([visible, visible], [visible, hidden], [hidden, hidden] with chrome-extension exclusion) and notificationclick single-client focus.',
  async observe() {
    const observed = await observeMessagingMultiTabRouting();
    return { ...observed };
  },
};
