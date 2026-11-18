import {
  getMessaging,
  type BatchResponse,
  type MulticastMessage,
} from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type CapturedMessagingCallOutcome,
  captureMessagingCall,
  summarizeBatchResponse,
  type SummarizedBatchResponse,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

export interface MulticastBatchSubject {
  projectId: string;
  sendEachForMulticastRaw: (
    message: unknown,
    dryRun?: unknown,
  ) => Promise<BatchResponse>;
}

export async function observeMulticastBatch(
  subject: MulticastBatchSubject,
): Promise<{
  mixedInvalidTokensDryRun: SummarizedBatchResponse;
  nullMessage: CapturedMessagingCallOutcome;
  emptyTokensArray: CapturedMessagingCallOutcome;
  overMaxTokens501: CapturedMessagingCallOutcome;
}> {
  const mixedBatch = await subject.sendEachForMulticastRaw(
    {
      tokens: ['not-a-real-fcm-registration-token', ''],
      data: { item: '1' },
      notification: { title: 'Notice', body: 'Multicast probe' },
    },
    true,
  );
  const mixedInvalidTokensDryRun = summarizeBatchResponse(mixedBatch, subject.projectId);

  const nullMessage = await captureMessagingCall(() =>
    subject.sendEachForMulticastRaw(null, true),
  );
  const emptyTokensArray = await captureMessagingCall(() =>
    subject.sendEachForMulticastRaw({ tokens: [] }, true),
  );
  const overMaxTokens501 = await captureMessagingCall(() =>
    subject.sendEachForMulticastRaw(
      { tokens: Array.from({ length: 501 }, (_, idx) => `tok-a:tok-${idx}`) },
      true,
    ),
  );

  return {
    mixedInvalidTokensDryRun,
    nullMessage,
    emptyTokensArray,
    overMaxTokens501,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "Messaging.sendEachForMulticast(message, dryRun?), MulticastMessage, BatchResponse, and SendResponse",
  rowIds: ['messaging-admin#6', 'messaging-admin#15', 'messaging-admin#36', 'messaging-admin#37'],
  description:
    'firebase-admin/messaging sendEachForMulticast(MulticastMessage, dryRun?): ordered per-token SendResponse outcomes and preflight guards for null message, empty tokens array, and >500 tokens.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, projectId }) =>
      observeMulticastBatch({
        projectId,
        sendEachForMulticastRaw: async (message, dryRun) =>
          getMessaging(app).sendEachForMulticast(
            message as MulticastMessage,
            dryRun as boolean | undefined,
          ),
      }),
    );
  },
};
