import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface ApnsConfigAndHeadersSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeApnsConfigAndHeaders(
  subject: ApnsConfigAndHeadersSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  emptyLiveActivityToken: CapturedMessagingCallOutcome;
  nonStringHeaderValue: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-collapse-id': 'col-1',
      },
      payload: {
        aps: { alert: 'Ping' },
      },
    },
  });

  const emptyLiveActivityToken = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { liveActivityToken: '' },
      },
      true,
    ),
  );

  const nonStringHeaderValue = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { headers: { 'apns-priority': 10 } },
      },
      true,
    ),
  );

  return {
    accepted,
    emptyLiveActivityToken,
    nonStringHeaderValue,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging ApnsConfig: FCM accepts apns.headers with apns.payload, while empty liveActivityToken and non-string header values fail client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeApnsConfigAndHeaders({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
