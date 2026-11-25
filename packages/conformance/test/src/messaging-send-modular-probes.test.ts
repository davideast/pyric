import { describe, expect, test } from 'bun:test';
import { FirebaseMessagingError } from 'firebase-admin/messaging';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import { loadPendingRowLinkObservations } from '../../src/staged-captures.ts';
import { selectMessagingSendTargets } from '../../src/messaging-send-probes.ts';
import {
  extractMessagingErrorDetails,
  summarizeBatchResponse,
} from '../../src/messaging-send-probe-session.ts';
import {
  observeAdminEntryAccessors,
  probe as adminEntryAccessorsProbe,
} from '../../probes/messaging-admin/messaging-send-admin-entry-accessors.ts';
import {
  observeMultipleTargetsRejected,
  probe as multipleTargetsRejectedProbe,
} from '../../probes/messaging-admin/messaging-send-multiple-targets-rejected.ts';
import {
  observeSendEachMixedBatch,
  probe as sendEachMixedBatchProbe,
} from '../../probes/messaging-admin/messaging-send-sendeach-mixed-batch.ts';
import {
  observeSendEachValidationGuards,
  probe as sendEachValidationGuardsProbe,
} from '../../probes/messaging-admin/messaging-send-sendeach-validation-guards.ts';
import {
  observeMulticastBatch,
  probe as multicastBatchProbe,
} from '../../probes/messaging-admin/messaging-send-multicast-batch.ts';
import {
  observeLegacyHttpTransport,
  probe as legacyHttpTransportProbe,
} from '../../probes/messaging-admin/messaging-send-legacy-http-transport.ts';

function makeMessagingError(code: string, message: string): FirebaseMessagingError {
  const err = Object.create(FirebaseMessagingError.prototype) as FirebaseMessagingError;
  Object.defineProperties(err, {
    code: { value: code, enumerable: true },
    message: { value: message, enumerable: true },
    name: { value: 'FirebaseMessagingError', enumerable: true },
  });
  return err;
}

