import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from 'pyric-admin/app';
import { getAppCheck } from 'pyric-admin/app-check';
import { WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY, type BridgeMessage, type WorkerResFrame } from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { RtdbRulesJson } from '../../src/serve/init-payload.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const KT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/kt-client');
const PROJECT_ID = 'demo-kotlin-ai';
const STANDARD_APP_ID = '1:424242424242:android:aistandardcheck';
const LIMITED_APP_ID = '1:424242424242:android:ailimitedcheck';
const LOCKED_FIRESTORE_RULES =
  "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }";
const LOCKED_RTDB_RULES: RtdbRulesJson = { rules: { '.read': false, '.write': false } };

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

function safetyBlockedEnvelope(finishMessage: string): Record<string, unknown> {
  return { candidates: [{ index: 0, finishReason: 'SAFETY', finishMessage, content: { role: 'model', parts: [] } }] };
}

function rawModelEnvelope(parts: Array<Record<string, unknown>>, usageMetadata?: Record<string, unknown>): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts } }],
  };
  if (usageMetadata !== undefined) {
    envelope.usageMetadata = usageMetadata;
  }
  return envelope;
}

const thoughtText = (text: string, thoughtSignature: string) => ({ text, thought: true, thoughtSignature });
const publicText = (text: string, thoughtSignature: string) => ({ text, thoughtSignature });
const INVERTED_SPECTRUM_B64 = Buffer.from(Uint8Array.from({ length: 256 }, (_v, idx) => 255 - idx)).toString('base64');
const SCRATCH_PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

type RawReqShape = {
  contents?: Array<{ parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string; displayName?: string } }> }>;
};

