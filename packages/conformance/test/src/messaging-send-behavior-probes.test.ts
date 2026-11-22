import { describe, expect, test } from 'bun:test';
import { FirebaseMessagingError as UpstreamMessagingError } from 'firebase-admin/messaging';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp as deletePyricAdminApp, initializeApp as initializePyricAdminApp } from 'pyric-admin/app';
import {
  FirebaseMessagingError as PyricMessagingError,
  getMessaging as getPyricAdminMessaging,
} from 'pyric-admin/messaging';
import {
  observeTransportRetryBackoff,
  probe as transportRetryBackoffProbe,
} from '../../probes/messaging-admin/messaging-send-transport-retry-backoff.ts';
import {
  observeTtlAndCollapseKey,
  probe as ttlAndCollapseKeyProbe,
} from '../../probes/messaging-admin/messaging-send-ttl-and-collapse-key.ts';
import { section as adminBehaviorSection } from '../../registry/messaging/admin-behavior/section.ts';
import { bindMessagingBehaviorRow, SUITE } from '../../registry/messaging/defaults.ts';
import {
  parseSelectedMessagingWebScenarios,
  writeMessagingWebObservations,
} from '../../src/capture/messaging-web/write-observations.ts';
import { nameFacts } from '../../src/messaging-send-probe-session.ts';
import { selectMessagingSendTargets } from '../../src/messaging-send-probes.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const RETRY_PROBE_ID = 'messaging-send-transport-retry-backoff';
const TTL_PROBE_ID = 'messaging-send-ttl-and-collapse-key';

function makeUpstreamMessagingError(code: string, message: string): UpstreamMessagingError {
  const err = Object.create(UpstreamMessagingError.prototype) as UpstreamMessagingError;
  Object.defineProperties(err, {
    code: { value: code, enumerable: true },
    message: { value: message, enumerable: true },
    name: { value: 'FirebaseMessagingError', enumerable: true },
  });
  return err;
}

