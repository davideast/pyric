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
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { RtdbRulesJson } from '../../src/serve/init-payload.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const KT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/kt-client');
const PROJECT_ID = 'demo-kotlin-ai';
const STANDARD_APP_ID = '1:424242424242:android:aistandardcheck';
const LIMITED_APP_ID = '1:424242424242:android:ailimitedcheck';

const LOCKED_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

const LOCKED_RTDB_RULES: RtdbRulesJson = {
  rules: { '.read': false, '.write': false },
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

function buildKotlinAiScript(): Array<Record<string, unknown>> {
  return [
    {
      match: 'SMOKE_UNARY',
      respond: { text: 'smoke-unary-ok' },
    },
    {
      match: 'SMOKE_SAFETY_BLOCK',
      respond: {
        candidates: [
          {
            index: 0,
            finishReason: 'SAFETY',
            finishMessage: 'Smoke safety block.',
            content: { role: 'model', parts: [] },
          },
        ],
      },
    },
    {
      match: 'SCRIPT_GREET',
      respond: { text: 'Kotlin AI Logic unary greeting verified!' },
    },
    {
      match: 'SCRIPT_FNCALL',
      respond: {
        functionCall: {
          name: 'lookupWeather',
          args: { city: 'Kyoto' },
        },
      },
    },
    {
      match: 'SCRIPT_FNRESULT',
      respond: { text: 'Kyoto is 19C and clear.' },
    },
    {
      match: 'SCRIPT_BLOCK_SAFETY',
      respond: {
        candidates: [
          {
            index: 0,
            finishReason: 'SAFETY',
            finishMessage: 'Candidate withheld by safety filter.',
            content: { role: 'model', parts: [] },
          },
        ],
      },
    },
    {
      match: 'SCRIPT_BLOCK_PROMPT',
      respond: {
        promptFeedback: {
          blockReason: 'PROHIBITED_CONTENT',
        },
      },
    },
    {
      match: 'SCRIPT_ERR_QUOTA',
      respond: {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
    },
    {
      match: 'SCRIPT_ERR_APIKEY',
      respond: {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
        },
      },
    },
    {
      match: 'SCRIPT_APPCHECK_STD',
      respond: { text: 'Standard App Check claim admitted!' },
    },
    {
      match: 'SCRIPT_APPCHECK_LIM_1',
      respond: { text: 'Limited-use App Check call 1 admitted!' },
    },
    {
      match: 'SCRIPT_APPCHECK_LIM_2',
      respond: { text: 'Limited-use App Check call 2 admitted!' },
    },
  ];
}

interface ObservedAiBridgeTraffic {
  aiOpModels: string[];
  aiAppCheckClaims: Array<string | null>;
  mintedLimitedUseTokens: string[];
}

async function startLiveAiBridgeHost() {
  const bridge = createBridge({ serverLabel: 'kotlin-ai-live-host' });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const traffic: ObservedAiBridgeTraffic = {
    aiOpModels: [],
    aiAppCheckClaims: [],
    mintedLimitedUseTokens: [],
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
      appOptions: {
        projectId: PROJECT_ID,
        appId: STANDARD_APP_ID,
      },
      ai: {
        engine: {
          kind: 'scripted',
          script: buildKotlinAiScript(),
        },
      },
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
    {
      persistence: makeInMemoryHostedPersistence(),
      record: false,
    },
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      if (inbound.type === 'worker-op') {
        const opRecord = inbound.op as Record<string, unknown>;
        const method = opRecord.method;
        if (method === 'appCheck.getLimitedUseToken') {
          pendingLimitedMintIds.add(inbound.id);
        }
        const isAiOp = method === 'ai.generateContent' || method === 'ai.countTokens';
        if (isAiOp) {
          if (typeof opRecord.model === 'string') {
            traffic.aiOpModels.push(opRecord.model);
          }
          const rawClaim = opRecord.appCheck;
          if (rawClaim !== undefined && rawClaim !== null && typeof rawClaim === 'object') {
            const tokenVal = (rawClaim as { token?: unknown }).token;
            if (typeof tokenVal === 'string' || tokenVal === null) {
              traffic.aiAppCheckClaims.push(tokenVal);
            }
          }
        }
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
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachPeer(bridge, ws, false);
      });
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
  let combined = '';
  if (typeof probe.stderr === 'string') {
    combined += probe.stderr;
  }
  if (typeof probe.stdout === 'string') {
    combined += `\n${probe.stdout}`;
  }
  const match = /version "(\d+)(?:[."]|$)/.exec(combined);
  if (match === null) {
    return null;
  }
  const majorRaw = match[1];
  if (majorRaw === undefined) {
    return null;
  }
  const major = Number.parseInt(majorRaw, 10);
  if (Number.isNaN(major)) {
    return null;
  }
  return major;
}

const requireKotlinLive = process.env.PYRIC_REQUIRE_KOTLIN_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireKotlinLive;
const detectedJavaMajor = detectCompatibleJavaMajor();
const hasCompatibleJdk = detectedJavaMajor !== null && detectedJavaMajor >= 21;
const shouldSkipGradleRun = !requireKotlinLive && (isGenericCiShard || !hasCompatibleJdk);

