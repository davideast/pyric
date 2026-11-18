import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface ApnsApsFieldsSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeApnsApsFields(
  subject: ApnsApsFieldsSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  duplicateContentAvailable: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    apns: {
      payload: {
        aps: {
          alert: 'Update',
          badge: 1,
          sound: 'default',
          contentAvailable: true,
          mutableContent: true,
          category: 'SYNC',
          threadId: 'thread-7',
          customApsKey: 'v1',
        },
      },
    },
  });

  const duplicateContentAvailable = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: {
          payload: {
            aps: {
              contentAvailable: true,
              'content-available': 1,
            },
          },
        },
      },
      true,
    ),
  );

  return {
    accepted,
    duplicateContentAvailable,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "interface Aps { alert?; badge?; sound?; contentAvailable?; mutableContent?; category?; threadId?; [customData] }",
  rowIds: ['messaging-admin#23'],
  description:
    'firebase-admin/messaging Aps dictionary: transforms camelCase contentAvailable, mutableContent, and threadId into APNs wire keys accepted by FCM, and rejects simultaneous camelCase and hyphenated keys with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeApnsApsFields({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