describe('staged messaging-admin behavior-class probes (#41 and #42)', () => {
  test('registers transport-retry-backoff and ttl-and-collapse-key under messaging-send with pendingRowLink', async () => {
    const modular = await loadModularProbes('messaging-send');
    const modularIds = modular.map((entry) => entry.id);
    expect(modularIds).toContain(RETRY_PROBE_ID);
    expect(modularIds).toContain(TTL_PROBE_ID);

    for (const candidate of [transportRetryBackoffProbe, ttlAndCollapseKeyProbe]) {
      expect(candidate.rig).toBe('messaging-send');
      expect(candidate.pendingRowLink).toBe(true);
      expect(candidate.matrixRow).toBe('');
      expect(candidate.rowIds).toEqual([]);
      expect(candidate.description.length).toBeGreaterThan(30);
    }

    const unfilteredWriteNames = new Set(
      selectMessagingSendTargets({
        args: [],
        modularProbes: modular,
        includeUncapturedStaged: false,
      }).map((item) => item.name),
    );

    expectStagedUntilCaptured([RETRY_PROBE_ID, TTL_PROBE_ID], {
      rig: 'messaging-send',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredWriteNames.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredWriteNames.has(name)).toBe(true);
      },
    });

    const previewNames = selectMessagingSendTargets({
      args: [],
      modularProbes: modular,
      includeUncapturedStaged: true,
    }).map((item) => item.name);
    expect(previewNames).toContain(RETRY_PROBE_ID);
    expect(previewNames).toContain(TTL_PROBE_ID);

    const explicitBoth = selectMessagingSendTargets({
      args: ['--probe', RETRY_PROBE_ID, '--probe', TTL_PROBE_ID],
      modularProbes: modular,
      includeUncapturedStaged: false,
    }).map((item) => item.name);
    expect(explicitBoth).toEqual([RETRY_PROBE_ID, TTL_PROBE_ID]);
  });

  test('observeTransportRetryBackoff deterministically captures firebase-admin HTTP/1.1 + HTTP/2 retry/backoff and contrasts pyric-admin in-memory dispatch', async () => {
    const syntheticLiveOutcome = async () => ({
      sendAccepted: nameFacts('projects/demo-project/messages/live-dry-1', 'demo-project'),
      http2SendEachDryRun: {
        successCount: 1,
        failureCount: 1,
        responseCount: 2,
        responses: [],
      },
      legacyHttp1SendEachDryRun: {
        successCount: 1,
        failureCount: 1,
        responseCount: 2,
        responses: [],
      },
      liveHttp2MatchesLegacyHttp1: true,
    });

    const run1 = await observeTransportRetryBackoff({
      projectId: 'demo-project',
      runLiveTransportDryRun: syntheticLiveOutcome,
    });
    const run2 = await observeTransportRetryBackoff({
      projectId: 'demo-project',
      runLiveTransportDryRun: syntheticLiveOutcome,
    });
    expect(run1).toEqual(run2);

    expect(run1.defaultRetryConfig).toEqual({
      http1: {
        maxRetries: 4,
        statusCodes: [503],
        ioErrorCodes: ['ECONNRESET', 'ETIMEDOUT'],
        backOffFactor: 0.5,
        maxDelayInMillis: 60_000,
      },
      http2: {
        maxRetries: 4,
        statusCodes: [503],
        ioErrorCodes: ['ECONNRESET', 'ETIMEDOUT'],
        backOffFactor: 0.5,
        maxDelayInMillis: 60_000,
      },
      configsEqual: true,
    });

    expect(run1.http1Send.transient503TwiceThen200).toEqual({
      attempts: 3,
      delaysMs: [0, 1_000],
      nameFacts: {
        matchesProjectsMessagesFormat: true,
        projectSegmentMatchesProject: true,
      },
    });
    expect(run1.http1Send.retryAfterHeaderSeconds3Then200).toEqual({
      attempts: 2,
      delaysMs: [3_000],
      nameFacts: {
        matchesProjectsMessagesFormat: true,
        projectSegmentMatchesProject: true,
      },
    });
    expect(run1.http1Send.retryAfterExceedsMaxDelay120s.attempts).toBe(1);
    expect(run1.http1Send.retryAfterExceedsMaxDelay120s.delaysMs).toEqual([]);
    expect(run1.http1Send.retryAfterExceedsMaxDelay120s.outcome.code).toBe(
      'messaging/server-unavailable',
    );

    expect(run1.http1Send.exhausted503FiveAttempts.attempts).toBe(5);
    expect(run1.http1Send.exhausted503FiveAttempts.delaysMs).toEqual([0, 1_000, 2_000, 4_000]);
    expect(run1.http1Send.exhausted503FiveAttempts.outcome.code).toBe(
      'messaging/server-unavailable',
    );
    expect(run1.http1Send.exhausted503FiveAttempts.outcome.isFirebaseMessagingError).toBe(true);

    expect(run1.http1Send.http500InternalNotRetried.attempts).toBe(1);
    expect(run1.http1Send.http500InternalNotRetried.delaysMs).toEqual([]);
    expect(run1.http1Send.http500InternalNotRetried.outcome.code).toBe('messaging/internal-error');

    expect(run1.http1Send.http429QuotaExceededNotRetried.attempts).toBe(1);
    expect(run1.http1Send.http429QuotaExceededNotRetried.delaysMs).toEqual([]);
    expect(run1.http1Send.http429QuotaExceededNotRetried.outcome.code).toBe(
      'messaging/message-rate-exceeded',
    );

    expect(run1.http1Send.econnresetOnceThen200).toEqual({
      attempts: 2,
      delaysMs: [0],
      nameFacts: {
        matchesProjectsMessagesFormat: true,
        projectSegmentMatchesProject: true,
      },
    });

    expect(run1.http1Send.etimedoutExhaustedFiveAttempts.attempts).toBe(5);
    expect(run1.http1Send.etimedoutExhaustedFiveAttempts.delaysMs).toEqual([
      0,
      1_000,
      2_000,
      4_000,
    ]);
    expect(run1.http1Send.etimedoutExhaustedFiveAttempts.outcome.code).toBe('app/network-timeout');
    expect(run1.http1Send.etimedoutExhaustedFiveAttempts.outcome.isFirebaseMessagingError).toBe(
      false,
    );

    expect(run1.http1Send.econnrefusedNotRetried.attempts).toBe(1);
    expect(run1.http1Send.econnrefusedNotRetried.delaysMs).toEqual([]);
    expect(run1.http1Send.econnrefusedNotRetried.outcome.code).toBe('app/network-error');

    expect(run1.batchSendEach.defaultHttp2.http1Requests).toBe(0);
    expect(run1.batchSendEach.defaultHttp2.http2Requests).toBe(7);
    expect(run1.batchSendEach.defaultHttp2.batch.successCount).toBe(1);
    expect(run1.batchSendEach.defaultHttp2.batch.failureCount).toBe(1);
    expect(run1.batchSendEach.defaultHttp2.batch.responses[1]?.error?.code).toBe(
      'messaging/server-unavailable',
    );

    expect(run1.batchSendEach.legacyHttp1.http1Requests).toBe(7);
    expect(run1.batchSendEach.legacyHttp1.http2Requests).toBe(0);
    expect(run1.batchSendEach.batchOutcomesMatch).toBe(true);

    // Contrast pyric-admin/messaging synchronous in-memory dispatch over MessagingBroker.
    const sandbox = initializeSandbox({ projectId: 'demo-project' });
    const pyricApp = initializePyricAdminApp(
      { sandbox, projectId: 'demo-project' },
      `pyric-retry-contrast-${Date.now()}`,
    );
    try {
      const pyricSvc = getPyricAdminMessaging(pyricApp);
      expect(pyricSvc.enableLegacyHttpTransport()).toBeUndefined();
      const batch = await pyricSvc.sendEach(
        [
          { topic: 'batch-item-recover', data: { item: '0' } },
          { token: 'invalid-token-without-colon', data: { item: '1' } },
        ],
        true,
      );
      expect(batch.successCount).toBe(1);
      expect(batch.failureCount).toBe(1);
      expect(batch.responses[1]?.error).toBeInstanceOf(PyricMessagingError);
    } finally {
      await deletePyricAdminApp(pyricApp);
      sandbox.dispose();
    }
  });

  test('observeTtlAndCollapseKey records send-plane TTL/collapse-key bounds and aligns with pyric-admin/messaging validation', async () => {
    const invalidArgBody = {
      error: {
        code: 400,
        message: 'Invalid TTL duration',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            errorCode: 'INVALID_ARGUMENT',
          },
        ],
      },
    };

    const result = await observeTtlAndCollapseKey({
      projectId: 'demo-project',
      sendClient: async (msg, dryRun) => {
        const android = msg.android as { ttl?: number } | undefined;
        if (android?.ttl !== undefined && android.ttl > 2_419_200_000) {
          throw makeUpstreamMessagingError('messaging/invalid-argument', 'Invalid TTL duration');
        }
        if (dryRun) {
          return 'projects/demo-project/messages/dry-1';
        }
        return 'projects/demo-project/messages/real-1';
      },
      rawSend: async ({ message }) => {
        const android = message.android as { ttl?: string } | undefined;
        if (android?.ttl === '2419201s') {
          return { status: 400, body: invalidArgBody };
        }
        return {
          status: 200,
          body: { name: 'projects/demo-project/messages/wire-ok' },
        };
      },
    });

    expect(result.androidZeroTtlAndCollapseKey.dryRunSameShapeAsReal).toBe(true);
    expect(result.androidFourWeekMaxTtl.dryRunSameShapeAsReal).toBe(true);
    expect(result.androidSubsecondTtl.dryRunSameShapeAsReal).toBe(true);
    expect(result.androidOverFourWeekTtlClient.threw).toBe(true);
    expect(result.androidOverFourWeekTtlClient.code).toBe('messaging/invalid-argument');
    expect(result.androidOverFourWeekTtlWire.dryRunStatus).toBe(400);
    expect(result.androidOverFourWeekTtlWire.dryRunMatchesRealSend).toBe(true);
    expect(result.webpushZeroTtlAndTopic.dryRunSameShapeAsReal).toBe(true);
    expect(result.webpushFourWeekMaxTtl.dryRunSameShapeAsReal).toBe(true);
    expect(result.apnsZeroExpirationAndCollapseId.dryRunSameShapeAsReal).toBe(true);

    // Verify pyric-admin/messaging accepts valid TTL/collapse-key shapes and rejects malformed ones.
    const sandbox = initializeSandbox({ projectId: 'demo-project' });
    const pyricApp = initializePyricAdminApp(
      { sandbox, projectId: 'demo-project' },
      `pyric-ttl-check-${Date.now()}`,
    );
    try {
      const svc = getPyricAdminMessaging(pyricApp);
      await expect(
        svc.send({
          topic: 'items',
          android: { ttl: 0, collapseKey: 'col-sync' },
        }),
      ).resolves.toMatch(/^projects\/demo-project\/messages\//);
      await expect(
        svc.send({
          topic: 'items',
          android: { ttl: 2_419_200_000, collapseKey: 'col-sync' },
        }),
      ).resolves.toMatch(/^projects\/demo-project\/messages\//);
      await expect(
        svc.send({
          topic: 'items',
          webpush: { headers: { TTL: '0', Topic: 'col-web' } },
        }),
      ).resolves.toMatch(/^projects\/demo-project\/messages\//);
      await expect(
        svc.send({
          topic: 'items',
          apns: {
            headers: { 'apns-expiration': '0', 'apns-collapse-id': 'col-apns' },
            payload: { aps: { alert: 'now' } },
          },
        }),
      ).resolves.toMatch(/^projects\/demo-project\/messages\//);

      await expect(
        svc.send({ topic: 'items', android: { ttl: -1 } }),
      ).rejects.toMatchObject({ code: 'messaging/invalid-payload' });
      await expect(
        svc.send({ topic: 'items', webpush: { headers: { TTL: '-1' } } }),
      ).rejects.toMatchObject({ code: 'messaging/invalid-argument' });
    } finally {
      await deletePyricAdminApp(pyricApp);
      sandbox.dispose();
    }
  });

  test('offline-store-and-forward scenario filter and writeMessagingWebObservations emit redacted messaging-admin#42 JSON', () => {
    const selected = parseSelectedMessagingWebScenarios([
      '--write',
      '--only',
      'offline-store-and-forward',
    ]);
    expect([...selected]).toEqual(['offline-store-and-forward']);

    const files = new Map<string, string>();
    const secretToken = 'cSecretOfflineFid01:APA91bSecretTokenMaterialOffline00001';
    const written = writeMessagingWebObservations({
      obsDir: '/virtual/observations/messaging',
      projectId: 'demo-project',
      senderId: '123456789012',
      fbSdkVersion: '12.19.0',
      adminSdkVersion: '13.10.0',
      initialToken: secretToken,
      writeTokenShape: false,
      results: {
        offlineStoreAndForward: {
          onlineBaselineDelivered: true,
          tokenPreservedAcrossOfflineRestart: true,
          nonCollapsibleQueuedDeliveredOnReconnect: true,
          collapsibleFirstDelivered: false,
          collapsibleSecondDelivered: true,
          collapsibleReplacedOlderPending: true,
          expiredShortTtlDelivered: false,
          expiredShortTtlDroppedBeforeReconnect: true,
          cleanupTokenDeletedTruthy: true,
        },
      },
      log: () => {},
      writeFile: (path, content) => {
        files.set(path, content);
      },
    });

    expect(written).toEqual(['messaging-web-offline-store-and-forward']);
    const raw = files.get(
      '/virtual/observations/messaging/messaging-web-offline-store-and-forward.json',
    );
    expect(raw).toBeDefined();
    expect(raw?.includes(secretToken)).toBe(false);
    const parsed = JSON.parse(raw!);
    expect(parsed.rowIds).toEqual(['messaging-admin#42']);
    expect(parsed.fbSdkVersion).toBe('12.19.0');
    expect(parsed.adminSdkVersion).toBe('13.10.0');
    expect(parsed.behavior.collapsibleReplacedOlderPending).toBe(true);
    expect(parsed.behavior.expiredShortTtlDroppedBeforeReconnect).toBe(true);
  });

  test('bindMessagingBehaviorRow resolves SUITE[messaging-admin] for conforming and diverged-documented flips', () => {
    const buildAdminBehaviorRow = bindMessagingBehaviorRow(adminBehaviorSection);
    const conformingRow = buildAdminBehaviorRow({
      order: 99,
      featureKeys: ['send'],
      api: 'Synthetic conforming admin behavior row',
      behavior: 'Matches production.',
      evidence: 'oracle: synthetic',
      observations: ['messaging-send-topic-accepted'],
      flipped: 'oracle-backed',
    }).build('99');
    expect(conformingRow.surface).toBe('messaging-admin');
    expect(conformingRow.status).toBe('conforms');
    expect(conformingRow.automation).toBe('oracle-backed');
    expect(conformingRow.conformanceTests).toEqual([SUITE['messaging-admin']]);

    const divergedRow = buildAdminBehaviorRow({
      order: 100,
      featureKeys: ['send'],
      api: 'Synthetic diverged admin behavior row',
      behavior: 'Documents in-memory transport vs HTTP retry.',
      evidence: 'oracle: synthetic',
      observations: ['messaging-send-topic-accepted'],
      flipped: 'diverged-oracle-backed',
    }).build('100');
    expect(divergedRow.surface).toBe('messaging-admin');
    expect(divergedRow.status).toBe('diverged-documented');
    expect(divergedRow.automation).toBe('oracle-backed');
    expect(divergedRow.conformanceTests).toEqual([SUITE['messaging-admin']]);
  });
});