function buildKotlinAiScript(onMultimodalSpectrumSeen: () => void): Array<Record<string, unknown>> {
  return [
    { match: 'SMOKE_UNARY', respond: { text: 'smoke-unary-ok' } },
    { match: 'SMOKE_SAFETY_BLOCK', respond: safetyBlockedEnvelope('Smoke safety block.') },
    { match: 'SCRIPT_GREET', respond: { text: 'Kotlin AI Logic unary greeting verified!' } },
    { match: 'SCRIPT_FNCALL', respond: { functionCall: { name: 'lookupWeather', args: { city: 'Kyoto' } } } },
    { match: 'SCRIPT_FNRESULT', respond: { text: 'Kyoto is 19C and clear.' } },
    { match: 'SCRIPT_BLOCK_SAFETY', respond: safetyBlockedEnvelope('Candidate withheld by safety filter.') },
    { match: 'SCRIPT_BLOCK_PROMPT', respond: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } },
    { match: 'SCRIPT_ERR_QUOTA', respond: { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } } },
    { match: 'SCRIPT_ERR_APIKEY', respond: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } } },
    { match: 'SCRIPT_APPCHECK_STD', respond: { text: 'Standard App Check claim admitted!' } },
    { match: 'SCRIPT_APPCHECK_LIM_1', respond: { text: 'Limited-use App Check call 1 admitted!' } },
    { match: 'SCRIPT_APPCHECK_LIM_2', respond: { text: 'Limited-use App Check call 2 admitted!' } },
    { match: 'SCRIPT_STREAM_MULTI', respond: { chunks: ['Kotlin ', 'Flow ', 'stream!'] } },
    { match: 'SCRIPT_STREAM_CANCEL', respond: { chunks: ['first-cancel-chunk', 'second-never-seen', 'third-never-seen'] } },
    { match: 'SCRIPT_STREAM_ERR', respond: { error: { code: 429, message: 'Stream quota exceeded.', status: 'RESOURCE_EXHAUSTED' } } },
    { match: 'SCRIPT_CHAT_TURN_1', respond: { text: 'Nice to meet you, Ada! Your favorite language is Kotlin.' } },
    { match: 'SCRIPT_CHAT_BLOCKED', respond: safetyBlockedEnvelope('Blocked in chat.') },
    { match: 'SCRIPT_CHAT_TURN_2', respond: { chunks: ['Your name is Ada ', 'and you love Kotlin!'] } },
    { match: 'SCRIPT_CHAT_STREAM_CANCEL', respond: { chunks: ['partial-chat-chunk-1', 'partial-chat-chunk-2'] } },
    { match: 'SCRIPT_CHAT_FN', respond: { functionCall: { name: 'lookupWeather', args: { city: 'Reykjavik' } } } },
    { match: 'SCRIPT_CHAT_FN', respond: { text: 'Reykjavik is 4C and brisk!' } },
    {
      match: (req: RawReqShape) => {
        const parts = req.contents?.[0]?.parts ?? [];
        if (!parts.some((p) => typeof p.text === 'string' && p.text.includes('SCRIPT_HARDEN_MULTIMODAL'))) {
          return false;
        }
        const inline = parts.find((p) => p.inlineData !== undefined)?.inlineData;
        if (inline !== undefined && typeof inline.data === 'string' && inline.displayName === 'spectrum-256.png') {
          const decoded = Buffer.from(inline.data, 'base64');
          if (decoded.length === 256 && decoded.every((byte, idx) => byte === idx)) {
            onMultimodalSpectrumSeen();
          }
        }
        return true;
      },
      respond: rawModelEnvelope([
        { text: 'Inverted 256-byte spectrum attached.' },
        { inlineData: { mimeType: 'image/png', data: INVERTED_SPECTRUM_B64, displayName: 'inverted-256.png' } },
      ]),
    },
    {
      match: 'SCRIPT_HARDEN_THOUGHTS:',
      respond: rawModelEnvelope([
        thoughtText('Step 1: check divisibility. ', 'sig-live-t1'),
        { inlineData: { mimeType: 'image/png', data: SCRATCH_PNG_B64 }, thought: true, thoughtSignature: 'sig-live-timg' },
        thoughtText('Step 2: confirm 97 is prime.', 'sig-live-t2'),
        publicText('Prime factor is 97.', 'sig-live-ans'),
      ]),
    },
    { match: 'SCRIPT_HARDEN_THOUGHT_ONLY', respond: rawModelEnvelope([thoughtText('Internal deliberation with zero public text.', 'sig-live-silent')]) },
    { match: 'SCRIPT_HARDEN_THOUGHTS_TURN2', respond: { text: 'Verified product is 291.' } },
    {
      match: 'SCRIPT_HARDEN_USAGE',
      respond: rawModelEnvelope(
        [thoughtText('Deliberated across 27 reasoning tokens.', 'sig-live-usage-t'), publicText('Token breakdown verified.', 'sig-live-usage-a')],
        {
          promptTokenCount: 42,
          candidatesTokenCount: 19,
          thoughtsTokenCount: 27,
          cachedContentTokenCount: 8,
          toolUsePromptTokenCount: 5,
          totalTokenCount: 88,
          promptTokensDetails: [{ modality: 'TEXT', tokenCount: 14 }, { modality: 'IMAGE', tokenCount: 28 }],
          candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 19 }],
        },
      ),
    },
    {
      match: 'SCRIPT_HARDEN_STREAM_THOUGHT',
      respond: rawModelEnvelope(
        [thoughtText('Streamed hidden thought.', 'sig-stream-t'), publicText('Streamed public answer.', 'sig-stream-a')],
        { promptTokenCount: 10, candidatesTokenCount: 8, thoughtsTokenCount: 21, totalTokenCount: 39 },
      ),
    },
    {
      match: 'SCRIPT_HARDEN_CHAT_THOUGHT',
      respond: rawModelEnvelope(
        [thoughtText('Chat hidden reasoning.', 'sig-chat-t'), publicText('Chat public reply.', 'sig-chat-a')],
        { promptTokenCount: 9, candidatesTokenCount: 7, thoughtsTokenCount: 13, totalTokenCount: 29 },
      ),
    },
    { match: 'SCRIPT_CONC_FULL_1', respond: { chunks: ['full-1-a|', 'full-1-b|', 'full-1-c'] } },
    { match: 'SCRIPT_CONC_FULL_2', respond: { chunks: ['full-2-a|', 'full-2-b|', 'full-2-c'] } },
    { match: 'SCRIPT_CONC_FULL_3', respond: { chunks: ['full-3-a|', 'full-3-b|', 'full-3-c'] } },
    { match: 'SCRIPT_CONC_TAKE_1', respond: { chunks: ['take-1-first', 'take-1-never'] } },
    { match: 'SCRIPT_CONC_TAKE_2', respond: { chunks: ['take-2-first', 'take-2-never'] } },
    { match: 'SCRIPT_CONC_JOB_CANCEL', respond: { chunks: ['job-cancel-first', 'job-cancel-never'] } },
    { match: 'SCRIPT_CONC_EMPTY_CANDIDATES', respond: { promptFeedback: { safetyRatings: [] } } },
    {
      match: 'SCRIPT_CONC_CHAT_THOUGHT',
      respond: rawModelEnvelope([
        thoughtText('Internal chain of thought.', 'sig-conc-t'),
        publicText('Verified public answer.', 'sig-conc-a'),
      ]),
    },
  ];
}

