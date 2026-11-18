import { getMessaging, type MessagingTopicManagementResponse } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type CapturedSyncOrAsyncMessagingOutcome,
  captureSyncOrAsyncMessagingCall,
  type SummarizedTopicManagementResponse,
  summarizeTopicManagementResponse,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

interface TopicSubscribeSubject {
  subscribe: (
    tokenOrTokens: unknown,
    topic: unknown,
  ) => Promise<MessagingTopicManagementResponse>;
}

export async function observeTopicSubscribeBatch(subject: TopicSubscribeSubject): Promise<{
  mixedInvalidTokensBareTopic: SummarizedTopicManagementResponse;
  prefixedTopicNormalized: SummarizedTopicManagementResponse;
  prefixedMatchesSingleBareError: boolean;
  emptyStringTokenSync: CapturedSyncOrAsyncMessagingOutcome;
  emptyArrayTokensSync: CapturedSyncOrAsyncMessagingOutcome;
  emptyTopicSync: CapturedSyncOrAsyncMessagingOutcome;
  emptyElementInArrayAsync: CapturedSyncOrAsyncMessagingOutcome;
  overMax1001TokensAsync: CapturedSyncOrAsyncMessagingOutcome;
  invalidTopicCharsetAsync: CapturedSyncOrAsyncMessagingOutcome;
  doubleTopicsPrefixAsync: CapturedSyncOrAsyncMessagingOutcome;
}> {
  const mixedRaw = await subject.subscribe(
    ['not-a-valid-fcm-token', 'aaaa:APA91bSYNTHETICUNREGISTEREDTOKEN'],
    'pyric-oracle-messaging-probe',
  );
  const mixedInvalidTokensBareTopic = summarizeTopicManagementResponse(mixedRaw);

  const prefixedRaw = await subject.subscribe(
    'not-a-valid-fcm-token',
    '/topics/pyric-oracle-messaging-probe',
  );
  const prefixedTopicNormalized = summarizeTopicManagementResponse(prefixedRaw);
  const prefixedMatchesSingleBareError =
    prefixedTopicNormalized.failureCount === 1 &&
    prefixedTopicNormalized.errors[0]?.error.code ===
      mixedInvalidTokensBareTopic.errors[0]?.error.code;

  const emptyStringTokenSync = await captureSyncOrAsyncMessagingCall(() =>
    subject.subscribe('', 'pyric-oracle-messaging-probe'),
  );
  const emptyArrayTokensSync = await captureSyncOrAsyncMessagingCall(() =>
    subject.subscribe([], 'pyric-oracle-messaging-probe'),
  );
  const emptyTopicSync = await captureSyncOrAsyncMessagingCall(() =>
    subject.subscribe('tok-1', ''),
  );
  const emptyElementInArrayAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.subscribe(['tok-1', ''], 'pyric-oracle-messaging-probe'),
  );
  const overLimitTokens = Array.from({ length: 1001 }, (_, idx) => `tok-${idx}`);
  const overMax1001TokensAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.subscribe(overLimitTokens, 'pyric-oracle-messaging-probe'),
  );
  const invalidTopicCharsetAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.subscribe('tok-1', 'bad#topic!'),
  );
  const doubleTopicsPrefixAsync = await captureSyncOrAsyncMessagingCall(() =>
    subject.subscribe('tok-1', '/topics//topics/pyric-oracle-messaging-probe'),
  );

  return {
    mixedInvalidTokensBareTopic,
    prefixedTopicNormalized,
    prefixedMatchesSingleBareError,
    emptyStringTokenSync,
    emptyArrayTokensSync,
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
    'firebase-admin/messaging subscribeToTopic(tokenOrTokens, topic): live IID /iid/v1:batchAdd MessagingTopicManagementResponse per-index error mapping, /topics/ prefix normalization, and synchronous vs asynchronous input validation guards.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app }) => {
      const svc = getMessaging(app);
      return observeTopicSubscribeBatch({
        subscribe: (tokens, topic) => svc.subscribeToTopic(tokens as string | string[], topic as string),
      });
    });
  },
};
