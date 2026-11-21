import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
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
  type WorkerSnapFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import {
  SWIFT_LIVE_HOST_SCRATCH_SUBPATH,
  SWIFT_LIVE_HOST_TEST_TIMEOUT_MS,
  SWIFT_TEST_TIMEOUT_MS,
  buildSwiftLiveHostTests,
  collectProcessEnv,
  formatSubprocessFailure,
  runManagedSubprocess,
} from './swift-live-host-subprocess.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const SWIFT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/swift-client');
const PROJECT_ID = 'demo-swift-ai';
const IOS_APP_ID = '1:424242424242:ios:swiftaiclient';

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

interface ObservedSwiftAiTraffic {
  mintedStandardTokens: string[];
  mintedLimitedUseTokens: string[];
  unaryModels: string[];
  streamModels: string[];
  attachedAiTokens: string[];
  unsubIds: string[];
}

async function startLiveSwiftAiBridgeHost() {
  const bridge = createBridge({ serverLabel: 'swift-ai-live-host' });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const traffic: ObservedSwiftAiTraffic = {
    mintedStandardTokens: [],
    mintedLimitedUseTokens: [],
    unaryModels: [],
    streamModels: [],
    attachedAiTokens: [],
    unsubIds: [],
  };
  const pendingMintKindById = new Map<string, 'standard' | 'limited'>();

  const hostedRuntime = await createHostedRuntime(
    {
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
      projectKey: 'swift-ai-live-host',
      permissive: true,
      appOptions: {
        projectId: PROJECT_ID,
        appId: IOS_APP_ID,
      },
      ai: {
        engine: {
          kind: 'scripted',
          script: [
          {
            match: 'LIVE_THOUGHT_PROMPT',
            respond: {
              candidates: [
                {
                  index: 0,
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      { text: 'Reasoning on live host', thought: true },
                      { text: 'Verified live Swift answer' },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 9,
                candidatesTokenCount: 6,
                totalTokenCount: 15,
                promptTokensDetails: [{ modality: 'TEXT', tokenCount: 9 }],
              },
            },
          },
          {
            match: 'LIVE_FNCALL_PROMPT',
            respond: {
              functionCall: {
                name: 'getForecast',
                args: { city: 'Kyoto' },
              },
            },
          },
          {
            match: 'LIVE_FNCALL_PROMPT',
            respond: {
              text: 'Kyoto is Sunny 23C today.',
            },
          },
          {
            match: 'LIVE_STREAM_CHUNKS',
            respond: {
              chunks: ['Swift ', 'streaming ', 'works!'],
            },
          },
          {
            match: 'LIVE_SAFETY_BLOCK',
            respond: {
              candidates: [
                {
                  index: 0,
                  finishReason: 'SAFETY',
                  finishMessage: 'Blocked by safety filter',
                  content: {
                    role: 'model',
                    parts: [],
                  },
                },
              ],
            },
          },
          {
            match: 'LIVE_LIMITED_TOKEN_PROMPT',
            respond: {
              text: 'Limited-use token accepted',
            },
          },
        ],
        },
      },
    },
    () => baseOrigin,
    (message) => {
      if (message.type === 'worker-res' && message.ok) {
        const mintKind = pendingMintKindById.get(message.id);
        if (mintKind !== undefined) {
          pendingMintKindById.delete(message.id);
          const payload = message.value as { token?: unknown } | null;
          if (payload !== null && typeof payload === 'object' && typeof payload.token === 'string') {
            if (mintKind === 'standard') {
              traffic.mintedStandardTokens.push(payload.token);
            } else {
              traffic.mintedLimitedUseTokens.push(payload.token);
            }
          }
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
        if (method === 'appCheck.getToken') {
          pendingMintKindById.set(inbound.id, 'standard');
        } else if (method === 'appCheck.getLimitedUseToken') {
          pendingMintKindById.set(inbound.id, 'limited');
        } else if (method === 'ai.generateContent' || method === 'ai.countTokens') {
          if (typeof opRecord.model === 'string') {
            traffic.unaryModels.push(opRecord.model);
          }
          const appCheckObj = opRecord.appCheck as { token?: unknown } | undefined;
          if (appCheckObj !== undefined && typeof appCheckObj.token === 'string') {
            traffic.attachedAiTokens.push(appCheckObj.token);
          } else if (typeof opRecord.appCheckToken === 'string') {
            traffic.attachedAiTokens.push(opRecord.appCheckToken);
          }
        }
      } else if (inbound.type === 'worker-sub') {
        const subRecord = inbound.sub as Record<string, unknown>;
        const target = subRecord.target as { service?: unknown; op?: unknown } | undefined;
        if (target !== undefined && target.service === 'ai') {
          if (typeof subRecord.model === 'string') {
            traffic.streamModels.push(subRecord.model);
          }
          const appCheckObj = subRecord.appCheck as { token?: unknown } | undefined;
          if (appCheckObj !== undefined && typeof appCheckObj.token === 'string') {
            traffic.attachedAiTokens.push(appCheckObj.token);
          } else if (typeof subRecord.appCheckToken === 'string') {
            traffic.attachedAiTokens.push(subRecord.appCheckToken);
          }
        }
      } else if (inbound.type === 'worker-unsub') {
        traffic.unsubIds.push(inbound.subId);
      }
      hostedRuntime.receive(inbound);
    },
    [],
    'swift-ai-sandbox-peer',
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

function detectRunnableSwiftBinary(): string | null {
  const swiftBin = Bun.which('swift');
  if (swiftBin === null) {
    return null;
  }
  const probe = spawnSync(swiftBin, ['test', '--version'], { encoding: 'utf8' });
  if (probe.error !== undefined || probe.status !== 0) {
    return null;
  }
  return swiftBin;
}

const requireSwiftLive = process.env.PYRIC_REQUIRE_SWIFT_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireSwiftLive;
const detectedSwiftBinary = detectRunnableSwiftBinary();
const shouldSkipSwiftSubprocess =
  !requireSwiftLive && (isGenericCiShard || detectedSwiftBinary === null);

describe('native Swift Firebase AI Logic live-host conformance', () => {
  test('serves unary generateContent, countTokens, streamGenerateContent, and App Check gating over WebSocket', async () => {
    const host = await startLiveSwiftAiBridgeHost();
    const socket = new WebSocket(host.bridgeUrl);

    try {
      const replies = new Map<string, (frame: WorkerResFrame) => void>();
      const snapsBySub = new Map<string, Array<Record<string, unknown>>>();
      const doneWaiters = new Map<string, () => void>();

      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
            handler(frame);
          }
        } else if (frame.type === 'worker-snap') {
          const snap = frame as WorkerSnapFrame;
          let list = snapsBySub.get(snap.subId);
          if (list === undefined) {
            list = [];
            snapsBySub.set(snap.subId, list);
          }
          const val = snap.value as Record<string, unknown>;
          list.push(val);
          if (val.done === true || val.__error !== undefined) {
            const finish = doneWaiters.get(snap.subId);
            if (finish !== undefined) {
              finish();
            }
          }
        }
      });

      await once(socket, 'open');
      const ackPromise = once(socket, 'message');
      socket.send(
        JSON.stringify({
          type: 'attach',
          protocol: 1,
          clientSessionId: 'swift-ai-smoke',
          clientInfo: { platform: 'swift', deviceLabel: 'pyric-ai' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = async (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `swift-ai-op-${seq}`;
        const replyPromise = new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
        });
        socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        return replyPromise;
      };

      // Null App Check claim is rejected with HTTP 401 UNAUTHENTICATED
      const deniedRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'denied' }] }] },
        appCheck: { token: null },
      });
      expect(deniedRes.ok).toBe(false);
      if (!deniedRes.ok) {
        expect(deniedRes.error.code).toBe('ai/UNAUTHENTICATED');
        expect(deniedRes.error.message).toBe('Firebase App Check token is invalid.');
      }

      // Mint a valid sandbox App Check JWT and call unary + countTokens + streaming
      const mintRes = await sendOp({
        method: 'appCheck.getToken',
        appId: IOS_APP_ID,
        projectId: PROJECT_ID,
        provider: 'debug',
        forceRefresh: false,
      });
      expect(mintRes.ok).toBe(true);
      if (!mintRes.ok) {
        throw new Error('Expected appCheck.getToken to succeed');
      }
      const jwt = (mintRes.value as { token: string }).token;

      const thoughtRes = await sendOp({
        method: 'ai.generateContent',
        model: 'models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'LIVE_THOUGHT_PROMPT' }] }],
        },
        appCheck: { token: jwt },
        appCheckToken: jwt,
      });
      expect(thoughtRes.ok).toBe(true);

      const countRes = await sendOp({
        method: 'ai.countTokens',
        model: 'publishers/google/models/gemini-2.5-flash',
        request: {
          contents: [{ role: 'user', parts: [{ text: 'count swift tokens' }] }],
        },
        appCheck: { token: jwt },
      });
      expect(countRes.ok).toBe(true);
      if (countRes.ok) {
        const counted = countRes.value as { totalTokens: number };
        expect(counted.totalTokens).toBeGreaterThan(0);
      }

      const subId = 'swift-ai-sub-smoke-1';
      const streamDone = new Promise<void>((resolveDone) => {
        doneWaiters.set(subId, resolveDone);
      });
      socket.send(
        JSON.stringify({
          type: 'worker-sub',
          subId,
          sub: {
            target: { service: 'ai', op: 'streamGenerateContent' },
            model: 'models/gemini-2.5-flash',
            request: {
              contents: [{ role: 'user', parts: [{ text: 'LIVE_STREAM_CHUNKS' }] }],
            },
            appCheck: { token: jwt },
          },
        } as BridgeMessage),
      );
      await streamDone;
      const snaps = snapsBySub.get(subId);
      expect(snaps).toBeDefined();
      if (snaps !== undefined) {
        expect(snaps.length).toBe(4);
        expect(snaps[3]?.done).toBe(true);
      }
    } finally {
      socket.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipSwiftSubprocess)(
    'runs packages/swift-client PyricAITests over live WebSocket and verifies minted + attached App Check JWTs via pyric-admin',
    async () => {
      if (detectedSwiftBinary === null) {
        throw new Error('PYRIC_REQUIRE_SWIFT_LIVE=1 requires a runnable swift test toolchain.');
      }
      const swiftScratchDir = join(SWIFT_CLIENT_DIR, SWIFT_LIVE_HOST_SCRATCH_SUBPATH);
      const baseEnv = collectProcessEnv();
      const buildRun = await buildSwiftLiveHostTests({
        swiftBinary: detectedSwiftBinary,
        repoRoot: REPO_ROOT,
        swiftPackageDir: SWIFT_CLIENT_DIR,
        swiftScratchDir,
        env: baseEnv,
      });
      const buildDetails = formatSubprocessFailure('build', buildRun.attempt, buildRun.result);
      expect(buildRun.result.timedOut, buildDetails).toBe(false);
      expect(buildRun.result.exitCode, buildDetails).toBe(0);

      const host = await startLiveSwiftAiBridgeHost();
      const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
      const adminApp = initializeApp(
        { sandbox: verifySandbox, projectId: PROJECT_ID },
        `ai-swift-live-${Date.now()}`,
      );

      try {
        const childEnv: Record<string, string> = {
          ...baseEnv,
          PYRIC_LIVE_AI_BRIDGE_URL: host.bridgeUrl,
        };

        const testResult = await runManagedSubprocess({
          command: detectedSwiftBinary,
          args: [
            'test',
            '--skip-build',
            '--disable-xctest',
            '--disable-index-store',
            '-Xswiftc',
            '-gnone',
            '--no-parallel',
            '--package-path',
            SWIFT_CLIENT_DIR,
            '--scratch-path',
            swiftScratchDir,
            '--filter',
            'PyricAITests',
          ],
          cwd: REPO_ROOT,
          env: childEnv,
          timeoutMs: SWIFT_TEST_TIMEOUT_MS,
        });
        const combined = `${testResult.stdout}\n${testResult.stderr}`;
        const testDetails = formatSubprocessFailure('test', 1, testResult);
        expect(testResult.timedOut, testDetails).toBe(false);
        expect(testResult.exitCode, testDetails).toBe(0);
        expect(combined, testDetails).not.toContain('with 0 tests');

        expect(host.traffic.unaryModels).toContain('models/gemini-2.5-flash');
        expect(host.traffic.unaryModels).toContain('publishers/google/models/gemini-2.5-flash');
        expect(host.traffic.streamModels).toContain('models/gemini-2.5-flash');

        const adminAppCheck = getAppCheck(adminApp);
        expect(host.traffic.mintedStandardTokens.length).toBeGreaterThanOrEqual(1);
        expect(host.traffic.mintedLimitedUseTokens.length).toBeGreaterThanOrEqual(2);
        expect(host.traffic.attachedAiTokens.length).toBeGreaterThanOrEqual(6);

        for (const jwt of host.traffic.attachedAiTokens) {
          const verified = await adminAppCheck.verifyToken(jwt);
          expect(verified.appId).toBe(IOS_APP_ID);
          expect(verified.token.aud).toContain(`projects/${PROJECT_ID}`);
        }

        const firstLimited = host.traffic.mintedLimitedUseTokens[0];
        if (firstLimited === undefined) {
          throw new Error('Expected minted limited-use token from PyricAILiveHostTests');
        }
        const consumeFirst = await adminAppCheck.verifyToken(firstLimited, { consume: true });
        expect(consumeFirst.alreadyConsumed).toBe(false);
        const consumeSecond = await adminAppCheck.verifyToken(firstLimited, { consume: true });
        expect(consumeSecond.alreadyConsumed).toBe(true);
      } finally {
        await deleteApp(adminApp);
        verifySandbox.dispose();
        await host.close();
      }
    },
    SWIFT_LIVE_HOST_TEST_TIMEOUT_MS,
  );
});
