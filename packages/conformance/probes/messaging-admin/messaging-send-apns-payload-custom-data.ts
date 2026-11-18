import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface ApnsPayloadCustomDataSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeApnsPayloadCustomData(
  subject: ApnsPayloadCustomDataSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  nonObjectPayload: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    apns: {
      payload: {
        aps: {
          badge: 2,
          category: 'ITEM_UPDATE',
        },
        itemId: 'item-42',
        meta: { count: 1 },
      },
    },
  });

  const nonObjectPayload = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { payload: 'not-an-object' },
      },
      true,
    ),
  );

  return {
    accepted,
    nonObjectPayload,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "interface ApnsPayload { aps; [customData] }",
  rowIds: ['messaging-admin#22'],
  description:
    'firebase-admin/messaging ApnsPayload: FCM accepts apns.payload carrying aps alongside arbitrary custom top-level keys, while non-object apns.payload fails client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeApnsPayloadCustomData({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
