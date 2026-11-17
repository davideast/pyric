import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface WebpushNotificationOptionsSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeWebpushNotificationOptions(
  subject: WebpushNotificationOptionsSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  nonStringWebpushData: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    webpush: {
      data: { item: '42' },
      notification: {
        title: 'Notice',
        body: 'Item ready',
        icon: 'https://example.com/icon.png',
        badge: 'https://example.com/badge.png',
        image: 'https://example.com/image.png',
        dir: 'ltr',
        tag: 'group-1',
        renotify: true,
        requireInteraction: false,
        silent: false,
        vibrate: [200, 100],
        actions: [{ action: 'open', title: 'Open' }],
        customField: 'extra-value',
      },
    },
  });

  const nonStringWebpushData = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        webpush: { data: { item: 42 } },
      },
      true,
    ),
  );

  return {
    accepted,
    nonStringWebpushData,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging WebpushNotification and webpush.data: FCM accepts Web Notification API fields plus open-ended index-signature keys, while non-string webpush.data values fail client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeWebpushNotificationOptions({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
