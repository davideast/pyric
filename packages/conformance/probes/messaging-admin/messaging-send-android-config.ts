import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface AndroidConfigSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeAndroidConfig(
  subject: AndroidConfigSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  negativeTtl: CapturedMessagingCallOutcome;
  nonStringDataValue: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    android: {
      collapseKey: 'col-a',
      priority: 'high',
      ttl: 3600000,
      data: { item: '1' },
      directBootOk: true,
    },
  });

  const negativeTtl = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: { ttl: -100 },
      },
      true,
    ),
  );

  const nonStringDataValue = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: { data: { item: 1 } },
      },
      true,
    ),
  );

  return {
    accepted,
    negativeTtl,
    nonStringDataValue,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging AndroidConfig: FCM accepts collapseKey, priority, millisecond ttl, data, and directBootOk, while negative ttl or non-string android.data values fail client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeAndroidConfig({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