describe('native Kotlin AI Logic live-host conformance', () => {
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
      socket.send(
        JSON.stringify({
          type: 'attach',
          protocol: 1,
          clientSessionId: 'kotlin-ai-smoke',
          clientInfo: { platform: 'kotlin' },
        } satisfies BridgeMessage),
      );
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

      const mintRes = await sendOp({
        method: 'appCheck.getToken',
        appId: STANDARD_APP_ID,
        projectId: PROJECT_ID,
        provider: 'debug',
        forceRefresh: false,
      });
      expect(mintRes.ok).toBe(true);
      if (!mintRes.ok) {
        throw new Error('Expected appCheck.getToken to succeed');
      }
      const minted = mintRes.value as { token: string };

      const genRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'SMOKE_UNARY: ping' }] }],
        },
        appCheck: { token: minted.token },
      });
      expect(genRes.ok).toBe(true);
      if (!genRes.ok) {
        throw new Error('Expected ai.generateContent to succeed with valid App Check token');
      }
      const genVal = genRes.value as {
        candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>;
      };
      expect(genVal.candidates[0]?.content.parts[0]?.text).toBe('smoke-unary-ok');
      expect(genVal.candidates[0]?.finishReason).toBe('STOP');

      const countRes = await sendOp({
        method: 'ai.countTokens',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'count these deterministic tokens' }] }],
        },
        appCheck: { token: minted.token },
      });
      expect(countRes.ok).toBe(true);
      if (!countRes.ok) {
        throw new Error('Expected ai.countTokens to succeed');
      }
      const countVal = countRes.value as { totalTokens: number };
      expect(countVal.totalTokens).toBeGreaterThan(0);

      const blockedRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'SMOKE_SAFETY_BLOCK' }] }],
        },
      });
      expect(blockedRes.ok).toBe(true);
      if (!blockedRes.ok) {
        throw new Error('Expected safety-blocked candidate envelope to return HTTP-200 shape');
      }
      const blockedVal = blockedRes.value as { candidates: Array<{ finishReason?: string }> };
      expect(blockedVal.candidates[0]?.finishReason).toBe('SAFETY');

      const badAppCheckRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'SMOKE_UNARY: rejected' }] }],
        },
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
        throw new Error(
          `PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK >= 21, detected: ${String(detectedJavaMajor)}`,
        );
      }
      const host = await startLiveAiBridgeHost();
      const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
      const adminApp = initializeApp(
        { sandbox: verifySandbox, projectId: PROJECT_ID },
        `ai-kt-live-${Date.now()}`,
      );

      try {
        const gradlew = resolve(KT_CLIENT_DIR, 'gradlew');
        const proc = Bun.spawn(
          [
            gradlew,
            '-p',
            KT_CLIENT_DIR,
            ':cleanTest',
            ':test',
            '--tests',
            'dev.pyric.e2e.AiLiveHostConformanceTest',
            '--stacktrace',
            '--no-daemon',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PYRIC_LIVE_AI_BRIDGE_URL: host.bridgeUrl,
              PYRIC_LIVE_BRIDGE_URL: host.bridgeUrl,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (exitCode !== 0) {
          throw new Error(
            `Gradle AiLiveHostConformanceTest exited ${exitCode}:\n${stdout}\n${stderr}`,
          );
        }

        const xmlReport = resolve(
          KT_CLIENT_DIR,
          'build/test-results/test/TEST-dev.pyric.e2e.AiLiveHostConformanceTest.xml',
        );
        expect(existsSync(xmlReport)).toBe(true);
        const xml = readFileSync(xmlReport, 'utf8');
        expect(xml).toContain('tests="3"');
        expect(xml).toContain('skipped="0"');
        expect(xml).toContain('failures="0"');
        expect(xml).toContain('errors="0"');

        // Verify both GoogleAI (`models/...`) and VertexAI (`publishers/google/models/...`) model paths arrived on the wire.
        expect(host.traffic.aiOpModels).toContain('models/gemini-2.5-flash');
        expect(host.traffic.aiOpModels).toContain('publishers/google/models/gemini-2.5-pro');

        // Verify attached App Check claims on AI ops: 2 standard + 2 limited-use + 1 forged refusal.
        expect(host.traffic.aiAppCheckClaims.length).toBe(5);
        const validClaims = host.traffic.aiAppCheckClaims.filter(
          (tok): tok is string => typeof tok === 'string' && tok !== 'forged.unsigned.jwt',
        );
        expect(validClaims.length).toBe(4);

        const adminAppCheck = getAppCheck(adminApp);
        for (const jwt of validClaims) {
          const verified = await adminAppCheck.verifyToken(jwt);
          expect([STANDARD_APP_ID, LIMITED_APP_ID]).toContain(verified.appId);
          expect(verified.token.aud).toContain(`projects/${PROJECT_ID}`);
        }

        // Verify both limited-use tokens were distinct single-use JWTs.
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
