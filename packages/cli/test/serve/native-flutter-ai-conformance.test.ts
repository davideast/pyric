/**
 * Standalone live-host conformance suite for Flutter Firebase AI Logic
 * (`packages/flutter-client/lib/pyric_ai.dart`).
 *
 * Boots a loopback `HostedRuntime` with a deterministic scripted `AiBroker`
 * engine, verifies unary and streaming AI operations, `google.rpc.ErrorInfo`
 * `aiEnvelope` propagation, retired-model 404 and deadline-exceeded 504
 * mapping, blocked candidates, and RS256 App Check token gating over WebSocket,
 * and executes the live-host Flutter suites when Flutter is available.
 */
import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from 'pyric-admin/app';
import { getAppCheck } from 'pyric-admin/app-check';
import type {
  BridgeMessage,
  WorkerResFrame,
  WorkerSnapFrame,
} from '../../src/bridge/protocol.js';
import {
  detectFlutterBinary,
  FLUTTER_ANDROID_APP_ID,
  FLUTTER_CLIENT_DIR,
  PROJECT_ID,
  shouldSkipLiveFlutterRun,
  startLiveFlutterAiHost,
  summarizeFlutterMachineOutput,
} from './native-flutter-ai-live-host-fixture.js';

const detectedFlutter = detectFlutterBinary();
const skipFlutterSubprocess = shouldSkipLiveFlutterRun(
  detectedFlutter,
  process.env,
);

interface RelayedAiEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ '@type'?: string; reason?: string }>;
  };
}

