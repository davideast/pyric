import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  nameFacts,
  summarizeBatchResponse,
  type SummarizedBatchResponse,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';
import {
  observeFirebaseAdminTransportRetry,
  type TransportRetryCoreBehavior,
} from '../../src/messaging-send-retry-harness.ts';
import { oracleAppOptions } from '../../src/oracle-credential.ts';

export interface LiveTransportDryRunOutcome {
  sendAccepted: {
    matchesProjectsMessagesFormat: boolean;
    projectSegmentMatchesProject: boolean;
  };
  http2SendEachDryRun: SummarizedBatchResponse;
  legacyHttp1SendEachDryRun: SummarizedBatchResponse;
  liveHttp2MatchesLegacyHttp1: boolean;
}

export interface TransportRetryProbeSubject {
  projectId: string;
  runLiveTransportDryRun: () => Promise<LiveTransportDryRunOutcome>;
}

export interface TransportRetryBackoffObservation extends TransportRetryCoreBehavior {
  liveTransportDryRun: LiveTransportDryRunOutcome;
}

export async function observeTransportRetryBackoff(
  subject: TransportRetryProbeSubject,
): Promise<TransportRetryBackoffObservation> {
  const retryCore = await observeFirebaseAdminTransportRetry(subject.projectId);
  const liveTransportDryRun = await subject.runLiveTransportDryRun();
  return {
    ...retryCore,
    liveTransportDryRun,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging send() and sendEach() transport retry and backoff: defaultRetryConfig (maxRetries 4 on HTTP 503 and ECONNRESET/ETIMEDOUT, non-retry on HTTP 500/429/ECONNREFUSED, Retry-After header override and 60s maxDelayInMillis cap, exponential backoff [0, 1000, 2000, 4000]ms), HTTP/2 vs enableLegacyHttpTransport() HTTP/1.1 batch parity, and live FCM dryRun transport verification.',
  async observe() {
    const observed = await withMessagingSendProbeSession(async ({ app, projectId, sa }) =>
      observeTransportRetryBackoff({
        projectId,
        runLiveTransportDryRun: async () => {
          const legacyApp = initializeApp(
            oracleAppOptions(sa),
            `messaging-retry-live-legacy-${Date.now()}`,
          );
          try {
            const defaultSvc = getMessaging(app);
            const legacySvc = getMessaging(legacyApp);
            legacySvc.enableLegacyHttpTransport();

            const singleDryName = await defaultSvc.send(
              {
                topic: 'pyric-oracle-messaging-probe',
                data: { probe: 'transport-retry-backoff', plane: 'http1-send' },
              },
              true,
            );
            const batchInput = [
              {
                topic: 'pyric-oracle-messaging-probe',
                data: { probe: 'transport-retry-backoff', index: '0' },
              },
              {
                token: 'not-a-real-fcm-registration-token',
                data: { probe: 'transport-retry-backoff', index: '1' },
              },
            ];
            const h2Batch = summarizeBatchResponse(
              await defaultSvc.sendEach(batchInput, true),
              projectId,
            );
            const h1Batch = summarizeBatchResponse(
              await legacySvc.sendEach(batchInput, true),
              projectId,
            );
            return {
              sendAccepted: nameFacts(singleDryName, projectId),
              http2SendEachDryRun: h2Batch,
              legacyHttp1SendEachDryRun: h1Batch,
              liveHttp2MatchesLegacyHttp1: JSON.stringify(h2Batch) === JSON.stringify(h1Batch),
            };
          } finally {
            await deleteApp(legacyApp).catch(() => undefined);
          }
        },
      }),
    );
    return { ...observed };
  },
};
