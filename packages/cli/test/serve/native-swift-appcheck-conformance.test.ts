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
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { RtdbRulesJson } from '../../src/serve/init-payload.js';
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
const PROJECT_ID = 'demo-swift-appcheck';
const IOS_APP_ID = '1:424242424242:ios:swiftliveapp';
const SHARED_SERVICES_IOS_APP_ID = '1:424242424242:ios:sharedservices';

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

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const MAIN_RTDB_RULES: RtdbRulesJson = {
  rules: {
    users: {
      $uid: {
        profile: {
          '.read': 'auth != null && auth.uid === $uid',
          '.write': 'auth != null && auth.uid === $uid',
        },
      },
    },
  },
};

interface ObservedSwiftAppCheckTraffic {
  mintedStandardTokens: string[];
  mintedLimitedUseTokens: string[];
  attachedTokensByMethod: Map<string, string[]>;
}

async function startLiveSwiftAppCheckBridgeHost() {
  const bridge = createBridge({ serverLabel: 'swift-appcheck-live-host' });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const traffic: ObservedSwiftAppCheckTraffic = {
    mintedStandardTokens: [],
    mintedLimitedUseTokens: [],
    attachedTokensByMethod: new Map(),
  };
  const pendingMintKindById = new Map<string, 'standard' | 'limited'>();

  const hostedRuntime = await createHostedRuntime(
    {
      rules: FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: MAIN_RTDB_RULES,
      databaseRulesHash: null,
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      projectKey: 'swift-appcheck-live-host',
      permissive: false,
      appOptions: {
        projectId: PROJECT_ID,
        appId: IOS_APP_ID,
        databaseURL: `https://${PROJECT_ID}-default-rtdb.firebaseio.com`,
      },
      aiEngine: {
        kind: 'scripted',
        script: [{ text: 'swift-app-check-verified' }],
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

  await hostedRuntime.deployRules('database', JSON.stringify(MAIN_RTDB_RULES));

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      if (inbound.type === 'worker-op') {
        const opRecord = inbound.op as Record<string, unknown>;
        const method = opRecord.method;
        if (method === 'appCheck.getToken') {
          pendingMintKindById.set(inbound.id, 'standard');
        } else if (method === 'appCheck.getLimitedUseToken') {
          pendingMintKindById.set(inbound.id, 'limited');
        }
        const attached = opRecord.appCheckToken;
        if (typeof method === 'string' && typeof attached === 'string') {
          let existing = traffic.attachedTokensByMethod.get(method);
          if (existing === undefined) {
            existing = [];
            traffic.attachedTokensByMethod.set(method, existing);
          }
          existing.push(attached);
        }
      }
      hostedRuntime.receive(inbound);
    },
    [],
    'swift-appcheck-sandbox-peer',
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

describe('native Swift App Check live-host conformance', () => {
  test('mints standard and limited-use iOS App Check JWTs over WebSocket verifiable by pyric-admin', async () => {
    const host = await startLiveSwiftAppCheckBridgeHost();
    const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
    const adminApp = initializeApp(
      { sandbox: verifySandbox, projectId: PROJECT_ID },
      `swift-appcheck-smoke-${Date.now()}`,
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
          clientSessionId: 'swift-appcheck-smoke',
          clientInfo: { platform: 'swift' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = async (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `swift-appcheck-op-${seq}`;
        const replyPromise = new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
        });
        socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        return replyPromise;
      };

      const firstRes = await sendOp({
        method: 'appCheck.getToken',
        appId: IOS_APP_ID,
        projectId: PROJECT_ID,
        provider: 'debug',
        forceRefresh: false,
      });
      expect(firstRes.ok).toBe(true);
      if (!firstRes.ok) {
        throw new Error('Expected appCheck.getToken to succeed');
      }
      const firstVal = firstRes.value as { token: string; expireTimeMillis: number };
      expect(firstVal.expireTimeMillis).toBeGreaterThan(Date.now() + 3_000_000);

      const cachedRes = await sendOp({
        method: 'appCheck.getToken',
        appId: IOS_APP_ID,
        projectId: PROJECT_ID,
        provider: 'debug',
        forceRefresh: false,
      });
      expect(cachedRes.ok).toBe(true);
      if (!cachedRes.ok) {
        throw new Error('Expected cached appCheck.getToken to succeed');
      }
      const cachedVal = cachedRes.value as { token: string };
      expect(cachedVal.token).toBe(firstVal.token);

      const refreshedRes = await sendOp({
        method: 'appCheck.getToken',
        appId: IOS_APP_ID,
        projectId: PROJECT_ID,
        provider: 'app-attest',
        forceRefresh: true,
      });
      expect(refreshedRes.ok).toBe(true);
      if (!refreshedRes.ok) {
        throw new Error('Expected forced appCheck.getToken to succeed');
      }
      const refreshedVal = refreshedRes.value as { token: string };
      expect(refreshedVal.token).not.toBe(firstVal.token);

      const verifiedStandard = await adminAppCheck.verifyToken(refreshedVal.token);
      expect(verifiedStandard.appId).toBe(IOS_APP_ID);
      expect(verifiedStandard.token.sub).toBe(IOS_APP_ID);
      expect(verifiedStandard.token.aud).toContain(`projects/${PROJECT_ID}`);

      // Attached appCheckToken satisfies AI Logic App Check gating on the worker host.
      const aiRes = await sendOp({
        method: 'ai.generateContent',
        model: 'gemini-2.5-flash',
        request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        appCheckToken: refreshedVal.token,
      });
      expect(aiRes.ok).toBe(true);

      const limitedRes = await sendOp({
        method: 'appCheck.getLimitedUseToken',
        appId: IOS_APP_ID,
        projectId: PROJECT_ID,
        provider: 'device-check',
      });
      expect(limitedRes.ok).toBe(true);
      if (!limitedRes.ok) {
        throw new Error('Expected appCheck.getLimitedUseToken to succeed');
      }
      const limitedVal = limitedRes.value as { token: string; expireTimeMillis: number };
      expect(limitedVal.expireTimeMillis).toBeLessThanOrEqual(Date.now() + 360_000);

      const firstConsume = await adminAppCheck.verifyToken(limitedVal.token, { consume: true });
      expect(firstConsume.appId).toBe(IOS_APP_ID);
      expect(firstConsume.alreadyConsumed).toBe(false);

      const secondConsume = await adminAppCheck.verifyToken(limitedVal.token, { consume: true });
      expect(secondConsume.alreadyConsumed).toBe(true);
    } finally {
      socket.terminate();
      await deleteApp(adminApp);
      verifySandbox.dispose();
      await host.close();
    }
  });

  test.skipIf(shouldSkipSwiftSubprocess)(
    'runs packages/swift-client PyricAppCheckTests over live WebSocket and verifies minted + attached JWTs via pyric-admin',
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

      const host = await startLiveSwiftAppCheckBridgeHost();
      const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
      const adminApp = initializeApp(
        { sandbox: verifySandbox, projectId: PROJECT_ID },
        `appcheck-swift-live-${Date.now()}`,
      );

      try {
        const childEnv: Record<string, string> = {
          ...baseEnv,
          PYRIC_LIVE_APPCHECK_BRIDGE_URL: host.bridgeUrl,
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
            'PyricAppCheckTests',
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

        // Verify every standard RS256 JWT minted by the Swift client with pyric-admin verifyToken().
        const adminAppCheck = getAppCheck(adminApp);
        expect(host.traffic.mintedStandardTokens.length).toBeGreaterThanOrEqual(5);
        for (const jwt of host.traffic.mintedStandardTokens) {
          const verified = await adminAppCheck.verifyToken(jwt);
          expect([IOS_APP_ID, SHARED_SERVICES_IOS_APP_ID]).toContain(verified.appId);
          expect(verified.token.aud).toContain(`projects/${PROJECT_ID}`);
        }

        // Verify limited-use token minted by Swift client enforces single-use replay protection.
        expect(host.traffic.mintedLimitedUseTokens.length).toBe(1);
        const limitedJwt = host.traffic.mintedLimitedUseTokens[0];
        if (limitedJwt === undefined) {
          throw new Error('Expected one limited-use token from Swift live-host suite');
        }
        const consumeFirst = await adminAppCheck.verifyToken(limitedJwt, { consume: true });
        expect(consumeFirst.appId).toBe(IOS_APP_ID);
        expect(consumeFirst.alreadyConsumed).toBe(false);
        const consumeReplay = await adminAppCheck.verifyToken(limitedJwt, { consume: true });
        expect(consumeReplay.alreadyConsumed).toBe(true);

        // Verify AI operations dispatched through opWithAppCheck carried valid App Check JWTs.
        const aiAttached = host.traffic.attachedTokensByMethod.get('ai.generateContent');
        expect(aiAttached).toBeDefined();
        if (aiAttached === undefined || aiAttached.length < 2) {
          throw new Error('Expected attached appCheckToken on both Swift ai.generateContent calls');
        }
        for (const attachedJwt of aiAttached) {
          const verifiedAttached = await adminAppCheck.verifyToken(attachedJwt);
          expect([IOS_APP_ID, SHARED_SERVICES_IOS_APP_ID]).toContain(verifiedAttached.appId);
        }
      } finally {
        await deleteApp(adminApp);
        verifySandbox.dispose();
        await host.close();
      }
    },
    SWIFT_LIVE_HOST_TEST_TIMEOUT_MS,
  );
});