function readClaimToken(rawClaim: unknown): string | null | undefined {
  if (rawClaim === undefined || rawClaim === null || typeof rawClaim !== 'object') {
    return undefined;
  }
  const tokenVal = (rawClaim as { token?: unknown }).token;
  if (typeof tokenVal === 'string' || tokenVal === null) {
    return tokenVal;
  }
  return undefined;
}

interface ObservedAiBridgeTraffic {
  aiOpModels: string[];
  aiStreamModels: string[];
  aiStreamSubIds: string[];
  aiStreamUnsubIds: string[];
  aiAppCheckClaims: Array<string | null>;
  aiStreamAppCheckClaims: Array<string | null>;
  mintedLimitedUseTokens: string[];
  verifiedInboundSpectrumCount: number;
}

async function startLiveAiBridgeHost() {
  const bridge = createBridge({ serverLabel: 'kotlin-ai-live-host' });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const traffic: ObservedAiBridgeTraffic = {
    aiOpModels: [],
    aiStreamModels: [],
    aiStreamSubIds: [],
    aiStreamUnsubIds: [],
    aiAppCheckClaims: [],
    aiStreamAppCheckClaims: [],
    mintedLimitedUseTokens: [],
    verifiedInboundSpectrumCount: 0,
  };
  const pendingLimitedMintIds = new Set<string>();

  const hostedRuntime = await createHostedRuntime(
    {
      rules: LOCKED_FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: LOCKED_RTDB_RULES,
      databaseRulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      projectKey: 'kotlin-ai-live-host',
      permissive: false,
      appOptions: { projectId: PROJECT_ID, appId: STANDARD_APP_ID },
      ai: { engine: { kind: 'scripted', script: buildKotlinAiScript(() => { traffic.verifiedInboundSpectrumCount += 1; }) } },
    },
    () => baseOrigin,
    (message) => {
      if (message.type === 'worker-res' && message.ok && pendingLimitedMintIds.has(message.id)) {
        pendingLimitedMintIds.delete(message.id);
        const payload = message.value as { token?: unknown } | null;
        if (payload !== null && typeof payload === 'object' && typeof payload.token === 'string') {
          traffic.mintedLimitedUseTokens.push(payload.token);
        }
      }
      bridge.handleSandboxMessage(message);
    },
    REPO_ROOT,
    { persistence: makeInMemoryHostedPersistence(), record: false },
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      if (inbound.type === 'worker-op') {
        const opRecord = inbound.op as Record<string, unknown>;
        const method = opRecord.method;
        if (method === 'appCheck.getLimitedUseToken') {
          pendingLimitedMintIds.add(inbound.id);
        }
        if (method === 'ai.generateContent' || method === 'ai.countTokens') {
          if (typeof opRecord.model === 'string') {
            traffic.aiOpModels.push(opRecord.model);
          }
          const opClaim = readClaimToken(opRecord.appCheck);
          if (opClaim !== undefined) {
            traffic.aiAppCheckClaims.push(opClaim);
          }
        }
      } else if (inbound.type === 'worker-sub') {
        const subRecord = inbound.sub as Record<string, unknown>;
        const target = subRecord.target;
        if (target !== undefined && target !== null && typeof target === 'object' && (target as { service?: unknown }).service === 'ai') {
          traffic.aiStreamSubIds.push(inbound.subId);
          if (typeof subRecord.model === 'string') {
            traffic.aiStreamModels.push(subRecord.model);
          }
          const subClaim = readClaimToken(subRecord.appCheck);
          if (subClaim !== undefined) {
            traffic.aiStreamAppCheckClaims.push(subClaim);
          }
        }
      } else if (inbound.type === 'worker-unsub' && traffic.aiStreamSubIds.includes(inbound.subId)) {
        traffic.aiStreamUnsubIds.push(inbound.subId);
      }
      hostedRuntime.receive(inbound);
    },
    [],
    'kotlin-ai-sandbox-peer',
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
    undefined,
    hostedRuntime.instanceId,
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
      for (const client of wss.clients) {
        client.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
      server.close();
      unregisterPeer();
      await hostedRuntime.close();
    },
  };
}

