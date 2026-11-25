import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { describe, expect, test } from 'bun:test';
import { loadObservations } from '../../src/ledger.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { selectMessagingSendTargets } from '../../src/messaging-send-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import {
  captureSyncOrAsyncMessagingCall,
  summarizeTopicManagementResponse,
} from '../../src/messaging-send-probe-session.ts';
import {
  observeTopicSubscribeBatch,
  probe as topicSubscribeProbe,
} from '../../probes/messaging-admin/messaging-send-topic-subscribe-batch.ts';
import {
  observeTopicUnsubscribeBatch,
  probe as topicUnsubscribeProbe,
} from '../../probes/messaging-admin/messaging-send-topic-unsubscribe-batch.ts';

async function withStubbedIidTransport(
  run: (svc: ReturnType<typeof getMessaging>) => Promise<void>,
): Promise<void> {
  const tempApp: App = initializeApp(
    {
      projectId: 'demo-project',
      credential: {
        getAccessToken: async () => ({ access_token: 'stub-token', expires_in: 3600 }),
      },
    },
    `topic-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const svc = getMessaging(tempApp);
    svc.enableLegacyHttpTransport();
    const internal = svc as unknown as {
      messagingRequestHandler: {
        httpClient: {
          send: (req: { url: string }) => Promise<{
            status: number;
            headers: Record<string, string>;
            text: string;
            data: unknown;
            isJson: () => boolean;
          }>;
        };
      };
    };
    internal.messagingRequestHandler.httpClient.send = async (req) => {
      const match = /\/v1\/projects\/[^/]+\/registrations\/([^/]+)\/topicSubscriptions/.exec(
        req.url,
      );
      const tok = decodeURIComponent(match?.[1] ?? '');
      if (!tok.includes(':')) {
        const badBody = {
          error: { status: 'INVALID_ARGUMENT', message: 'Invalid registration token.' },
        };
        return {
          status: 400,
          headers: { 'content-type': 'application/json' },
          text: JSON.stringify(badBody),
          data: badBody,
          isJson: () => true,
        };
      }
      const notFoundBody = {
        error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' },
      };
      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify(notFoundBody),
        data: notFoundBody,
        isJson: () => true,
      };
    };
    await run(svc);
  } finally {
    await deleteApp(tempApp);
  }
}

describe('modular messaging-send topic management probes (Slice 4 family)', () => {
  test('registers subscribeToTopic and unsubscribeFromTopic row-linked probes under rig messaging-send', async () => {
    const modular = await loadModularProbes('messaging-send');
    const ids = modular.map((entry) => entry.id);
    const expectedIds = [
      'messaging-send-topic-subscribe-batch',
      'messaging-send-topic-unsubscribe-batch',
    ];
    for (const id of expectedIds) {
      expect(ids).toContain(id);
    }

    for (const probeRecord of [topicSubscribeProbe, topicUnsubscribeProbe]) {
      expect(probeRecord.rig).toBe('messaging-send');
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow.length).toBeGreaterThan(0);
      expect(probeRecord.rowIds.length).toBe(2);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }
    expect(topicSubscribeProbe.rowIds).toEqual(['messaging-admin#7', 'messaging-admin#35']);
    expect(topicUnsubscribeProbe.rowIds).toEqual(['messaging-admin#8', 'messaging-admin#35']);

    const pending = loadPendingRowLinkObservations();
    const existingNames = new Set(loadObservations().map((obs) => obs.name));
    const unfilteredNames = new Set(
      selectMessagingSendTargets({
        args: [],
        modularProbes: modular,
        includeUncapturedStaged: false,
        observationExists: (name) => existingNames.has(name),
      }).map((item) => item.name),
    );
    for (const id of expectedIds) {
      expect(pending.has(id)).toBe(false);
      expect(unfilteredNames.has(id)).toBe(true);
    }
  });

  test('observes subscribeToTopic and unsubscribeFromTopic IID response mapping and sync vs async validation', async () => {
    await withStubbedIidTransport(async (svc) => {
      const subOut = await observeTopicSubscribeBatch({
        subscribe: (tokens, topic) =>
          svc.subscribeToTopic(tokens as string | string[], topic as string),
      });
      expect(subOut.mixedInvalidTokensBareTopic.successCount).toBe(0);
      expect(subOut.mixedInvalidTokensBareTopic.failureCount).toBe(2);
      expect(subOut.mixedInvalidTokensBareTopic.errors[0]?.error.code).toBe(
        'messaging/invalid-registration-token',
      );
      expect(subOut.mixedInvalidTokensBareTopic.errors[1]?.error.code).toBe(
        'messaging/registration-token-not-registered',
      );
      expect(subOut.prefixedMatchesSingleBareError).toBe(true);
      expect(subOut.emptyStringTokenSync.threw).toBe(true);
      expect(subOut.emptyStringTokenSync.synchronousThrow).toBe(true);
      expect(subOut.emptyArrayTokensSync.synchronousThrow).toBe(true);
      expect(subOut.emptyTopicSync.synchronousThrow).toBe(true);
      expect(subOut.emptyElementInArrayAsync.threw).toBe(true);
      expect(subOut.emptyElementInArrayAsync.synchronousThrow).toBe(false);
      expect(subOut.overMax1001TokensAsync.synchronousThrow).toBe(false);
      expect(subOut.invalidTopicCharsetAsync.synchronousThrow).toBe(false);
      expect(subOut.doubleTopicsPrefixAsync.synchronousThrow).toBe(false);

      const unsubOut = await observeTopicUnsubscribeBatch({
        unsubscribe: (tokens, topic) =>
          svc.unsubscribeFromTopic(tokens as string | string[], topic as string),
      });
      expect(unsubOut.mixedInvalidTokensBareTopic.failureCount).toBe(2);
      expect(unsubOut.prefixedMatchesSingleBareError).toBe(true);
      expect(unsubOut.emptyStringTokenSync.synchronousThrow).toBe(true);
      expect(unsubOut.emptyTopicSync.synchronousThrow).toBe(true);
      expect(unsubOut.emptyElementInArrayAsync.synchronousThrow).toBe(false);
      expect(unsubOut.overMax1001TokensAsync.synchronousThrow).toBe(false);
      expect(unsubOut.invalidTopicCharsetAsync.synchronousThrow).toBe(false);
      expect(unsubOut.doubleTopicsPrefixAsync.synchronousThrow).toBe(false);
    });
  });

  test('summarizeTopicManagementResponse fails closed on infrastructure or auth errors and captureSyncOrAsyncMessagingCall distinguishes sync throws', async () => {
    const okOutcome = await captureSyncOrAsyncMessagingCall(async () => 'ok');
    expect(okOutcome.threw).toBe(false);
    expect(okOutcome.synchronousThrow).toBe(false);

    expect(() =>
      summarizeTopicManagementResponse({
        successCount: 0,
        failureCount: 1,
        errors: [
          {
            index: 0,
            error: Object.assign(new Error('auth failed'), {
              code: 'messaging/authentication-error',
            }) as never,
          },
        ],
      }),
    ).toThrow(/infrastructure\/auth error/);
  });
});
