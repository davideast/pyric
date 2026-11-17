import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface AndroidNotificationSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeAndroidNotification(
  subject: AndroidNotificationSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  malformedColor: CapturedMessagingCallOutcome;
  bodyLocArgsWithoutKey: CapturedMessagingCallOutcome;
  nonDateEventTimestamp: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    android: {
      notification: {
        title: 'Alert',
        body: 'Body',
        icon: 'ic_notify',
        color: '#112233',
        sound: 'default',
        tag: 'tag-1',
        imageUrl: 'https://example.com/a.png',
        channelId: 'general',
        priority: 'high',
        visibility: 'public',
        eventTimestamp: new Date('2026-01-01T00:00:00.000Z'),
        vibrateTimingsMillis: [100, 250],
        notificationCount: 3,
        bodyLocKey: 'BODY_KEY',
        bodyLocArgs: ['arg1'],
      },
    },
  });

  const malformedColor = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: { notification: { color: 'red' } },
      },
      true,
    ),
  );

  const bodyLocArgsWithoutKey = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: { notification: { bodyLocArgs: ['arg1'] } },
      },
      true,
    ),
  );

  const nonDateEventTimestamp = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: { notification: { eventTimestamp: '2026-01-01T00:00:00Z' } },
      },
      true,
    ),
  );

  return {
    accepted,
    malformedColor,
    bodyLocArgsWithoutKey,
    nonDateEventTimestamp,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging AndroidNotification: FCM accepts Android notification fields including #RRGGBB color, Date eventTimestamp, vibrateTimingsMillis, and localization keys, while invalid color, missing bodyLocKey, or non-Date eventTimestamp fail client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeAndroidNotification({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
