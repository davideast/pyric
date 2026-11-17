import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface ApnsFcmOptionsSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeApnsFcmOptions(
  subject: ApnsFcmOptionsSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  invalidImageUrl: CapturedMessagingCallOutcome;
  duplicateImageAndImageUrl: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    apns: {
      payload: { aps: { alert: 'Banner' } },
      fcmOptions: {
        analyticsLabel: 'ios_promo',
        imageUrl: 'https://example.com/banner.png',
      },
    },
  });

  const invalidImageUrl = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: {
          fcmOptions: { imageUrl: 'not-a-valid-url' },
        },
      },
      true,
    ),
  );

  const duplicateImageAndImageUrl = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: {
          fcmOptions: {
            imageUrl: 'https://example.com/a.png',
            image: 'https://example.com/b.png',
          },
        },
      },
      true,
    ),
  );

  return {
    accepted,
    invalidImageUrl,
    duplicateImageAndImageUrl,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging ApnsFcmOptions: FCM accepts analyticsLabel and imageUrl (mapped to wire image), while malformed URLs or simultaneous imageUrl and image keys fail client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeApnsFcmOptions({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
