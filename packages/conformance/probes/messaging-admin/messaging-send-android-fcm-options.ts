import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  type ErrorEnvelopeParityOutcome,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface AndroidFcmOptionsSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
  errorEnvelopeParity: (message: Record<string, unknown>) => Promise<ErrorEnvelopeParityOutcome>;
}

export async function observeAndroidFcmOptions(
  subject: AndroidFcmOptionsSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  nonStringAnalyticsLabel: CapturedMessagingCallOutcome;
  wireOversizedLabel51: ErrorEnvelopeParityOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    android: {
      fcmOptions: { analyticsLabel: 'android_promo' },
    },
  });

  const nonStringAnalyticsLabel = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: {
          fcmOptions: { analyticsLabel: 42 },
        },
      },
      true,
    ),
  );

  const wireOversizedLabel51 = await subject.errorEnvelopeParity({
    topic: 'pyric-oracle-messaging-probe',
    android: {
      fcm_options: { analytics_label: 'a'.repeat(51) },
    },
  });

  return {
    accepted,
    nonStringAnalyticsLabel,
    wireOversizedLabel51,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "interface AndroidFcmOptions { analyticsLabel? }",
  rowIds: ['messaging-admin#30'],
  description:
    'firebase-admin/messaging AndroidFcmOptions: FCM accepts android.fcmOptions.analyticsLabel, while non-string values fail client preflight with messaging/invalid-payload and >50-char labels fail FCM v1 wire validation with HTTP 400 INVALID_ARGUMENT.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId, errorEnvelopeParity }) =>
      observeAndroidFcmOptions({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
        errorEnvelopeParity,
      }),
    );
  },
};