describe('modular messaging-send probes (Slice 2 family)', () => {
  test('registers all six row-linked probes under rig messaging-send with populated rowIds', async () => {
    const modular = await loadModularProbes('messaging-send');
    const ids = modular.map((entry) => entry.id);
    const expectedIds = [
      'messaging-send-admin-entry-accessors',
      'messaging-send-legacy-http-transport',
      'messaging-send-multicast-batch',
      'messaging-send-multiple-targets-rejected',
      'messaging-send-sendeach-mixed-batch',
      'messaging-send-sendeach-validation-guards',
    ];
    for (const id of expectedIds) {
      expect(ids).toContain(id);
    }

    const probes = [
      adminEntryAccessorsProbe,
      legacyHttpTransportProbe,
      multicastBatchProbe,
      multipleTargetsRejectedProbe,
      sendEachMixedBatchProbe,
      sendEachValidationGuardsProbe,
    ];
    for (const probeRecord of probes) {
      expect(probeRecord.rig).toBe('messaging-send');
      expect(probeRecord.pendingRowLink).toBeUndefined();
      expect(probeRecord.matrixRow.length).toBeGreaterThan(0);
      expect(probeRecord.rowIds.length).toBeGreaterThan(0);
      expect(probeRecord.description.length).toBeGreaterThan(20);
    }

    const pending = loadPendingRowLinkObservations();
    for (const id of expectedIds) {
      expect(pending.has(id)).toBe(false);
    }
  });

  test('selectMessagingSendTargets skips uncaptured pendingRowLink probes on unfiltered write runs and runs explicit --probe selectors', async () => {
    const modular = await loadModularProbes('messaging-send');
    const syntheticStaged = [
      ...modular,
      {
        id: 'messaging-send-synthetic-staged',
        surfaceDir: 'messaging-admin',
        filePath: 'packages/conformance/probes/messaging-admin/messaging-send-synthetic-staged.ts',
        probe: {
          ...multicastBatchProbe,
          pendingRowLink: true,
          matrixRow: '',
          rowIds: [],
        },
      },
      {
        id: 'messaging-send-synthetic-captured',
        surfaceDir: 'messaging-admin',
        filePath: 'packages/conformance/probes/messaging-admin/messaging-send-synthetic-captured.ts',
        probe: {
          ...multicastBatchProbe,
          pendingRowLink: true,
          matrixRow: '',
          rowIds: [],
        },
      },
    ];
    const unfilteredWrite = selectMessagingSendTargets({
      args: [],
      modularProbes: syntheticStaged,
      includeUncapturedStaged: false,
      observationExists: (name) => name === 'messaging-send-synthetic-captured',
    });
    const unfilteredNames = unfilteredWrite.map((target) => target.name);
    expect(unfilteredNames).toContain('messaging-send-topic-accepted');
    expect(unfilteredNames).toContain('messaging-send-multicast-batch');
    expect(unfilteredNames).toContain('messaging-send-synthetic-captured');
    expect(unfilteredNames).not.toContain('messaging-send-synthetic-staged');

    const previewAll = selectMessagingSendTargets({
      args: [],
      modularProbes: syntheticStaged,
      includeUncapturedStaged: true,
      observationExists: () => false,
    });
    expect(previewAll.map((target) => target.name)).toContain('messaging-send-synthetic-staged');

    const explicit = selectMessagingSendTargets({
      args: ['--probe', 'messaging-send-synthetic-staged'],
      modularProbes: syntheticStaged,
      includeUncapturedStaged: false,
      observationExists: () => false,
    });
    expect(explicit.map((target) => target.name)).toEqual(['messaging-send-synthetic-staged']);
  });

  test('extractMessagingErrorDetails and summarizeBatchResponse normalize resource names and error metadata', () => {
    const fcmErr = makeMessagingError(
      'messaging/invalid-argument',
      'Request contains an invalid argument.',
    );
    expect(extractMessagingErrorDetails(fcmErr)).toEqual({
      code: 'messaging/invalid-argument',
      message: 'Request contains an invalid argument.',
      isFirebaseMessagingError: true,
      name: 'FirebaseMessagingError',
    });

    const summary = summarizeBatchResponse(
      {
        successCount: 1,
        failureCount: 1,
        responses: [
          {
            success: true,
            messageId: 'projects/demo-project/messages/-4829104829104829104',
          },
          {
            success: false,
            error: fcmErr,
          },
        ],
      },
      'demo-project',
    );
    expect(summary).toEqual({
      successCount: 1,
      failureCount: 1,
      responseCount: 2,
      responses: [
        {
          index: 0,
          success: true,
          hasMessageId: true,
          nameFacts: {
            matchesProjectsMessagesFormat: true,
            projectSegmentMatchesProject: true,
          },
          hasError: false,
          error: null,
        },
        {
          index: 1,
          success: false,
          hasMessageId: false,
          nameFacts: null,
          hasError: true,
          error: {
            code: 'messaging/invalid-argument',
            message: 'Request contains an invalid argument.',
            isFirebaseMessagingError: true,
            name: 'FirebaseMessagingError',
          },
        },
      ],
    });
  });

  test('observeAdminEntryAccessors records default/named app resolution, caching, app getter, invalid-app guard, and dryRun send', async () => {
    const result = await observeAdminEntryAccessors({
      projectId: 'demo-project',
      dryRunTopicSend: async () => 'projects/demo-project/messages/-9912345',
    });
    expect(result.noDefaultAppThrows).toEqual({
      threw: true,
      code: 'app/no-app',
    });
    expect(result.defaultGetMessagingMatchesExplicit).toBe(true);
    expect(result.defaultGetMessagingMatchesNamespace).toBe(false);
    expect(result.defaultAppGetterMatchesDefaultApp).toBe(true);
    expect(result.namedGetMessagingMatchesNamespace).toBe(false);
    expect(result.namedAppGetterMatchesNamedApp).toBe(true);
    expect(result.namedDistinctFromDefault).toBe(true);
    expect(result.invalidAppArgument).toEqual({
      threw: true,
      errorName: 'TypeError',
    });
    expect(result.namedDryRunSend).toEqual({
      matchesProjectsMessagesFormat: true,
      projectSegmentMatchesProject: true,
    });
  });

  test('observeMultipleTargetsRejected records client preflight INVALID_PAYLOAD and wire oneof rejection parity', async () => {
    const result = await observeMultipleTargetsRejected({
      sendClient: async (msg) => {
        if ('topic' in msg && ('condition' in msg || 'token' in msg)) {
          throw makeMessagingError(
            'messaging/invalid-payload',
            'Exactly one of topic, token or condition is required',
          );
        }
        return 'projects/demo-project/messages/1';
      },
      errorEnvelopeParity: async () => ({
        status: 400,
        error: {
          code: 400,
          message: 'Must specify only one of token, topic or condition.',
          status: 'INVALID_ARGUMENT',
        },
        realStatus: 400,
        realSendEnvelopeIdentical: true,
      }),
    });
    expect(result.topicAndConditionClient.dryRun.code).toBe('messaging/invalid-payload');
    expect(result.tokenAndTopicClient.realSend.code).toBe('messaging/invalid-payload');
    expect(result.allThreeTargetsClient.dryRun.code).toBe('messaging/invalid-payload');
    expect(result.wireTopicAndCondition.status).toBe(400);
    expect(result.wireTopicAndCondition.realSendEnvelopeIdentical).toBe(true);
  });

  test('observeSendEachMixedBatch, observeSendEachValidationGuards, observeMulticastBatch, and observeLegacyHttpTransport record deterministic batch facts', async () => {
    const invalidTokenErr = makeMessagingError(
      'messaging/invalid-argument',
      'The registration token is not a valid FCM registration token',
    );
    const invalidPayloadErr = makeMessagingError(
      'messaging/invalid-payload',
      'Exactly one of topic, token or condition is required',
    );

    const mixedOutcome = await observeSendEachMixedBatch({
      projectId: 'demo-project',
      sendEach: async (_messages, dryRun) => {
        let id = 'projects/demo-project/messages/100';
        if (dryRun) {
          id = 'projects/demo-project/messages/-200';
        }
        return {
          successCount: 1,
          failureCount: 2,
          responses: [
            { success: true, messageId: id },
            { success: false, error: invalidTokenErr },
            { success: false, error: invalidPayloadErr },
          ],
        };
      },
    });
    expect(mixedOutcome.dryRun.successCount).toBe(1);
    expect(mixedOutcome.dryRun.failureCount).toBe(2);
    expect(mixedOutcome.dryRunMatchesRealSend).toBe(true);

    let networkCalls = 0;
    const guardsOutcome = await observeSendEachValidationGuards({
      sendEachRaw: async (messages, dryRun) => {
        if (!Array.isArray(messages) || messages.length === 0) {
          throw makeMessagingError('messaging/invalid-argument', 'messages must be a non-empty array');
        }
        if (messages.length > 500) {
          throw makeMessagingError(
            'messaging/invalid-argument',
            'messages list must not contain more than 500 items',
          );
        }
        if (dryRun !== undefined && typeof dryRun !== 'boolean') {
          throw makeMessagingError('messaging/invalid-argument', 'dryRun must be a boolean');
        }
        networkCalls += 1;
        return {
          successCount: 1,
          failureCount: 0,
          responses: [{ success: true, messageId: 'projects/demo-project/messages/1' }],
        };
      },
    });
    expect(networkCalls).toBe(0);
    expect(guardsOutcome.emptyArray.code).toBe('messaging/invalid-argument');
    expect(guardsOutcome.overMaxBatch501.code).toBe('messaging/invalid-argument');
    expect(guardsOutcome.nonBooleanDryRun.code).toBe('messaging/invalid-argument');

    const multicastOutcome = await observeMulticastBatch({
      projectId: 'demo-project',
      sendEachForMulticastRaw: async (message, _dryRun) => {
        if (message === null || typeof message !== 'object' || Array.isArray(message)) {
          throw makeMessagingError(
            'messaging/invalid-argument',
            'MulticastMessage must be a non-null object',
          );
        }
        const candidate = message as { tokens?: unknown };
        if (!Array.isArray(candidate.tokens) || candidate.tokens.length === 0) {
          throw makeMessagingError('messaging/invalid-argument', 'tokens must be a non-empty array');
        }
        if (candidate.tokens.length > 500) {
          throw makeMessagingError(
            'messaging/invalid-argument',
            'tokens list must not contain more than 500 items',
          );
        }
        return {
          successCount: 0,
          failureCount: 2,
          responses: [
            { success: false, error: invalidTokenErr },
            { success: false, error: invalidPayloadErr },
          ],
        };
      },
    });
    expect(multicastOutcome.mixedInvalidTokensDryRun.failureCount).toBe(2);
    expect(multicastOutcome.emptyTokensArray.code).toBe('messaging/invalid-argument');
    expect(multicastOutcome.overMaxTokens501.code).toBe('messaging/invalid-argument');

    const legacyOutcome = await observeLegacyHttpTransport({
      projectId: 'demo-project',
      runWithLegacyMessaging: async () => ({
        enableReturnIsUndefined: true,
        batch: {
          successCount: 1,
          failureCount: 1,
          responses: [
            { success: true, messageId: 'projects/demo-project/messages/42' },
            { success: false, error: invalidTokenErr },
          ],
        },
      }),
    });
    expect(legacyOutcome.enableReturnIsUndefined).toBe(true);
    expect(legacyOutcome.dryRunBatch.successCount).toBe(1);
    expect(legacyOutcome.dryRunBatch.failureCount).toBe(1);
  });
});
