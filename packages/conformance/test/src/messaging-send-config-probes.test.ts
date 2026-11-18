import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { describe, expect, test } from 'bun:test';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import {
  observeAndroidConfig,
  probe as androidConfigProbe,
} from '../../probes/messaging-admin/messaging-send-android-config.ts';
import {
  observeAndroidFcmOptions,
  probe as androidFcmOptionsProbe,
} from '../../probes/messaging-admin/messaging-send-android-fcm-options.ts';
import {
  observeAndroidLightSettings,
  probe as androidLightSettingsProbe,
} from '../../probes/messaging-admin/messaging-send-android-light-settings.ts';
import {
  observeAndroidNotification,
  probe as androidNotificationProbe,
} from '../../probes/messaging-admin/messaging-send-android-notification.ts';
import {
  observeApnsApsAlert,
  probe as apnsApsAlertProbe,
} from '../../probes/messaging-admin/messaging-send-apns-aps-alert.ts';
import {
  observeApnsApsFields,
  probe as apnsApsFieldsProbe,
} from '../../probes/messaging-admin/messaging-send-apns-aps-fields.ts';
import {
  observeApnsConfigAndHeaders,
  probe as apnsConfigAndHeadersProbe,
} from '../../probes/messaging-admin/messaging-send-apns-config-and-headers.ts';
import {
  observeApnsCriticalSound,
  probe as apnsCriticalSoundProbe,
} from '../../probes/messaging-admin/messaging-send-apns-critical-sound.ts';
import {
  observeApnsFcmOptions,
  probe as apnsFcmOptionsProbe,
} from '../../probes/messaging-admin/messaging-send-apns-fcm-options.ts';
import {
  observeApnsPayloadCustomData,
  probe as apnsPayloadCustomDataProbe,
} from '../../probes/messaging-admin/messaging-send-apns-payload-custom-data.ts';
import {
  observeFcmOptionsAnalyticsLabel,
  probe as fcmOptionsAnalyticsLabelProbe,
} from '../../probes/messaging-admin/messaging-send-fcm-options-analytics-label.ts';
import {
  observeWebpushNotificationOptions,
  probe as webpushNotificationOptionsProbe,
} from '../../probes/messaging-admin/messaging-send-webpush-notification-options.ts';

