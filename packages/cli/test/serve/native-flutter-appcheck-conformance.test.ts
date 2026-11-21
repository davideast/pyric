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

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const FLUTTER_CLIENT_DIR = join(REPO_ROOT, 'packages/flutter-client');
const PROJECT_ID = 'demo-flutter-appcheck-live';
const FLUTTER_ANDROID_APP_ID = '1:424242424242:android:flutterappcheck';
const FLUTTER_APPLE_APP_ID = '1:424242424242:ios:flutterappcheckios';

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

interface ObservedFlutterAppCheckTraffic {
  mintedStandardTokens: string[];
  mintedLimitedUseTokens: string[];
  attachedTokensByMethod: Map<string, string[]>;
}

async function startLiveFlutterAppCheckHost() {
  const bridge = createBridge({ serverLabel: 'flutter-appcheck-live-host' });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const traffic: ObservedFlutterAppCheckTraffic = {
    mintedStandardTokens: [],
    mintedLimitedUseTokens: [],
    attachedTokensByMethod: new Map<string, string[]>(),
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
      projectKey: 'flutter-appcheck-live-host',
      permissive: true,
      appOptions: {
        projectId: PROJECT_ID,
        appId: FLUTTER_ANDROID_APP_ID,
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
    'flutter-appcheck-sandbox-peer',
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

function detectFlutterBinary(): string | null {
  const fromPath = Bun.which('flutter');
  if (fromPath !== null) {
    return fromPath;
  }
  const home = homedir();
  const localBinCandidate = join(home, '.local/bin/flutter');
  if (existsSync(localBinCandidate)) {
    return localBinCandidate;
  }
  const localFlutterCandidate = join(home, '.local/flutter/bin/flutter');
  if (existsSync(localFlutterCandidate)) {
    return localFlutterCandidate;
  }
  return null;
}

const requireFlutterLive = process.env.PYRIC_REQUIRE_FLUTTER_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireFlutterLive;
const detectedFlutter = detectFlutterBinary();
const shouldSkipFlutterSubprocess = !requireFlutterLive && (isGenericCiShard || detectedFlutter === null);

describe('native Flutter App Check live-host conformance', () => {
  test('mints Flutter-scoped standard and limited-use RS256 App Check JWTs verifiable by pyric-admin', async () => {
    const host = await startLiveFlutterAppCheckHost();
    const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
    const adminApp = initializeApp(
      { sandbox: verifySandbox, projectId: PROJECT_ID },
      `flutter-appcheck-smoke-${Date.now()}`,
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
          clientSessionId: 'flutter-appcheck-smoke',
          clientInfo: { platform: 'flutter' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `fl-appcheck-${seq}`;
        return new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
          socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        });
      };

      const standardRes = await sendOp({
        method: 'appCheck.getToken',
        appId: FLUTTER_ANDROID_APP_ID,
        projectId: PROJECT_ID,
        provider: 'play-integrity',
        forceRefresh: false,
      });
      expect(standardRes.ok).toBe(true);
      const standardVal = standardRes.value as { token: string; expireTimeMillis: number };
      const verifiedStandard = await adminAppCheck.verifyToken(standardVal.token);
      expect(verifiedStandard.appId).toBe(FLUTTER_ANDROID_APP_ID);
      expect(verifiedStandard.token.aud).toContain(`projects/${PROJECT_ID}`);

      const limitedRes = await sendOp({
        method: 'appCheck.getLimitedUseToken',
        appId: FLUTTER_APPLE_APP_ID,
        projectId: PROJECT_ID,
        provider: 'app-attest',
      });
      expect(limitedRes.ok).toBe(true);
      const limitedVal = limitedRes.value as { token: string };
      const firstConsume = await adminAppCheck.verifyToken(limitedVal.token, { consume: true });
      expect(firstConsume.appId).toBe(FLUTTER_APPLE_APP_ID);
      expect(firstConsume.alreadyConsumed).toBe(false);
      const replayConsume = await adminAppCheck.verifyToken(limitedVal.token, { consume: true });
      expect(replayConsume.alreadyConsumed).toBe(true);
    } finally {
      socket.terminate();
      await deleteApp(adminApp);
      verifySandbox.dispose();
      await host.close();
    }
  });

  test.skipIf(shouldSkipFlutterSubprocess)(
    'runs packages/flutter-client app_check_live_host_test.dart and verifies every minted RS256 JWT via pyric-admin',
    async () => {
      if (detectedFlutter === null) {
        throw new Error('PYRIC_REQUIRE_FLUTTER_LIVE=1 is set, but `flutter` was not found.');
      }
      const host = await startLiveFlutterAppCheckHost();
      const verifySandbox = initializeSandbox({ projectId: PROJECT_ID });
      const adminApp = initializeApp(
        { sandbox: verifySandbox, projectId: PROJECT_ID },
        `flutter-appcheck-live-${Date.now()}`,
      );

      try {
        const childEnv: Record<string, string> = {};
        for (const [key, val] of Object.entries(process.env)) {
          if (val !== undefined) {
            childEnv[key] = val;
          }
        }
        const localBin = join(homedir(), '.local/bin');
        let currentPath = '';
        if (typeof childEnv.PATH === 'string') {
          currentPath = childEnv.PATH;
        }
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
          [detectedFlutter, 'test', '--no-pub', 'test/live_host/app_check_live_host_test.dart'],
          {
            cwd: FLUTTER_CLIENT_DIR,
            env: childEnv,
            stdout: 'pipe',
            stderr: 'pipe',
          },
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
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

        const adminAppCheck = getAppCheck(adminApp);
        expect(host.traffic.mintedStandardTokens.length).toBeGreaterThanOrEqual(4);
        for (const jwt of host.traffic.mintedStandardTokens) {
          const verified = await adminAppCheck.verifyToken(jwt);
          expect([FLUTTER_ANDROID_APP_ID, FLUTTER_APPLE_APP_ID]).toContain(verified.appId);
          expect(verified.token.aud).toContain(`projects/${PROJECT_ID}`);
        }

        expect(host.traffic.mintedLimitedUseTokens.length).toBe(1);
        const limitedJwt = host.traffic.mintedLimitedUseTokens[0];
        if (limitedJwt === undefined) {
          throw new Error('Expected one limited-use token from Flutter App Check live-host test');
        }
        const consumeFirst = await adminAppCheck.verifyToken(limitedJwt, { consume: true });
        expect(consumeFirst.appId).toBe(FLUTTER_ANDROID_APP_ID);
        expect(consumeFirst.alreadyConsumed).toBe(false);
        const consumeReplay = await adminAppCheck.verifyToken(limitedJwt, { consume: true });
        expect(consumeReplay.alreadyConsumed).toBe(true);

        const aiAttachedTokens = host.traffic.attachedTokensByMethod.get('ai.generateContent');
        expect(aiAttachedTokens?.length).toBe(1);
        const attachedAiJwt = aiAttachedTokens?.[0];
        if (attachedAiJwt === undefined) {
          throw new Error('Expected opWithAppCheck to attach appCheckToken on ai.generateContent');
        }
        const verifiedAttached = await adminAppCheck.verifyToken(attachedAiJwt);
        expect(verifiedAttached.appId).toBe(FLUTTER_ANDROID_APP_ID);
      } finally {
        await deleteApp(adminApp);
        verifySandbox.dispose();
        await host.close();
      }
    },
    180_000,
  );
});