describe('native Flutter AI Logic live-host conformance', () => {
  test('HostedRuntime scripted AiBroker serves App Check gating, blocked candidates, and ErrorInfo aiEnvelope mapping over WebSocket', async () => {
    const host = await startLiveFlutterAiHost();
    const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
    const adminApp = initializeApp(
      { sandbox: verifySandbox, projectId: PROJECT_ID },
      `flutter-ai-wire-smoke-${Date.now()}`,
    );
    const socket = new WebSocket(host.bridgeUrl);

    try {
      const adminAppCheck = getAppCheck(adminApp);
      const replies = new Map<string, (frame: WorkerResFrame) => void>();
      const snapWaiters = new Map<string, (frame: WorkerSnapFrame) => void>();
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
            replies.delete(frame.id);
            handler(frame);
          }
        } else if (frame.type === 'worker-snap') {
          const snapHandler = snapWaiters.get(frame.subId);
          if (snapHandler !== undefined) {
            snapHandler(frame);
          }
        }
      });

      await once(socket, 'open');
      const ackPromise = once(socket, 'message');
      socket.send(
        JSON.stringify({
          type: 'attach',
          protocol: 1,
          clientSessionId: 'flutter-ai-wire-smoke',
          clientInfo: { platform: 'flutter' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `fl-ai-${seq}`;
        return new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
          socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        });
      };

      const collectStreamSnaps = (sub: Record<string, unknown>): Promise<unknown[]> => {
        seq += 1;
        const subId = `fl-ai-sub-${seq}`;
        return new Promise<unknown[]>((resolveSnaps) => {
          const collected: unknown[] = [];
          snapWaiters.set(subId, (snapFrame) => {
            collected.push(snapFrame.value);
            const valueRecord = snapFrame.value as Record<string, unknown> | null;
            const isTerminal =
              valueRecord !== null &&
              typeof valueRecord === 'object' &&
              (valueRecord.done === true || '__error' in valueRecord);
            if (isTerminal) {
              snapWaiters.delete(subId);
              resolveSnaps(collected);
            }
          });
          socket.send(JSON.stringify({ type: 'worker-sub', subId, sub } as BridgeMessage));
        });
      };

      const missingTokenRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        appCheck: { token: null },
      });
      expect(missingTokenRes.ok).toBe(false);
      expect(missingTokenRes.error?.code).toBe('ai/UNAUTHENTICATED');
      expect((missingTokenRes.error?.aiEnvelope as RelayedAiEnvelope | undefined)?.error?.code).toBe(401);

      const invalidTokenRes = await sendOp({
        method: 'ai.countTokens',
        model: 'models/gemini-2.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        appCheck: { token: 'invalid.jwt.payload' },
      });
      expect(invalidTokenRes.ok).toBe(false);
      expect(invalidTokenRes.error?.code).toBe('ai/UNAUTHENTICATED');

      const mintedRes = await sendOp({
        method: 'appCheck.getToken',
        appId: FLUTTER_ANDROID_APP_ID,
        projectId: PROJECT_ID,
        provider: 'play-integrity',
        forceRefresh: false,
      });
      expect(mintedRes.ok).toBe(true);
      const mintedVal = mintedRes.value as { token: string };
      const verifiedJwt = await adminAppCheck.verifyToken(mintedVal.token);
      expect(verifiedJwt.appId).toBe(FLUTTER_ANDROID_APP_ID);

      const limitedFirstRes = await sendOp({
        method: 'appCheck.getLimitedUseToken',
        appId: FLUTTER_ANDROID_APP_ID,
        projectId: PROJECT_ID,
        provider: 'play-integrity',
      });
      const limitedSecondRes = await sendOp({
        method: 'appCheck.getLimitedUseToken',
        appId: FLUTTER_ANDROID_APP_ID,
        projectId: PROJECT_ID,
        provider: 'play-integrity',
      });
      expect(limitedFirstRes.ok).toBe(true);
      expect(limitedSecondRes.ok).toBe(true);
      const limitedFirstToken = (limitedFirstRes.value as { token: string }).token;
      const limitedSecondToken = (limitedSecondRes.value as { token: string }).token;
      expect(limitedFirstToken).not.toBe(limitedSecondToken);
      expect((await adminAppCheck.verifyToken(limitedFirstToken)).token.jti).toBeDefined();

      const recipeRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Give FLUTTER_AI_JSON_RECIPE' }] }],
        },
        appCheck: { token: mintedVal.token },
      });
      expect(recipeRes.ok).toBe(true);
      const recipeEnvelope = recipeRes.value as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const recipeText = recipeEnvelope.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      expect(JSON.parse(recipeText)).toEqual({ dish: 'Matcha Pancakes', servings: 2 });

      const safetyRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Check FLUTTER_AI_SAFETY_BLOCK' }] }],
        },
        appCheck: { token: mintedVal.token },
      });
      expect(safetyRes.ok).toBe(true);
      const safetyEnvelope = safetyRes.value as {
        candidates?: Array<{ finishReason?: string }>;
      };
      expect(safetyEnvelope.candidates?.[0]?.finishReason).toBe('SAFETY');

      const retiredRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-1.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'Probe retired model' }] }] },
        appCheck: { token: mintedVal.token },
      });
      expect(retiredRes.ok).toBe(false);
      expect(retiredRes.error?.code).toBe('ai/NOT_FOUND');
      const retiredEnvelope = retiredRes.error?.aiEnvelope as RelayedAiEnvelope | undefined;
      expect(retiredEnvelope?.error?.code).toBe(404);
      expect(retiredEnvelope?.error?.details?.[0]?.reason).toBe('RETIRED_MODEL');

      const invalidKeyRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Probe FLUTTER_AI_ERR_INVALID_KEY_DETAIL' }] }],
        },
        appCheck: { token: mintedVal.token },
      });
      expect(invalidKeyRes.ok).toBe(false);
      const invalidKeyEnvelope = invalidKeyRes.error?.aiEnvelope as RelayedAiEnvelope | undefined;
      expect(invalidKeyEnvelope?.error?.details?.[0]?.reason).toBe('API_KEY_INVALID');

      const disabledRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Probe FLUTTER_AI_ERR_DISABLED_DETAIL' }] }],
        },
        appCheck: { token: mintedVal.token },
      });
      expect(disabledRes.ok).toBe(false);
      const disabledEnvelope = disabledRes.error?.aiEnvelope as RelayedAiEnvelope | undefined;
      expect(disabledEnvelope?.error?.details?.[0]?.reason).toBe('SERVICE_DISABLED');

      const locationRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Probe FLUTTER_AI_ERR_LOCATION_DETAIL' }] }],
        },
        appCheck: { token: mintedVal.token },
      });
      expect(locationRes.ok).toBe(false);
      const locationEnvelope = locationRes.error?.aiEnvelope as RelayedAiEnvelope | undefined;
      expect(locationEnvelope?.error?.status).toBe('FAILED_PRECONDITION');
      expect(locationEnvelope?.error?.details?.[0]?.reason).toBe('USER_LOCATION_NOT_SUPPORTED');

      const deadlineRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Probe FLUTTER_AI_ERR_DEADLINE_WIRE' }] }],
        },
        appCheck: { token: mintedVal.token },
      });
      expect(deadlineRes.ok).toBe(false);
      expect(deadlineRes.error?.code).toBe('ai/DEADLINE_EXCEEDED');
      expect((deadlineRes.error?.aiEnvelope as RelayedAiEnvelope | undefined)?.error?.code).toBe(504);

      const streamLocationSnaps = await collectStreamSnaps({
        target: { service: 'ai', op: 'streamGenerateContent' },
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'Probe FLUTTER_AI_STREAM_ERR_LOCATION_DETAIL' }] }],
        },
        appCheck: { token: mintedVal.token },
      });
      expect(streamLocationSnaps).toHaveLength(1);
      const streamErrRecord = (streamLocationSnaps[0] as { __error?: { aiEnvelope?: RelayedAiEnvelope } }).__error;
      expect(streamErrRecord?.aiEnvelope?.error?.details?.[0]?.reason).toBe('USER_LOCATION_NOT_SUPPORTED');

      const countRes = await sendOp({
        method: 'ai.countTokens',
        model: 'models/gemini-2.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'Count sample prompt' }] }] },
        appCheck: { token: mintedVal.token },
      });
      expect(countRes.ok).toBe(true);
      const countVal = countRes.value as { totalTokens?: number };
      expect(countVal.totalTokens).toBeGreaterThan(0);
    } finally {
      socket.terminate();
      await deleteApp(adminApp);
      verifySandbox.dispose();
      await host.close();
    }
  });

  test.skipIf(skipFlutterSubprocess)(
    'runs Flutter live-host AI suites and verifies RS256 App Check claims and ErrorInfo mapping',
    async () => {
      if (detectedFlutter === null) {
        throw new Error('PYRIC_REQUIRE_FLUTTER_LIVE=1 is set, but `flutter` was not found.');
      }
      const host = await startLiveFlutterAiHost();
      const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
      const adminApp = initializeApp(
        { sandbox: verifySandbox, projectId: PROJECT_ID },
        `flutter-ai-live-runner-${Date.now()}`,
      );

      try {
        const childEnv: Record<string, string> = {};
        for (const [key, val] of Object.entries(process.env)) {
          if (val !== undefined) childEnv[key] = val;
        }
        const localBin = join(homedir(), '.local/bin');
        let currentPath = '';
        if (typeof childEnv.PATH === 'string') currentPath = childEnv.PATH;
        if (currentPath.length > 0 && !currentPath.includes(localBin)) {
          childEnv.PATH = `${localBin}:${currentPath}`;
        } else if (currentPath.length === 0) {
          childEnv.PATH = localBin;
        }
        childEnv.PYRIC_LIVE_BRIDGE_URL = host.bridgeUrl;
        childEnv.PYRIC_LIVE_PROJECT_ID = PROJECT_ID;

        const packageConfigPath = join(FLUTTER_CLIENT_DIR, '.dart_tool/package_config.json');
        if (!existsSync(packageConfigPath)) {
          const pubGet = Bun.spawn([detectedFlutter, 'pub', 'get'], {
            cwd: FLUTTER_CLIENT_DIR,
            env: childEnv,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [pubOut, pubErr, pubExit] = await Promise.all([
            new Response(pubGet.stdout).text(),
            new Response(pubGet.stderr).text(),
            pubGet.exited,
          ]);
          expect(pubExit, `${pubOut}\n${pubErr}`).toBe(0);
        }

        const proc = Bun.spawn(
          [
            detectedFlutter,
            'test',
            '--no-pub',
            '--machine',
            'test/live_host/ai_live_host_test.dart',
            'test/live_host/ai_errors_and_app_check_live_host_test.dart',
          ],
          { cwd: FLUTTER_CLIENT_DIR, env: childEnv, stdout: 'pipe', stderr: 'pipe' },
        );
        const killTimer = setTimeout(() => proc.kill(), 180_000);
        let stdout = '';
        let stderr = '';
        let exitCode = -1;
        try {
          [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
        } finally {
          clearTimeout(killTimer);
          proc.kill();
        }
        const combined = `${stdout}\n${stderr}`;
        expect(exitCode, combined).toBe(0);

        const summary = summarizeFlutterMachineOutput(stdout);
        expect(summary.failed, combined).toBe(0);
        expect(summary.skipped, combined).toBe(0);
        expect(summary.passed, combined).toBeGreaterThanOrEqual(11);

        expect(host.traffic.aiOpMethods).toContain('ai.generateContent');
        expect(host.traffic.aiOpMethods).toContain('ai.countTokens');
        expect(host.traffic.aiSubCount).toBeGreaterThanOrEqual(11);
        expect(host.traffic.aiUnsubCount).toBeGreaterThanOrEqual(4);

        const nullClaims = host.traffic.attachedAppCheckTokens.filter(
          (entry) => entry.token === null,
        );
        expect(nullClaims.length).toBeGreaterThanOrEqual(2);

        const forgedClaims = host.traffic.attachedAppCheckTokens.filter(
          (entry) => entry.token === 'forged.invalid.jwt',
        );
        expect(forgedClaims.length).toBeGreaterThanOrEqual(2);

        const rs256Claims = host.traffic.attachedAppCheckTokens.filter(
          (entry): entry is { method: string; token: string } =>
            typeof entry.token === 'string' &&
            entry.token.split('.').length === 3 &&
            entry.token !== 'forged.invalid.jwt',
        );
        expect(rs256Claims.length).toBeGreaterThanOrEqual(5);

        const adminAppCheck = getAppCheck(adminApp);
        const limitedUseJtis = new Set<string>();
        for (const entry of rs256Claims) {
          const verified = await adminAppCheck.verifyToken(entry.token);
          expect(verified.appId).toBe(FLUTTER_ANDROID_APP_ID);
          expect(verified.token.aud).toContain(`projects/${PROJECT_ID}`);
          if (typeof verified.token.jti === 'string') {
            limitedUseJtis.add(verified.token.jti);
          }
        }
        expect(limitedUseJtis.size).toBeGreaterThanOrEqual(2);
      } finally {
        await deleteApp(adminApp);
        verifySandbox.dispose();
        await host.close();
      }
    },
    180_000,
  );
});