function detectCompatibleJavaMajor(): number | null {
  let javaBin = 'java';
  const javaHome = process.env.JAVA_HOME;
  if (typeof javaHome === 'string' && javaHome.length > 0) {
    const candidate = resolve(javaHome, 'bin/java');
    if (existsSync(candidate)) {
      javaBin = candidate;
    }
  }
  const probe = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
  if (probe.error !== undefined) {
    return null;
  }
  const combined = `${probe.stderr ?? ''}\n${probe.stdout ?? ''}`;
  const match = /version "(\d+)(?:[."]|$)/.exec(combined);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  if (Number.isNaN(major)) {
    return null;
  }
  return major;
}

function shouldSkipKotlinLiveGradleRun(env: Record<string, string | undefined>, javaMajor: number | null): boolean {
  if (env.PYRIC_REQUIRE_KOTLIN_LIVE === '1') {
    return false;
  }
  const isGenericCi = env.CI === 'true';
  const compatibleJdk = javaMajor !== null && javaMajor >= 21;
  return isGenericCi || !compatibleJdk;
}

function assertCleanJUnitXml(reportFileName: string, expectedTests: number): void {
  const xmlPath = resolve(KT_CLIENT_DIR, 'build/test-results/test', reportFileName);
  expect(existsSync(xmlPath)).toBe(true);
  const xml = readFileSync(xmlPath, 'utf8');
  expect(xml).toContain(`tests="${expectedTests}"`);
  expect(xml).toContain('skipped="0"');
  expect(xml).toContain('failures="0"');
  expect(xml).toContain('errors="0"');
}

function unwrapOkFrame(frame: WorkerResFrame, context: string): unknown {
  expect(frame.ok).toBe(true);
  if (!frame.ok) {
    throw new Error(`Expected ${context} to succeed`);
  }
  return frame.value;
}

const detectedJavaMajor = detectCompatibleJavaMajor();
const hasCompatibleJdk = detectedJavaMajor !== null && detectedJavaMajor >= 21;
const shouldSkipGradleRun = shouldSkipKotlinLiveGradleRun(process.env, detectedJavaMajor);

