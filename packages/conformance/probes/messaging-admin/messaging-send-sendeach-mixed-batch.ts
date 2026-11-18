import { getMessaging, type BatchResponse, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  summarizeBatchResponse,
  type SummarizedBatchResponse,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

export interface SendEachMixedBatchSubject {
  projectId: string;
  sendEach: (messages: Message[], dryRun?: boolean) => Promise<BatchResponse>;
}

function buildMixedMessages(): Message[] {
  return [
    {
      topic: 'pyric-oracle-messaging-probe',
      data: { idx: '0' },
    },
    {
      token: 'not-a-real-fcm-registration-token',
      data: { idx: '1' },
    },
    {
      topic: '',
      data: { idx: '2' },
    },
  ];
}

export async function observeSendEachMixedBatch(
  subject: SendEachMixedBatchSubject,
): Promise<{
  dryRun: SummarizedBatchResponse;
  realSend: SummarizedBatchResponse;
  dryRunMatchesRealSend: boolean;
}> {
  const dryBatch = await subject.sendEach(buildMixedMessages(), true);
  const realBatch = await subject.sendEach(buildMixedMessages(), false);
  const drySummary = summarizeBatchResponse(dryBatch, subject.projectId);
  const realSummary = summarizeBatchResponse(realBatch, subject.projectId);

  return {
    dryRun: drySummary,
    realSend: realSummary,
    dryRunMatchesRealSend: JSON.stringify(drySummary) === JSON.stringify(realSummary),
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "Messaging.sendEach(messages, dryRun?), BatchResponse, SendResponse, and FirebaseMessagingError",
  rowIds: ['messaging-admin#5', 'messaging-admin#36', 'messaging-admin#37', 'messaging-admin#38'],
  description:
    'firebase-admin/messaging sendEach(messages, dryRun?): ordered BatchResponse and SendResponse shapes across a valid topic send, a wire-rejected invalid token, and a client-invalid empty topic settling per-index as FirebaseMessagingError.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeSendEachMixedBatch({
        projectId,
        sendEach: (messages, dryRun) => getMessaging(app).sendEach(messages, dryRun),
      }),
    );
  },
};
