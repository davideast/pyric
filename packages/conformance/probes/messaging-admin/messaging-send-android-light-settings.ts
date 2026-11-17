import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface AndroidLightSettingsSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeAndroidLightSettings(
  subject: AndroidLightSettingsSubject,
): Promise<{
  acceptedHex6: AcceptedSendPairOutcome;
  acceptedHex8: AcceptedSendPairOutcome;
  negativeLightOnDuration: CapturedMessagingCallOutcome;
  malformedColorShortHex: CapturedMessagingCallOutcome;
}> {
  const acceptedHex6 = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    android: {
      notification: {
        title: 'LED 6',
        lightSettings: {
          color: '#AABBCC',
          lightOnDurationMillis: 200,
          lightOffDurationMillis: 400,
        },
      },
    },
  });

  const acceptedHex8 = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    android: {
      notification: {
        title: 'LED 8',
        lightSettings: {
          color: '#AABBCC80',
          lightOnDurationMillis: 150,
          lightOffDurationMillis: 300,
        },
      },
    },
  });

  const negativeLightOnDuration = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: {
          notification: {
            lightSettings: {
              color: '#AABBCC',
              lightOnDurationMillis: -1,
              lightOffDurationMillis: 400,
            },
          },
        },
      },
      true,
    ),
  );

  const malformedColorShortHex = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: {
          notification: {
            lightSettings: {
              color: '#123',
              lightOnDurationMillis: 200,
              lightOffDurationMillis: 400,
            },
          },
        },
      },
      true,
    ),
  );

  return {
    acceptedHex6,
    acceptedHex8,
    negativeLightOnDuration,
    malformedColorShortHex,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging LightSettings: FCM accepts #RRGGBB and #RRGGBBAA LED colors with millisecond on/off durations, while negative durations or malformed hex colors fail client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeAndroidLightSettings({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
