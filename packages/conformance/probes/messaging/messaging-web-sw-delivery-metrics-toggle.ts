import type { Probe } from '../../rigs/types.ts';
import {
  captureSyncThrow,
  withSyntheticMessagingBrowserEnv,
} from '../../src/messaging-web-probe-env.ts';

export interface MessagingSwDeliveryMetricsToggleBehavior {
  enableReturnsUndefined: boolean;
  disableReturnsUndefined: boolean;
  deliveredStepsAcrossToggleStates: string[];
  nullMessagingThrowsSynchronously: boolean;
}

const VALID_FCM_OPTIONS = {
  projectId: 'demo-fcm-project',
  apiKey: 'demo-fcm-api-key',
  appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4',
  messagingSenderId: '123456789012',
};

export async function observeMessagingSwDeliveryMetricsToggle(): Promise<MessagingSwDeliveryMetricsToggleBehavior> {
  const [appSdk, swMod] = await Promise.all([
    import('firebase/app'),
    import('firebase/messaging/sw'),
  ]);

  return withSyntheticMessagingBrowserEnv(async (env) => {
    const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const app = appSdk.initializeApp(VALID_FCM_OPTIONS, `fcm-sw-metrics-${runSuffix}`);

    try {
      const swMessaging = swMod.getMessaging(app);
      const deliveredStepsAcrossToggleStates: string[] = [];
      const unsub = swMod.onBackgroundMessage(swMessaging, (payload) => {
        if (payload.data?.phase !== undefined) {
          deliveredStepsAcrossToggleStates.push(payload.data.phase);
        }
      });

      let enableResult: unknown;
      let disableResult: unknown;
      try {
        enableResult = swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
          swMessaging,
          true,
        );
        await env.dispatchSwPush({
          from: '123456789012',
          fcmMessageId: 'metrics-on-1',
          collapseKey: 'metrics-ck',
          data: { phase: 'enabled' },
        });

        disableResult = swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
          swMessaging,
          false,
        );
        await env.dispatchSwPush({
          from: '123456789012',
          fcmMessageId: 'metrics-off-1',
          collapseKey: 'metrics-ck',
          data: { phase: 'disabled' },
        });
      } finally {
        swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(swMessaging, false);
        unsub();
      }

      const nullOutcome = captureSyncThrow(() =>
        swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
          null as unknown as Parameters<
            typeof swMod.experimentalSetDeliveryMetricsExportedToBigQueryEnabled
          >[0],
          true,
        ),
      );

      return {
        enableReturnsUndefined: enableResult === undefined,
        disableReturnsUndefined: disableResult === undefined,
        deliveredStepsAcrossToggleStates,
        nullMessagingThrowsSynchronously: nullOutcome.threw,
      };
    } finally {
      await appSdk.deleteApp(app).catch(() => undefined);
    }
  });
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config'],
  matrixRow: 'messaging#15',
  rowIds: ['messaging#15'],
  description:
    'firebase/messaging/sw experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable) runtime toggle return contract, preservation of onBackgroundMessage delivery across enabled and disabled states, and synchronous rejection of null handles.',
  async observe() {
    const observed = await observeMessagingSwDeliveryMetricsToggle();
    return { ...observed };
  },
};
