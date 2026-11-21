/**
 * Standalone live-host conformance suite for Flutter Firebase AI Logic
 * (`packages/flutter-client/lib/pyric_ai.dart`).
 *
 * Boots a loopback `HostedRuntime` with a deterministic scripted `AiBroker`
 * engine, verifies unary `ai.generateContent`, `ai.countTokens`, blocked
 * responses, and RS256 App Check token gating over WebSocket, and executes
 * `test/live_host/ai_live_host_test.dart` when Flutter is available.
 */
import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from 'pyric-admin/app';
import { getAppCheck } from 'pyric-admin/app-check';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../src/serve/init-payload.js';
import type { AiEngineConfigWire } from '../../src/serve/worker/protocol.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const FLUTTER_CLIENT_DIR = join(REPO_ROOT, 'packages/flutter-client');
const PROJECT_ID = 'demo-flutter-ai-live';
const FLUTTER_ANDROID_APP_ID = '1:424242424242:android:flutterailive';

const SCRIPTED_AI_ENGINE: AiEngineConfigWire = {
  kind: 'scripted',
  script: [
    { match: 'FLUTTER_AI_JSON_RECIPE', respond: { json: { dish: 'Matcha Pancakes', servings: 2 } } },
    {
      match: 'FLUTTER_AI_THOUGHT_AND_TOOL',
      respond: {
        modelVersion: 'gemini-2.5-flash',
        responseId: 'resp-live-tool-1',
        candidates: [{
          index: 0,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { text: 'Need current weather for Kyoto.', thought: true, thoughtSignature: 'sig-live-thought-1' },
              {
                functionCall: { name: 'getCurrentWeather', args: { city: 'Kyoto', unit: 'celsius' }, id: 'call-kyoto-1' },
                thoughtSignature: 'sig-live-fn-1',
              },
            ],
          },
        }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9, thoughtsTokenCount: 6, totalTokenCount: 27 },
      },
    },
    {
      match: 'FLUTTER_AI_SAFETY_BLOCK',
      respond: {
        candidates: [{
          index: 0,
          finishReason: 'SAFETY',
          finishMessage: 'Candidate blocked by safety filter.',
          safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }],
        }],
      },
    },
    {
      match: 'FLUTTER_AI_RECITATION_BLOCK',
      respond: {
        candidates: [{ index: 0, finishReason: 'RECITATION', finishMessage: 'Candidate blocked due to recitation.' }],
      },
    },
    {
      match: 'FLUTTER_AI_QUOTA_ERR',
      respond: { error: { code: 429, message: 'Quota exhausted for model gemini-2.5-flash.', status: 'RESOURCE_EXHAUSTED' } },
    },
    { match: 'FLUTTER_AI_STREAM_CHUNKS', respond: { chunks: ['Stream ', 'chunk ', 'complete!'] } },
    { match: 'FLUTTER_AI_STREAM_CANCEL', respond: { chunks: ['Alpha ', 'Beta ', 'Gamma'] } },
    { match: 'FLUTTER_AI_CHAT_TOOL_START', respond: { functionCall: { name: 'lookupStock', args: { ticker: 'GOOG' } } } },
    { match: 'FLUTTER_AI_CHAT_STREAM_TURN', respond: { chunks: ['GOOG trades ', 'at 198.25 USD.'] } },
    {
      match: 'FLUTTER_AI_CHAT_SAFETY_TURN',
      respond: { candidates: [{ index: 0, finishReason: 'SAFETY', finishMessage: 'Chat turn blocked.' }] },
    },
  ],
};

function makeInMemoryHostedPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
  };
}

interface ObservedFlutterAiTraffic {
  aiOpMethods: string[];
  aiSubCount: number;
  aiUnsubCount: number;
  attachedAppCheckTokens: Array<{ method: string; token: string | null }>;
}

function recordAiAppCheckClaim(
  traffic: ObservedFlutterAiTraffic,
  method: string,
  rawClaim: unknown,
): void {
  if (rawClaim === null || typeof rawClaim !== 'object') return;
  const claimRecord = rawClaim as { token?: unknown };
  if (typeof claimRecord.token === 'string') {
    traffic.attachedAppCheckTokens.push({ method, token: claimRecord.token });
  } else if (claimRecord.token === null) {
    traffic.attachedAppCheckTokens.push({ method, token: null });
  }
}

async function startLiveFlutterAiHost() {
  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const traffic: ObservedFlutterAiTraffic = {
    aiOpMethods: [],
    aiSubCount: 0,
    aiUnsubCount: 0,
    attachedAppCheckTokens: [],
  };

  const initPayload: InitPayload = {
    rules: null,
    rulesHash: null,
    databaseRules: null,
    databaseRulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    projectKey: 'flutter-ai-live-host',
    permissive: true,
    appOptions: { projectId: PROJECT_ID, appId: FLUTTER_ANDROID_APP_ID },
    ai: { engine: SCRIPTED_AI_ENGINE },
  };

  const hostedRuntime = await createHostedRuntime(
    initPayload,
    () => baseOrigin,
    (message) => bridge.handleSandboxMessage(message),
    REPO_ROOT,
    { persistence: makeInMemoryHostedPersistence() as never, record: false },
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      if (inbound.type === 'worker-op') {
        const opRecord = inbound.op as Record<string, unknown>;
        const method = opRecord.method;
        if (typeof method === 'string' && method.startsWith('ai.')) {
          traffic.aiOpMethods.push(method);
          recordAiAppCheckClaim(traffic, method, opRecord.appCheck);
        }
      } else if (inbound.type === 'worker-sub') {
        const subRecord = inbound.sub as Record<string, unknown>;
        const target = subRecord.target as { service?: unknown } | undefined;
        if (target !== undefined && target !== null && target.service === 'ai') {
          traffic.aiSubCount += 1;
          recordAiAppCheckClaim(traffic, 'ai.streamGenerateContent', subRecord.appCheck);
        }
      } else if (inbound.type === 'worker-unsub') {
        traffic.aiUnsubCount += 1;
      }
      hostedRuntime.receive(inbound);
    },
    [],
    hostedRuntime.instanceId,
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
  );

  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/__pyric/sandbox') {
      wss.handleUpgrade(req, socket, head, (ws) => attachPeer(bridge, ws, false));
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  baseOrigin = `http://127.0.0.1:${port}`;
  const bridgeUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;

  return {
    bridgeUrl,
    traffic,
    async close() {
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
      server.close();
      unregisterPeer();
      await hostedRuntime.close();
    },
  };
}

