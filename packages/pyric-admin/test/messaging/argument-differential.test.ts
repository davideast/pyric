/**
 * Generative `firebase-admin/messaging` vs `pyric-admin/messaging` argument
 * differential suite across both local and remote sandbox arms.
 *
 * Drives every public `pyric-admin/messaging` entrypoint (`getMessaging`,
 * `messaging`, `enableLegacyHttpTransport`, `send`, `sendEach`,
 * `sendEachForMulticast`, `subscribeToTopic`, `unsubscribeFromTopic`) with
 * combinator-generated invalid and boundary arguments and compares acceptance
 * and error classification against the real installed `firebase-admin/messaging`
 * SDK running offline.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  deleteApp as deleteUpstreamApp,
  getApps as getUpstreamApps,
  initializeApp as initializeUpstreamApp,
} from 'firebase-admin/app';
import { getMessaging as getUpstreamMessaging } from 'firebase-admin/messaging';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from 'pyric-admin/app';
import { getMessaging } from 'pyric-admin/messaging';

import {
  emitTypeWrongnessCandidates,
  generateMethodArgumentCases,
  type CandidateValue,
  type GeneratedArgumentCase,
} from '../argument-generator/argument-combinators.js';
import {
  buildMessagingMethodSchemas,
  createMessagingArm,
} from './messaging-argument-schemas.js';
import {
  captureOutcome,
  createOfflineUpstreamMessagingHarness,
  isDocumentedWireVsClientMessageCodeDiff,
  type NormalizedCallOutcome,
} from './upstream-messaging-oracle.js';

function invokeAppAccessor(
  accessor: (app?: never) => unknown,
  candidate: CandidateValue,
): unknown {
  if (candidate.label === 'undefined') {
    return accessor();
  }
  return accessor(candidate.build() as never);
}

function isMessageRejectedEvent(event: SandboxEvent): boolean {
  if (event.kind !== 'service_mutation') return false;
  return event.service === 'messaging' && event.op === 'message_rejected';
}

function countMessageRejectedEvents(events: readonly SandboxEvent[]): number {
  return events.filter(isMessageRejectedEvent).length;
}

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function compareOutcomes(
  contextLabel: string,
  rawArgs: readonly unknown[],
  upstream: NormalizedCallOutcome,
  pyric: NormalizedCallOutcome,
): string | null {
  if (upstream.accepted !== pyric.accepted) {
    return `${contextLabel}: acceptance mismatch (upstream=${upstream.accepted} code=${upstream.code ?? upstream.errorKind}, pyric=${pyric.accepted} code=${pyric.code ?? pyric.errorKind})`;
  }

  if (!upstream.accepted && !pyric.accepted) {
    if (upstream.errorKind === 'TypeError' && pyric.errorKind === 'TypeError') {
      return null;
    }
    if (upstream.code !== undefined && upstream.code === pyric.code) {
      return null;
    }
    if (
      contextLabel.startsWith('send:') &&
      isDocumentedWireVsClientMessageCodeDiff(rawArgs[0], upstream, pyric)
    ) {
      return null;
    }
    return `${contextLabel}: error mismatch (upstream=${upstream.errorKind}:${upstream.code}, pyric=${pyric.errorKind}:${pyric.code})`;
  }

  if (upstream.batchSummary !== undefined && pyric.batchSummary !== undefined) {
    if (
      upstream.batchSummary.successCount !== pyric.batchSummary.successCount ||
      upstream.batchSummary.failureCount !== pyric.batchSummary.failureCount
    ) {
      return `${contextLabel}: batch count mismatch (upstream=${JSON.stringify(upstream.batchSummary)}, pyric=${JSON.stringify(pyric.batchSummary)})`;
    }
    const rawBatchItems = Array.isArray(rawArgs[0]) ? rawArgs[0] : [];
    for (let idx = 0; idx < upstream.batchSummary.itemOutcomes.length; idx++) {
      const uItem = upstream.batchSummary.itemOutcomes[idx];
      const pItem = pyric.batchSummary.itemOutcomes[idx];
      if (uItem === undefined || pItem === undefined) {
        return `${contextLabel}: batch length mismatch at index ${idx}`;
      }
      if (uItem.success !== pItem.success) {
        return `${contextLabel}[${idx}]: item success mismatch (upstream=${uItem.success}, pyric=${pItem.success})`;
      }
      if (!uItem.success && !pItem.success && uItem.code !== pItem.code) {
        const rawItem = rawBatchItems[idx];
        if (!isDocumentedWireVsClientMessageCodeDiff(rawItem, uItem, pItem)) {
          return `${contextLabel}[${idx}]: item error mismatch (upstream=${uItem.errorKind}:${uItem.code}, pyric=${pItem.errorKind}:${pItem.code})`;
        }
      }
    }
  }

  if (upstream.topicSummary !== undefined && pyric.topicSummary !== undefined) {
    if (
      upstream.topicSummary.successCount !== pyric.topicSummary.successCount ||
      upstream.topicSummary.failureCount !== pyric.topicSummary.failureCount
    ) {
      return `${contextLabel}: topic count mismatch (upstream=${JSON.stringify(upstream.topicSummary)}, pyric=${JSON.stringify(pyric.topicSummary)})`;
    }
    for (let idx = 0; idx < upstream.topicSummary.errorCodes.length; idx++) {
      const uErr = upstream.topicSummary.errorCodes[idx];
      const pErr = pyric.topicSummary.errorCodes[idx];
      if (uErr?.index !== pErr?.index || uErr?.code !== pErr?.code) {
        return `${contextLabel}: topic error[${idx}] mismatch (upstream=${JSON.stringify(uErr)}, pyric=${JSON.stringify(pErr)})`;
      }
    }
  }

  return null;
}

afterEach(async () => {
  for (const app of getApps()) await deleteApp(app).catch(() => {});
  for (const app of getUpstreamApps()) await deleteUpstreamApp(app).catch(() => {});
});

describe('generative Admin Messaging argument differential: getMessaging', () => {
  it('matches firebase-admin across all generated app-handle wrong types, no-app, default-app, and deleted-app states', async () => {
    const mismatches: string[] = [];

    for (const candidate of emitTypeWrongnessCandidates()) {
      const uGet = await captureOutcome(() =>
        invokeAppAccessor(getUpstreamMessaging as (app?: never) => unknown, candidate),
      );
      const pGet = await captureOutcome(() =>
        invokeAppAccessor(getMessaging as (app?: never) => unknown, candidate),
      );

      const getDiff = compareOutcomes(
        `getMessaging(${candidate.label})`,
        [candidate.value],
        uGet,
        pGet,
      );
      if (getDiff !== null) mismatches.push(getDiff);
    }

    const defaultUpstream = initializeUpstreamApp({ projectId: 'demo-project' });
    const sandbox = initializeSandbox({ projectId: 'demo-project' });
    const defaultPyric = initializeApp({ sandbox, projectId: 'demo-project' });
    try {
      const uDef = await captureOutcome(() => getUpstreamMessaging());
      const pDef = await captureOutcome(() => getMessaging());
      const defDiff = compareOutcomes('getMessaging([DEFAULT])', [], uDef, pDef);
      if (defDiff !== null) mismatches.push(defDiff);
    } finally {
      await deleteUpstreamApp(defaultUpstream);
      await deleteApp(defaultPyric);
      sandbox.dispose();
    }

    const delSandbox = initializeSandbox({ projectId: 'demo-project' });
    const delUpstream = initializeUpstreamApp({ projectId: 'demo-project' }, 'deleted-upstream');
    const delPyric = initializeApp({ sandbox: delSandbox, projectId: 'demo-project' }, 'deleted-pyric');
    await deleteUpstreamApp(delUpstream);
    await deleteApp(delPyric);
    try {
      const uDel = await captureOutcome(() => getUpstreamMessaging(delUpstream));
      const pDel = await captureOutcome(() => getMessaging(delPyric));
      const delDiff = compareOutcomes('getMessaging(deletedApp)', [delPyric], uDel, pDel);
      if (delDiff !== null) mismatches.push(delDiff);
    } finally {
      delSandbox.dispose();
    }

    expect(mismatches).toEqual([]);
  });
});

for (const armKind of ['local', 'remote'] as const) {
  describe(`generative Admin Messaging argument differential (${armKind} sandbox arm)`, () => {
    async function assertMethodParity(
      selectCases: (
        schemas: ReturnType<typeof buildMessagingMethodSchemas>,
      ) => readonly GeneratedArgumentCase[],
      options: { requireBothPreflightLayers?: boolean } = {},
    ): Promise<void> {
      const arm = createMessagingArm(armKind);
      const tokenPool = [arm.activeToken, ...arm.mintTokens(1000)];
      const activeSet = new Set(tokenPool);
      const unregisteredSet = new Set([arm.unregisteredToken]);
      const upstream = createOfflineUpstreamMessagingHarness(activeSet, unregisteredSet);

      try {
        const schemas = buildMessagingMethodSchemas({
          activeToken: arm.activeToken,
          unregisteredToken: arm.unregisteredToken,
          tokenAt: (index) => tokenPool[index % tokenPool.length] ?? arm.activeToken,
        });

        const cases = selectCases(schemas);
        expect(cases.length).toBeGreaterThan(0);

        const mismatches: string[] = [];
        let sawPreflightRejected = false;
        let sawPreflightAccepted = false;

        for (const testCase of cases) {
          const upstreamArgs = testCase.buildArgs();
          const pyricArgs = testCase.buildArgs();

          upstream.resetTransportFlag();
          const upstreamFn = (upstream.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[
            testCase.methodName
          ];
          const pyricFn = (arm.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[
            testCase.methodName
          ];

          const uOutcome = await captureOutcome(
            () => upstreamFn?.apply(upstream.svc, upstreamArgs),
            upstream.didReachHttp,
          );
          const pOutcome = await captureOutcome(() => pyricFn?.apply(arm.svc, pyricArgs));

          if (uOutcome.acceptedPreflight === false) sawPreflightRejected = true;
          if (uOutcome.acceptedPreflight === true) sawPreflightAccepted = true;

          const diff = compareOutcomes(
            `${testCase.methodName}:${testCase.label}`,
            pyricArgs,
            uOutcome,
            pOutcome,
          );
          if (diff !== null) {
            mismatches.push(diff);
          }
        }

        expect(mismatches).toEqual([]);
        if (options.requireBothPreflightLayers === true) {
          expect(sawPreflightRejected).toBe(true);
          expect(sawPreflightAccepted).toBe(true);
        }
      } finally {
        await upstream.dispose();
        await arm.dispose();
      }
    }

    it('matches firebase-admin on enableLegacyHttpTransport', async () => {
      await assertMethodParity((schemas) =>
        generateMethodArgumentCases(schemas.enableLegacyHttpTransport),
      );
    });

    it('matches firebase-admin on send across generated targets, grammars, maps, and options', async () => {
      await assertMethodParity((schemas) => generateMethodArgumentCases(schemas.send), {
        requireBothPreflightLayers: true,
      });
    });

    it('matches firebase-admin on sendEach across batch cardinalities, wrong types, and item grammars', async () => {
      await assertMethodParity((schemas) => generateMethodArgumentCases(schemas.sendEach), {
        requireBothPreflightLayers: true,
      });
    });

    it('matches firebase-admin on sendEachForMulticast across token cardinalities, maps, and options', async () => {
      await assertMethodParity(
        (schemas) => generateMethodArgumentCases(schemas.sendEachForMulticast),
        { requireBothPreflightLayers: true },
      );
    });

    it('matches firebase-admin on subscribeToTopic across token cardinalities, types, and topic grammar', async () => {
      await assertMethodParity(
        (schemas) => generateMethodArgumentCases(schemas.subscribeToTopic),
        { requireBothPreflightLayers: true },
      );
    });

    it('matches firebase-admin on unsubscribeFromTopic across token cardinalities, types, and topic grammar', async () => {
      await assertMethodParity(
        (schemas) => generateMethodArgumentCases(schemas.unsubscribeFromTopic),
        { requireBothPreflightLayers: true },
      );
    });

    it('emits message_rejected onto sandbox.history() for wire rejections and checks dryRun before wire syntax', async () => {
      const arm = createMessagingArm(armKind);
      const upstream = createOfflineUpstreamMessagingHarness(new Set([arm.activeToken]));

      try {
        // 1. Non-boolean dryRun is rejected at client preflight before wire condition/token parsing.
        const badDryRunInputs = [
          { condition: "'t0'intopics" },
          { token: 'not-a-valid-token' },
        ];
        for (const msg of badDryRunInputs) {
          let upstreamMessage = '';
          let pyricMessage = '';
          upstream.resetTransportFlag();
          try {
            await upstream.svc.send(msg, 'not-bool' as never);
          } catch (err) {
            upstreamMessage = readErrorMessage(err);
          }
          expect(upstream.didReachHttp()).toBe(false);

          try {
            await arm.svc.send(msg, 'not-bool' as never);
          } catch (err) {
            pyricMessage = readErrorMessage(err);
          }
          expect(pyricMessage).toBe(upstreamMessage);
          expect(pyricMessage).toBe('dryRun must be a boolean');
        }
        expect(countMessageRejectedEvents(arm.history())).toBe(0);

        // 2. Wire-level rejections reach the broker and emit `message_rejected` events.
        const wireFaultMessages = [
          {} as never,
          { token: 'not-a-valid-token' },
          { condition: "'t0' in topics &&" },
          { topic: 'bad#topic' },
          { topic: 'alerts', webpush: { headers: { TTL: 'not-digits' } } },
          { topic: 'alerts', webpush: { headers: { ttl: '-1' } } },
          { topic: 'alerts', webpush: { headers: { ttl: 'abc' } } },
          { topic: 'alerts', data: { p: 'x'.repeat(5000) } },
        ];
        let expectedRejected = 0;
        for (const msg of wireFaultMessages) {
          await expect(arm.svc.send(msg)).rejects.toMatchObject({
            code: 'messaging/invalid-argument',
          });
          expectedRejected += 1;
          expect(countMessageRejectedEvents(arm.history())).toBe(expectedRejected);
        }

        for (const msg of [
          { topic: 'alerts', webpush: { headers: { ttl: '60' } } },
          { topic: 'alerts', webpush: { headers: { ttl: '-1' } } },
          { topic: 'alerts', webpush: { headers: { ttl: 'abc' } } },
        ]) {
          upstream.resetTransportFlag();
          const uOutcome = await captureOutcome(() => upstream.svc.send(msg), upstream.didReachHttp);
          const pOutcome = await captureOutcome(() => arm.svc.send(msg));
          expect(uOutcome.acceptedPreflight).toBe(true);
          expect(compareOutcomes('send:lowercase-ttl', [msg], uOutcome, pOutcome)).toBeNull();
          if (!pOutcome.accepted) {
            expectedRejected += 1;
          }
        }

        const batchRes = await arm.svc.sendEach([
          { condition: "'t0'intopics" },
          { token: 'not-a-valid-token' },
        ]);
        expect(batchRes.failureCount).toBe(2);
        expectedRejected += 2;
        expect(countMessageRejectedEvents(arm.history())).toBe(expectedRejected);
      } finally {
        await upstream.dispose();
        await arm.dispose();
      }
    });
  });
}
