import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type AcceptedSendPairOutcome,
  type CapturedMessagingCallOutcome,
  captureAcceptedSendPair,
  captureMessagingCall,
  nameFacts,
  type RawSendFn,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

export interface WireSendPairSummary {
  dryRunStatus: number;
  dryRunAccepted: boolean;
  dryRunName?: {
    matchesProjectsMessagesFormat: boolean;
    projectSegmentMatchesProject: boolean;
  };
  dryRunError?: unknown;
  realSendStatus: number;
  realSendAccepted: boolean;
  realSendName?: {
    matchesProjectsMessagesFormat: boolean;
    projectSegmentMatchesProject: boolean;
  };
  realSendError?: unknown;
  dryRunMatchesRealSend: boolean;
}

export interface TtlAndCollapseKeySubject {
  projectId: string;
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
  rawSend: RawSendFn;
}

export interface TtlAndCollapseKeyBehavior {
  androidZeroTtlAndCollapseKey: AcceptedSendPairOutcome;
  androidFourWeekMaxTtl: AcceptedSendPairOutcome;
  androidSubsecondTtl: AcceptedSendPairOutcome;
  androidOverFourWeekTtlClient: CapturedMessagingCallOutcome;
  androidOverFourWeekTtlWire: WireSendPairSummary;
  webpushZeroTtlAndTopic: AcceptedSendPairOutcome;
  webpushFourWeekMaxTtl: AcceptedSendPairOutcome;
  webpushOverFourWeekTtlWire: WireSendPairSummary;
  apnsZeroExpirationAndCollapseId: AcceptedSendPairOutcome;
  apnsOver64ByteCollapseIdWire: WireSendPairSummary;
}

const FOUR_WEEKS_SECONDS = 2_419_200;
const FOUR_WEEKS_MILLIS = FOUR_WEEKS_SECONDS * 1_000;
const OVER_FOUR_WEEKS_SECONDS = FOUR_WEEKS_SECONDS + 1;
const OVER_FOUR_WEEKS_MILLIS = OVER_FOUR_WEEKS_SECONDS * 1_000;

async function captureWireSendPair(
  rawSend: RawSendFn,
  projectId: string,
  message: Record<string, unknown>,
): Promise<WireSendPairSummary> {
  const dry = await rawSend({ validate_only: true, message: structuredClone(message) });
  const real = await rawSend({ validate_only: false, message: structuredClone(message) });

  const summary: WireSendPairSummary = {
    dryRunStatus: dry.status,
    dryRunAccepted: dry.status === 200,
    realSendStatus: real.status,
    realSendAccepted: real.status === 200,
    dryRunMatchesRealSend:
      dry.status === real.status &&
      JSON.stringify(dry.body.error ?? null) === JSON.stringify(real.body.error ?? null),
  };

  if (typeof dry.body.name === 'string') {
    summary.dryRunName = nameFacts(dry.body.name, projectId);
  }
  if (dry.body.error !== undefined) {
    summary.dryRunError = dry.body.error;
  }
  if (typeof real.body.name === 'string') {
    summary.realSendName = nameFacts(real.body.name, projectId);
  }
  if (real.body.error !== undefined) {
    summary.realSendError = real.body.error;
  }

  return summary;
}

export async function observeTtlAndCollapseKey(
  subject: TtlAndCollapseKeySubject,
): Promise<TtlAndCollapseKeyBehavior> {
  const androidZeroTtlAndCollapseKey = await captureAcceptedSendPair(
    subject.sendClient,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      android: {
        ttl: 0,
        collapseKey: 'col-sync-item',
      },
      data: { kind: 'android-ttl-0' },
    },
  );

  const androidFourWeekMaxTtl = await captureAcceptedSendPair(
    subject.sendClient,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      android: {
        ttl: FOUR_WEEKS_MILLIS,
        collapseKey: 'col-sync-item',
      },
      data: { kind: 'android-ttl-4w' },
    },
  );

  const androidSubsecondTtl = await captureAcceptedSendPair(
    subject.sendClient,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      android: {
        ttl: 1_500,
      },
      data: { kind: 'android-ttl-subsecond' },
    },
  );

  const androidOverFourWeekTtlClient = await captureMessagingCall(() =>
    subject.sendClient(
      {
        topic: 'pyric-oracle-messaging-probe',
        android: {
          ttl: OVER_FOUR_WEEKS_MILLIS,
        },
      },
      true,
    ),
  );

  const androidOverFourWeekTtlWire = await captureWireSendPair(
    subject.rawSend,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      android: {
        ttl: `${OVER_FOUR_WEEKS_SECONDS}s`,
      },
      data: { kind: 'android-ttl-over-4w' },
    },
  );

  const webpushZeroTtlAndTopic = await captureAcceptedSendPair(
    subject.sendClient,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      webpush: {
        headers: {
          TTL: '0',
          Topic: 'col-web-sync',
          Urgency: 'high',
        },
      },
      data: { kind: 'webpush-ttl-0' },
    },
  );

  const webpushFourWeekMaxTtl = await captureAcceptedSendPair(
    subject.sendClient,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      webpush: {
        headers: {
          TTL: String(FOUR_WEEKS_SECONDS),
          Topic: 'col-web-sync',
        },
      },
      data: { kind: 'webpush-ttl-4w' },
    },
  );

  const webpushOverFourWeekTtlWire = await captureWireSendPair(
    subject.rawSend,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      webpush: {
        headers: {
          TTL: String(OVER_FOUR_WEEKS_SECONDS),
        },
      },
      data: { kind: 'webpush-ttl-over-4w' },
    },
  );

  const apnsZeroExpirationAndCollapseId = await captureAcceptedSendPair(
    subject.sendClient,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      apns: {
        headers: {
          'apns-expiration': '0',
          'apns-collapse-id': 'col-apns-sync',
          'apns-priority': '10',
        },
        payload: {
          aps: {
            alert: 'immediate-apns',
          },
        },
      },
    },
  );

  const apnsOver64ByteCollapseIdWire = await captureWireSendPair(
    subject.rawSend,
    subject.projectId,
    {
      topic: 'pyric-oracle-messaging-probe',
      apns: {
        headers: {
          'apns-collapse-id': 'c'.repeat(65),
        },
        payload: {
          aps: {
            alert: 'long-collapse-id',
          },
        },
      },
    },
  );

  return {
    androidZeroTtlAndCollapseKey,
    androidFourWeekMaxTtl,
    androidSubsecondTtl,
    androidOverFourWeekTtlClient,
    androidOverFourWeekTtlWire,
    webpushZeroTtlAndTopic,
    webpushFourWeekMaxTtl,
    webpushOverFourWeekTtlWire,
    apnsZeroExpirationAndCollapseId,
    apnsOver64ByteCollapseIdWire,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'FCM v1 messages:send store-and-forward TTL and collapse-key intake across android (ttl 0ms, 1.5s fractional, 2419200000ms four-week boundary, >2419200s wire response, collapseKey), webpush (headers.TTL 0, 2419200, >2419200 wire response, headers.Topic), and apns (apns-expiration 0, apns-collapse-id and >64-byte wire response).',
  async observe() {
    const observed = await withMessagingSendProbeSession(async ({ app, projectId, rawSend }) =>
      observeTtlAndCollapseKey({
        projectId,
        sendClient: (msg, dryRun) => getMessaging(app).send(msg as unknown as Message, dryRun),
        rawSend,
      }),
    );
    return { ...observed };
  },
};
