import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type CapturedMessagingCallOutcome,
  captureMessagingCall,
  type ErrorEnvelopeParityOutcome,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

export interface MultipleTargetsSubject {
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>;
  errorEnvelopeParity: (message: Record<string, unknown>) => Promise<ErrorEnvelopeParityOutcome>;
}

interface ClientRejectionPair {
  dryRun: CapturedMessagingCallOutcome;
  realSend: CapturedMessagingCallOutcome;
}

async function captureClientPair(
  sendClient: (message: Record<string, unknown>, dryRun: boolean) => Promise<string>,
  payload: Record<string, unknown>,
): Promise<ClientRejectionPair> {
  const dryRun = await captureMessagingCall(() => sendClient({ ...payload }, true));
  const realSend = await captureMessagingCall(() => sendClient({ ...payload }, false));
  return {
    dryRun,
    realSend,
  };
}

export async function observeMultipleTargetsRejected(
  subject: MultipleTargetsSubject,
): Promise<{
  topicAndConditionClient: ClientRejectionPair;
  tokenAndTopicClient: ClientRejectionPair;
  allThreeTargetsClient: ClientRejectionPair;
  wireTopicAndCondition: ErrorEnvelopeParityOutcome;
}> {
  const topicAndCondition = {
    topic: 'pyric-oracle-messaging-probe',
    condition: "'pyric-oracle-a' in topics",
  };
  const tokenAndTopic = {
    token: 'segment-one:segment-two',
    topic: 'pyric-oracle-messaging-probe',
  };
  const allThree = {
    token: 'segment-one:segment-two',
    topic: 'pyric-oracle-messaging-probe',
    condition: "'pyric-oracle-a' in topics",
  };

  const topicAndConditionClient = await captureClientPair(subject.sendClient, topicAndCondition);
  const tokenAndTopicClient = await captureClientPair(subject.sendClient, tokenAndTopic);
  const allThreeTargetsClient = await captureClientPair(subject.sendClient, allThree);
  const wireTopicAndCondition = await subject.errorEnvelopeParity(topicAndCondition);

  return {
    topicAndConditionClient,
    tokenAndTopicClient,
    allThreeTargetsClient,
    wireTopicAndCondition,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "type Message = TokenMessage | TopicMessage | ConditionMessage",
  rowIds: ['messaging-admin#10'],
  description:
    'firebase-admin/messaging Message target union exclusivity: payloads specifying more than one of token, topic, or condition fail client preflight with messaging/invalid-payload and fail raw FCM v1 wire validation with HTTP 400 INVALID_ARGUMENT.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app, errorEnvelopeParity }) =>
      observeMultipleTargetsRejected({
        sendClient: async (payload, dryRun) =>
          getMessaging(app).send(payload as unknown as Message, dryRun),
        errorEnvelopeParity,
      }),
    );
  },
};
