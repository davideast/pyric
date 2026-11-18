import { getMessaging, type MessagingTopicManagementResponse } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type CapturedSyncOrAsyncMessagingOutcome,
  captureSyncOrAsyncMessagingCall,
  type SummarizedTopicManagementResponse,
  summarizeTopicManagementResponse,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface TopicUnsubscribeSubject {
  unsubscribe: (
    tokenOrTokens: unknown,
    topic: unknown,
  ) => Promise<MessagingTopicManagementResponse>;
}

export async function observeTopicUnsubscribeBatch(subject: TopicUnsubscribeSubject): Promise<{
  mixedInvalidTokensBareTopic: SummarizedTopicManagementResponse;
  prefixedTopicNormalized: SummarizedTopicManagementResponse;
  prefixedMatchesSingleBareError: boolean;
  emptyStringTokenSync: CapturedSyncOrAsyncMessagingOutcome;
  emptyTopicSync: CapturedSyncOrAsyncMessagingOutcome;
  emptyElementInArrayAsync: CapturedSyncOrAsyncMessagingOutcome;
  overMax1001TokensAsync: CapturedSyncOrAsyncMessagingOutcome;
  invalidTopicCharsetAsync: CapturedSyncOrAsyncMessagingOutcome;
  doubleTopicsPrefixAsync: CapturedSyncOrAsyncMessagingOutcome;
}> {
  const mixedRaw = await subject.unsubscribe(
    ['not-a-valid-fcm-token', 'aaaa:APA91bSYNTHETICUNREGISTEREDTOKEN'],
    'pyric-oracle-messaging-probe',
  );
  const mixedInvalidTokensBareTopic = summarizeTopicManagementResponse(mixedRaw);

  const prefixedRaw = await subject.unsubscribe(
    'not-a-valid-fcm-token',
    '/topics/pyric-oracle-messaging-probe',
  );
  const prefixedTopicNormalized = summarizeTopicManagementResponse(prefixedRaw);
  const prefixedMatchesSingleBareError =
    prefixedTopicNormalized.failureCount === 1 &&
    prefixedTopicNormalized.errors[0]?.error.code ===
      mixedInvalidTokensBareTopic.errors[0]?.error.code;

  const emptyStringTokenSync = await captureSyncOrAsyncMessagingCall(() =>
    subject.unsubscribe('', 'pyric-oracle-messaging-probe'),
  );
  const emptyTopicSync = await captureSyncOrAsyncMessagingCall(() =>
    subject.unsubscribe('tok-1', ''),
  );
  const emptyElementInArrayAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.unsubscribe(['tok-1', ''], 'pyric-oracle-messaging-probe'),
  );
  const overLimitTokens = Array.from({ length: 1001 }, (_, idx) => `tok-${idx}`);
  const overMax1001TokensAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.unsubscribe(overLimitTokens, 'pyric-oracle-messaging-probe'),
  );
  const invalidTopicCharsetAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.unsubscribe('tok-1', 'bad#topic!'),
  );
  const doubleTopicsPrefixAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.unsubscribe('tok-1', '/topics//topics/pyric-oracle-messaging-probe'),
  );

  return {
    mixedInvalidTokensBareTopic,
    prefixedTopicNormalized,
    prefixedMatchesSingleBareError,
    emptyStringTokenSync,
    emptyTopicSync,
    emptyElementInArrayAsync,
    overMax1001TokensAsync,
    invalidTopicCharsetAsync,
    doubleTopicsPrefixAsync,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging unsubscribeFromTopic(tokenOrTokens, topic): live IID /iid/v1:batchRemove MessagingTopicManagementResponse per-index error mapping, /topics/ prefix normalization, and synchronous vs asynchronous input validation guards.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app }) => {
      const svc = getMessaging(app);
      return observeTopicUnsubscribeBatch({
        unsubscribe: (tokens, topic) =>
          svc.unsubscribeFromTopic(tokens as string | string[], topic as string),
      });
    });
  },
};
