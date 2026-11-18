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

interface FcmOptionsAnalyticsLabelSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
  errorEnvelopeParity: (message: Record<string, unknown>) => Promise<ErrorEnvelopeParityOutcome>;
}

export async function observeFcmOptionsAnalyticsLabel(
  subject: FcmOptionsAnalyticsLabelSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  nonStringAnalyticsLabel: CapturedMessagingCallOutcome;
  wireOversizedLabel51: ErrorEnvelopeParityOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    data: { item: '1' },
    fcmOptions: { analyticsLabel: 'promo_2026' },
  });

  const nonStringAnalyticsLabel = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        fcmOptions: { analyticsLabel: 123 },
      },
      true,
    ),
  );

  const wireOversizedLabel51 = await subject.errorEnvelopeParity({
    topic: 'pyric-oracle-messaging-probe',
    fcm_options: { analytics_label: 'a'.repeat(51) },
  });

  return {
    accepted,
    nonStringAnalyticsLabel,
    wireOversizedLabel51,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "interface FcmOptions { analyticsLabel? }",
  rowIds: ['messaging-admin#17'],
  description:
    'firebase-admin/messaging FcmOptions.analyticsLabel: accepted on topic send and dryRun, non-string rejected in client preflight with messaging/invalid-payload, and >50-char top-level analytics_label accepted on FCM v1 wire with HTTP 200.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId, errorEnvelopeParity }) =>
      observeFcmOptionsAnalyticsLabel({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
        errorEnvelopeParity,
      }),
    );
  },
};