describe('native Kotlin AI Logic live-host conformance', () => {
  test('evaluates CI=true and JDK >= 21 skip predicate matching native-kotlin-appcheck-conformance', () => {
    expect(shouldSkipKotlinLiveGradleRun({ CI: 'true' }, 21)).toBe(true);
    expect(shouldSkipKotlinLiveGradleRun({ CI: 'true', PYRIC_REQUIRE_KOTLIN_LIVE: '1' }, 21)).toBe(false);
    expect(shouldSkipKotlinLiveGradleRun({}, 17)).toBe(true);
    expect(shouldSkipKotlinLiveGradleRun({}, null)).toBe(true);
    expect(shouldSkipKotlinLiveGradleRun({}, 21)).toBe(false);
  });

  test('serves scripted unary generateContent, countTokens, blocked candidates, and App Check gating over WebSocket', async () => {
    const host = await startLiveAiBridgeHost();
    const socket = new WebSocket(host.bridgeUrl);

    try {
      const replies = new Map<string, (frame: WorkerResFrame) => void>();
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
            handler(frame);
          }
        }
      });

      await once(socket, 'open');
      const ackPromise = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'kotlin-ai-smoke', clientInfo: { platform: 'kotlin' } } satisfies BridgeMessage));
      await ackPromise;

      let seq = 0;
      const sendOp = async (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `ai-op-${seq}`;
        const replyPromise = new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
        });
        socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        return replyPromise;
      };

      const minted = unwrapOkFrame(
        await sendOp({ method: 'appCheck.getToken', appId: STANDARD_APP_ID, projectId: PROJECT_ID, provider: 'debug', forceRefresh: false }),
        'appCheck.getToken',
      ) as { token: string };

      const genVal = unwrapOkFrame(
        await sendOp({
          method: 'ai.generateContent',
          model: 'models/gemini-2.5-flash',
          request: { contents: [{ role: 'user', parts: [{ text: 'SMOKE_UNARY: ping' }] }] },
          appCheck: { token: minted.token },
        }),
        'ai.generateContent',
      ) as { candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }> };
      expect(genVal.candidates[0]?.content.parts[0]?.text).toBe('smoke-unary-ok');
      expect(genVal.candidates[0]?.finishReason).toBe('STOP');

      const countVal = unwrapOkFrame(
        await sendOp({
          method: 'ai.countTokens',
          model: 'models/gemini-2.5-flash',
          request: { contents: [{ role: 'user', parts: [{ text: 'count these deterministic tokens' }] }] },
          appCheck: { token: minted.token },
        }),
        'ai.countTokens',
      ) as { totalTokens: number };
      expect(countVal.totalTokens).toBeGreaterThan(0);

      const blockedVal = unwrapOkFrame(
        await sendOp({
          method: 'ai.generateContent',
          model: 'models/gemini-2.5-flash',
          request: { contents: [{ role: 'user', parts: [{ text: 'SMOKE_SAFETY_BLOCK' }] }] },
        }),
        'safety-blocked generateContent',
      ) as { candidates: Array<{ finishReason?: string }> };
      expect(blockedVal.candidates[0]?.finishReason).toBe('SAFETY');

      const badAppCheckRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'SMOKE_UNARY: rejected' }] }] },
        appCheck: { token: 'invalid.appcheck.token' },
      });
      expect(badAppCheckRes.ok).toBe(false);
      if (badAppCheckRes.ok) {
        throw new Error('Expected invalid App Check claim to be rejected by AiBroker');
      }
      expect(badAppCheckRes.error.code).toBe('ai/UNAUTHENTICATED');
      expect(badAppCheckRes.error.message).toContain('Firebase App Check token is invalid.');
    } finally {
      socket.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipGradleRun)(
    'runs packages/kt-client AiLiveHostConformanceTest over OkHttp and verifies attached App Check JWTs via pyric-admin',
    async () => {
      if (!hasCompatibleJdk) {
        throw new Error(`PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK >= 21, detected: ${String(detectedJavaMajor)}`);
      }
      const host = await startLiveAiBridgeHost();
      const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
      const adminApp = initializeApp({ sandbox: verifySandbox, projectId: PROJECT_ID }, `ai-kt-live-${Date.now()}`);

      try {
        const gradleArgs = [
          resolve(KT_CLIENT_DIR, 'gradlew'),
          '-p',
          KT_CLIENT_DIR,
          ':cleanTest',
          ':test',
          '--tests',
          'dev.pyric.e2e.AiLiveHostConformanceTest',
          '--tests',
          'dev.pyric.e2e.AiLiveHostHardeningConformanceTest',
          '--tests',
          'dev.pyric.e2e.AiLiveHostConcurrencyConformanceTest',
          '--stacktrace',
          '--no-daemon',
        ];
        const proc = Bun.spawn(gradleArgs, {
          cwd: REPO_ROOT,
          env: { ...process.env, PYRIC_LIVE_AI_BRIDGE_URL: host.bridgeUrl, PYRIC_LIVE_BRIDGE_URL: host.bridgeUrl },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (exitCode !== 0) {
          throw new Error(`Gradle live-host AI tests exited ${exitCode}:\n${stdout}\n${stderr}`);
        }

        assertCleanJUnitXml('TEST-dev.pyric.e2e.AiLiveHostConformanceTest.xml', 6);
        assertCleanJUnitXml('TEST-dev.pyric.e2e.AiLiveHostHardeningConformanceTest.xml', 4);
        assertCleanJUnitXml('TEST-dev.pyric.e2e.AiLiveHostConcurrencyConformanceTest.xml', 2);

        expect(host.traffic.verifiedInboundSpectrumCount).toBe(1);
        expect(host.traffic.aiOpModels).toContain('models/gemini-2.5-flash');
        expect(host.traffic.aiOpModels).toContain('publishers/google/models/gemini-2.5-pro');
        expect(host.traffic.aiStreamModels).toContain('models/gemini-2.5-flash');
        expect(host.traffic.aiStreamSubIds.length).toBeGreaterThanOrEqual(14);
        expect(host.traffic.aiStreamUnsubIds.length).toBeGreaterThanOrEqual(5);

        expect(host.traffic.aiAppCheckClaims.length).toBe(5);
        expect(host.traffic.aiStreamAppCheckClaims.length).toBe(2);
        const validClaims = [...host.traffic.aiAppCheckClaims, ...host.traffic.aiStreamAppCheckClaims].filter(
          (tok): tok is string => typeof tok === 'string' && tok !== 'forged.unsigned.jwt',
        );
        expect(validClaims.length).toBe(6);

        const adminAppCheck = getAppCheck(adminApp);
        for (const jwt of validClaims) {
          const verified = await adminAppCheck.verifyToken(jwt);
          expect([STANDARD_APP_ID, LIMITED_APP_ID]).toContain(verified.appId);
          expect(verified.token.aud).toContain(`projects/${PROJECT_ID}`);
        }

        expect(host.traffic.mintedLimitedUseTokens.length).toBe(2);
        const lim1 = host.traffic.mintedLimitedUseTokens[0];
        const lim2 = host.traffic.mintedLimitedUseTokens[1];
        if (lim1 === undefined || lim2 === undefined) {
          throw new Error('Expected two minted limited-use tokens');
        }
        expect(lim1).not.toBe(lim2);
        const firstConsume = await adminAppCheck.verifyToken(lim1, { consume: true });
        expect(firstConsume.appId).toBe(LIMITED_APP_ID);
        expect(firstConsume.alreadyConsumed).toBe(false);
        const secondConsume = await adminAppCheck.verifyToken(lim1, { consume: true });
        expect(secondConsume.alreadyConsumed).toBe(true);
      } finally {
        await deleteApp(adminApp);
        verifySandbox.dispose();
        await host.close();
      }
    },
    180_000,
  );
});
