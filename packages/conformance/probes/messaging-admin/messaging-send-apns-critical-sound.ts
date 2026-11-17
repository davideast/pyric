import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface ApnsCriticalSoundSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeApnsCriticalSound(
  subject: ApnsCriticalSoundSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  emptySoundName: CapturedMessagingCallOutcome;
  negativeVolume: CapturedMessagingCallOutcome;
  volumeAboveOne: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    apns: {
      payload: {
        aps: {
          alert: 'Critical notice',
          sound: {
            critical: true,
            name: 'default',
            volume: 0.5,
          },
        },
      },
    },
  });

  const emptySoundName = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { payload: { aps: { sound: { name: '' } } } },
      },
      true,
    ),
  );

  const negativeVolume = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { payload: { aps: { sound: { name: 'default', volume: -0.1 } } } },
      },
      true,
    ),
  );

  const volumeAboveOne = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { payload: { aps: { sound: { name: 'default', volume: 1.5 } } } },
      },
      true,
    ),
  );

  return {
    accepted,
    emptySoundName,
    negativeVolume,
    volumeAboveOne,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging CriticalSound: FCM accepts aps.sound critical dictionary with name and volume in [0, 1], while empty name or out-of-range volume fails client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeApnsCriticalSound({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