function detectFlutterBinary(): string | null {
  const fromPath = Bun.which('flutter');
  if (fromPath !== null) return fromPath;
  const home = homedir();
  const localBinCandidate = join(home, '.local/bin/flutter');
  if (existsSync(localBinCandidate)) return localBinCandidate;
  const localFlutterCandidate = join(home, '.local/flutter/bin/flutter');
  if (existsSync(localFlutterCandidate)) return localFlutterCandidate;
  return null;
}

function shouldSkipLiveFlutterRun(
  flutterBinary: string | null,
  env: NodeJS.ProcessEnv,
): boolean {
  const requiresLive = env.PYRIC_REQUIRE_FLUTTER_LIVE === '1';
  if (requiresLive) return false;
  if (env.CI === 'true') return true;
  return flutterBinary === null;
}

function summarizeFlutterMachineOutput(stdout: string): {
  passed: number;
  failed: number;
  skipped: number;
} {
  const namesById = new Map<number, string>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const rawLine of stdout.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const isTestStart =
      parsed.type === 'testStart' &&
      typeof parsed.test === 'object' &&
      parsed.test !== null;
    if (isTestStart) {
      const testObj = parsed.test as { id?: unknown; name?: unknown };
      if (typeof testObj.id === 'number' && typeof testObj.name === 'string') {
        namesById.set(testObj.id, testObj.name);
      }
      continue;
    }
    if (parsed.type !== 'testDone' || parsed.hidden === true) continue;
    let testName = '';
    if (typeof parsed.testID === 'number') {
      const recorded = namesById.get(parsed.testID);
      if (recorded !== undefined) testName = recorded;
    }
    if (testName.startsWith('loading ')) continue;
    if (parsed.skipped === true) skipped += 1;
    else if (parsed.result === 'success') passed += 1;
    else failed += 1;
  }
  return { passed, failed, skipped };
}

const detectedFlutter = detectFlutterBinary();
const skipFlutterSubprocess = shouldSkipLiveFlutterRun(
  detectedFlutter,
  process.env,
);

describe('native Flutter AI Logic live-host conformance', () => {
  test('HostedRuntime scripted AiBroker serves ai.generateContent, ai.countTokens, blocked responses, and App Check token enforcement over WebSocket', async () => {
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
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
            replies.delete(frame.id);
            handler(frame);
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

      const missingTokenRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        appCheck: { token: null },
      });
      expect(missingTokenRes.ok).toBe(false);
      expect(missingTokenRes.error?.code).toBe('ai/UNAUTHENTICATED');

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
    'runs packages/flutter-client test/live_host/ai_live_host_test.dart and verifies RS256 App Check claims on AI frames',
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
          [detectedFlutter, 'test', '--no-pub', '--machine', 'test/live_host/ai_live_host_test.dart'],
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
        expect(summary.passed, combined).toBeGreaterThanOrEqual(6);

        expect(host.traffic.aiOpMethods).toContain('ai.generateContent');
        expect(host.traffic.aiOpMethods).toContain('ai.countTokens');
        expect(host.traffic.aiSubCount).toBeGreaterThanOrEqual(3);
        expect(host.traffic.aiUnsubCount).toBeGreaterThanOrEqual(2);

        const nullClaims = host.traffic.attachedAppCheckTokens.filter(
          (entry) => entry.token === null,
        );
        expect(nullClaims.length).toBeGreaterThanOrEqual(1);

        const forgedClaims = host.traffic.attachedAppCheckTokens.filter(
          (entry) => entry.token === 'forged.invalid.jwt',
        );
        expect(forgedClaims.length).toBeGreaterThanOrEqual(1);

        const rs256Claims = host.traffic.attachedAppCheckTokens.filter(
          (entry): entry is { method: string; token: string } =>
            typeof entry.token === 'string' &&
            entry.token.split('.').length === 3 &&
            entry.token !== 'forged.invalid.jwt',
        );
        expect(rs256Claims.length).toBeGreaterThanOrEqual(3);

        const adminAppCheck = getAppCheck(adminApp);
        for (const entry of rs256Claims) {
          const verified = await adminAppCheck.verifyToken(entry.token);
          expect(verified.appId).toBe(FLUTTER_ANDROID_APP_ID);
          expect(verified.token.aud).toContain(`projects/${PROJECT_ID}`);
        }
      } finally {
        await deleteApp(adminApp);
        verifySandbox.dispose();
        await host.close();
      }
    },
    180_000,
  );
});
