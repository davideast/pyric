import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface ApnsApsAlertSubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
}

export async function observeApnsApsAlert(
  subject: ApnsApsAlertSubject,
): Promise<{
  accepted: AcceptedSendPairOutcome;
  locArgsWithoutLocKey: CapturedMessagingCallOutcome;
  titleLocArgsWithoutTitleLocKey: CapturedMessagingCallOutcome;
  subtitleLocArgsWithoutSubtitleLocKey: CapturedMessagingCallOutcome;
}> {
  const accepted = await captureAcceptedSendPair(subject.sendClient, subject.projectId, {
    topic: 'pyric-oracle-messaging-probe',
    apns: {
      payload: {
        aps: {
          alert: {
            title: 'Title',
            subtitle: 'Subtitle',
            body: 'Body',
            locKey: 'BODY_LOC',
            locArgs: ['arg1'],
            titleLocKey: 'TITLE_LOC',
            titleLocArgs: ['targ1'],
            subtitleLocKey: 'SUB_LOC',
            subtitleLocArgs: ['sarg1'],
            launchImage: 'Default.png',
          },
        },
      },
    },
  });

  const locArgsWithoutLocKey = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { payload: { aps: { alert: { locArgs: ['arg1'] } } } },
      },
      true,
    ),
  );

  const titleLocArgsWithoutTitleLocKey = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { payload: { aps: { alert: { titleLocArgs: ['targ1'] } } } },
      },
      true,
    ),
  );

  const subtitleLocArgsWithoutSubtitleLocKey = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        apns: { payload: { aps: { alert: { subtitleLocArgs: ['sarg1'] } } } },
      },
      true,
    ),
  );

  return {
    accepted,
    locArgsWithoutLocKey,
    titleLocArgsWithoutTitleLocKey,
    subtitleLocArgsWithoutSubtitleLocKey,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "interface ApsAlert",
  rowIds: ['messaging-admin#24'],
  description:
    'firebase-admin/messaging ApsAlert: FCM accepts title, subtitle, body, localization keys, and launchImage, while specifying locArgs, titleLocArgs, or subtitleLocArgs without its matching key fails client preflight with messaging/invalid-payload.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeApnsApsAlert({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
      }),
    );
  },
};
