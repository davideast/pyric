import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../src/serve/init-payload.js';
import type { AiEngineConfigWire } from '../../src/serve/worker/protocol.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
export const FLUTTER_CLIENT_DIR = join(REPO_ROOT, 'packages/flutter-client');
export const PROJECT_ID = 'demo-flutter-ai-live';
export const FLUTTER_ANDROID_APP_ID = '1:424242424242:android:flutterailive';

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
    {
      match: 'FLUTTER_AI_MULTIMODAL_CANDIDATES',
      respond: {
        modelVersion: 'gemini-2.5-flash',
        responseId: 'resp-live-multi-1',
        candidates: [
          {
            index: 0,
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [
                { text: 'Analyzing 8-byte PNG header.', thought: true, thoughtSignature: 'sig-live-multi-thought' },
                { text: 'Primary caption.' },
                { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
              ],
            },
          },
          { index: 1, finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Secondary caption.' }] } },
        ],
        usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 14, thoughtsTokenCount: 5, totalTokenCount: 37 },
      },
    },
    {
      match: 'FLUTTER_AI_PERMISSION_ERR',
      respond: { error: { code: 403, message: 'Permission denied on project demo-flutter-ai-live.', status: 'PERMISSION_DENIED' } },
    },
    {
      match: 'FLUTTER_AI_UNAVAILABLE_ERR',
      respond: { error: { code: 503, message: 'Model backend temporarily unavailable.', status: 'UNAVAILABLE' } },
    },
    { match: 'FLUTTER_AI_CONCURRENT_CANCEL_A', respond: { chunks: ['CancelA-1 ', 'CancelA-2 ', 'CancelA-3'] } },
    { match: 'FLUTTER_AI_CONCURRENT_COMPLETE_B', respond: { chunks: ['Parallel ', 'stream ', 'intact!'] } },
    {
      match: 'FLUTTER_AI_ERR_INVALID_KEY_DETAIL',
      respond: {
        error: {
          code: 400,
          message: 'Request credential rejected.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
        },
      },
    },
    {
      match: 'FLUTTER_AI_ERR_INVALID_KEY_MSG',
      respond: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
    },
    {
      match: 'FLUTTER_AI_ERR_DISABLED_DETAIL',
      respond: {
        error: {
          code: 403,
          message: 'Project service check failed.',
          status: 'PERMISSION_DENIED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }],
        },
      },
    },
    {
      match: 'FLUTTER_AI_ERR_DISABLED_MSG',
      respond: { error: { code: 403, message: 'Firebase AI Logic API has not been used in project demo.', status: 'PERMISSION_DENIED' } },
    },
    {
      match: 'FLUTTER_AI_ERR_LOCATION_DETAIL',
      respond: {
        error: {
          code: 400,
          message: 'Precondition check failed.',
          status: 'FAILED_PRECONDITION',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'USER_LOCATION_NOT_SUPPORTED', domain: 'googleapis.com' }],
        },
      },
    },
    {
      match: 'FLUTTER_AI_ERR_LOCATION_MSG',
      respond: { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } },
    },
    {
      match: 'FLUTTER_AI_ERR_DEADLINE_WIRE',
      respond: { error: { code: 504, message: 'Deadline expired before operation could complete.', status: 'DEADLINE_EXCEEDED' } },
    },
    {
      match: 'FLUTTER_AI_STREAM_ERR_LOCATION_DETAIL',
      respond: {
        error: {
          code: 400,
          message: 'Precondition check failed.',
          status: 'FAILED_PRECONDITION',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'USER_LOCATION_NOT_SUPPORTED', domain: 'googleapis.com' }],
        },
      },
    },
    {
      match: 'FLUTTER_AI_STREAM_ERR_QUOTA',
      respond: { error: { code: 429, message: 'Stream quota exhausted for model gemini-2.5-flash.', status: 'RESOURCE_EXHAUSTED' } },
    },
    {
      match: 'FLUTTER_AI_STREAM_SAFETY_BLOCK',
      respond: { candidates: [{ index: 0, finishReason: 'SAFETY', finishMessage: 'Stream blocked by safety filter.' }] },
    },
    {
      match: 'FLUTTER_AI_STREAM_RECITATION_BLOCK',
      respond: { candidates: [{ index: 0, finishReason: 'RECITATION', finishMessage: 'Stream blocked due to recitation.' }] },
    },
    { match: 'FLUTTER_AI_APPCHECK_STREAM_STD', respond: { chunks: ['Standard ', 'stream ', 'verified.'] } },
    { match: 'FLUTTER_AI_APPCHECK_STREAM_LIM', respond: { chunks: ['Limited ', 'stream ', 'verified.'] } },
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

export async function startLiveFlutterAiHost() {
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

export function detectFlutterBinary(): string | null {
  const fromPath = Bun.which('flutter');
  if (fromPath !== null) return fromPath;
  const home = homedir();
  const localBinCandidate = join(home, '.local/bin/flutter');
  if (existsSync(localBinCandidate)) return localBinCandidate;
  const localFlutterCandidate = join(home, '.local/flutter/bin/flutter');
  if (existsSync(localFlutterCandidate)) return localFlutterCandidate;
  return null;
}

export function shouldSkipLiveFlutterRun(
  flutterBinary: string | null,
  env: NodeJS.ProcessEnv,
): boolean {
  const requiresLive = env.PYRIC_REQUIRE_FLUTTER_LIVE === '1';
  if (requiresLive) return false;
  if (env.CI === 'true') return true;
  return flutterBinary === null;
}

export function summarizeFlutterMachineOutput(stdout: string): {
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