async function withFakeTransportSend(
  run: (sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>) => Promise<void>,
): Promise<void> {
  const tempApp: App = initializeApp(
    { projectId: 'demo-project' },
    `config-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const svc = getMessaging(tempApp);
    (
      svc as unknown as {
        messagingRequestHandler: {
          invokeRequestHandler: (
            host: string,
            path: string,
            req: { validate_only?: boolean; message: Record<string, unknown> },
          ) => Promise<{ name: string }>;
        };
      }
    ).messagingRequestHandler = {
      async invokeRequestHandler(_host, _path, req) {
        if (req.validate_only) {
          return { name: 'projects/demo-project/messages/-777' };
        }
        return { name: 'projects/demo-project/messages/888' };
      },
    };
    const sendClient = async (
      message: Record<string, unknown>,
      dryRun: boolean,
    ): Promise<string> => svc.send(message as unknown as Message, dryRun);
    await run(sendClient);
  } finally {
    await deleteApp(tempApp);
  }
}

describe('modular messaging-send config option probes (Slice 3 family)', () => {
  test('registers all twelve row-linked config-shape probes under rig messaging-send with populated rowIds', async () => {
    const modular = await loadModularProbes('messaging-send');
    const ids = modular.map((entry) => entry.id);
    const expectedConfigIds = [
      'messaging-send-android-config',
      'messaging-send-android-fcm-options',
      'messaging-send-android-light-settings',
      'messaging-send-android-notification',
      'messaging-send-apns-aps-alert',
      'messaging-send-apns-aps-fields',
      'messaging-send-apns-config-and-headers',
      'messaging-send-apns-critical-sound',
      'messaging-send-apns-fcm-options',
      'messaging-send-apns-payload-custom-data',
      'messaging-send-fcm-options-analytics-label',
      'messaging-send-webpush-notification-options',
    ];
    for (const id of expectedConfigIds) {
      expect(ids).toContain(id);
    }

    const probes = [
      androidConfigProbe,
      androidFcmOptionsProbe,
      androidLightSettingsProbe,
      androidNotificationProbe,
      apnsApsAlertProbe,
      apnsApsFieldsProbe,
      apnsConfigAndHeadersProbe,
      apnsCriticalSoundProbe,
      apnsFcmOptionsProbe,
      apnsPayloadCustomDataProbe,
      fcmOptionsAnalyticsLabelProbe,
      webpushNotificationOptionsProbe,
    ];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('messaging-send');
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow.length).toBeGreaterThan(0);
      expect(probeRecord.rowIds.length).toBeGreaterThan(0);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const pending = loadPendingRowLinkObservations();
    for (const id of expectedConfigIds) {
      expect(pending.has(id)).toBe(false);
    }
  });

  test('observes FcmOptions, WebpushNotification, and APNs config/payload/aps/alert/sound/fcmOptions validation and acceptance', async () => {
    await withFakeTransportSend(async (sendClient) => {
      const fcmOut = await observeFcmOptionsAnalyticsLabel({
        projectId: 'demo-project',
        sendClient,
        errorEnvelopeParity: async () => ({
          status: 400,
          error: { code: 400, status: 'INVALID_ARGUMENT' },
          realStatus: 400,
          realSendEnvelopeIdentical: true,
        }),
      });
      expect(fcmOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(fcmOut.nonStringAnalyticsLabel.code).toBe('messaging/invalid-payload');
      expect(fcmOut.wireOversizedLabel51.status).toBe(400);

      const webpushOut = await observeWebpushNotificationOptions({
        projectId: 'demo-project',
        sendClient,
      });
      expect(webpushOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(webpushOut.nonStringWebpushData.code).toBe('messaging/invalid-payload');

      const apnsCfgOut = await observeApnsConfigAndHeaders({
        projectId: 'demo-project',
        sendClient,
      });
      expect(apnsCfgOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(apnsCfgOut.emptyLiveActivityToken.code).toBe('messaging/invalid-payload');
      expect(apnsCfgOut.nonStringHeaderValue.code).toBe('messaging/invalid-payload');

      const apnsPayloadOut = await observeApnsPayloadCustomData({
        projectId: 'demo-project',
        sendClient,
      });
      expect(apnsPayloadOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(apnsPayloadOut.nonObjectPayload.code).toBe('messaging/invalid-payload');

      const apsOut = await observeApnsApsFields({
        projectId: 'demo-project',
        sendClient,
      });
      expect(apsOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(apsOut.duplicateContentAvailable.code).toBe('messaging/invalid-payload');

      const alertOut = await observeApnsApsAlert({
        projectId: 'demo-project',
        sendClient,
      });
      expect(alertOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(alertOut.locArgsWithoutLocKey.code).toBe('messaging/invalid-payload');
      expect(alertOut.titleLocArgsWithoutTitleLocKey.code).toBe('messaging/invalid-payload');
      expect(alertOut.subtitleLocArgsWithoutSubtitleLocKey.code).toBe('messaging/invalid-payload');

      const soundOut = await observeApnsCriticalSound({
        projectId: 'demo-project',
        sendClient,
      });
      expect(soundOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(soundOut.emptySoundName.code).toBe('messaging/invalid-payload');
      expect(soundOut.negativeVolume.code).toBe('messaging/invalid-payload');
      expect(soundOut.volumeAboveOne.code).toBe('messaging/invalid-payload');

      const apnsFcmOut = await observeApnsFcmOptions({
        projectId: 'demo-project',
        sendClient,
      });
      expect(apnsFcmOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(apnsFcmOut.invalidImageUrl.code).toBe('messaging/invalid-payload');
      expect(apnsFcmOut.duplicateImageAndImageUrl.code).toBe('messaging/invalid-payload');
    });
  });

  test('observes AndroidConfig, AndroidNotification, LightSettings, and AndroidFcmOptions validation and acceptance', async () => {
    await withFakeTransportSend(async (sendClient) => {
      const androidOut = await observeAndroidConfig({
        projectId: 'demo-project',
        sendClient,
      });
      expect(androidOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(androidOut.negativeTtl.code).toBe('messaging/invalid-payload');
      expect(androidOut.nonStringDataValue.code).toBe('messaging/invalid-payload');

      const notifOut = await observeAndroidNotification({
        projectId: 'demo-project',
        sendClient,
      });
      expect(notifOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(notifOut.malformedColor.code).toBe('messaging/invalid-payload');
      expect(notifOut.bodyLocArgsWithoutKey.code).toBe('messaging/invalid-payload');
      expect(notifOut.nonDateEventTimestamp.code).toBe('messaging/invalid-payload');

      const lightOut = await observeAndroidLightSettings({
        projectId: 'demo-project',
        sendClient,
      });
      expect(lightOut.acceptedHex6.dryRunSameShapeAsReal).toBe(true);
      expect(lightOut.acceptedHex8.dryRunSameShapeAsReal).toBe(true);
      expect(lightOut.negativeLightOnDuration.code).toBe('messaging/invalid-payload');
      expect(lightOut.malformedColorShortHex.code).toBe('messaging/invalid-payload');

      const androidFcmOut = await observeAndroidFcmOptions({
        projectId: 'demo-project',
        sendClient,
        errorEnvelopeParity: async () => ({
          status: 400,
          error: { code: 400, status: 'INVALID_ARGUMENT' },
          realStatus: 400,
          realSendEnvelopeIdentical: true,
        }),
      });
      expect(androidFcmOut.accepted.dryRunSameShapeAsReal).toBe(true);
      expect(androidFcmOut.nonStringAnalyticsLabel.code).toBe('messaging/invalid-payload');
      expect(androidFcmOut.wireOversizedLabel51.status).toBe(400);
    });
  });
});
