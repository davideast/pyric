/**
 * Live-host Crashlytics conformance harness for the Swift client SDK
 * (`packages/swift-client/Sources/PyricCrashlytics`).
 *
 * Boots an in-memory loopback Pyric bridge host with `createHostedRuntime`,
 * verifies all 10 `crashlytics.*` wire operations (`setUserId`, `setCustomKeys`,
 * `log`, `recordError`, `setCollectionEnabled`, `checkForUnsentReports`,
 * `sendUnsentReports`, `deleteUnsentReports`, `flush`, `getState`) over WebSocket,
 * and executes `swift test --filter PyricCrashlyticsTests` against the live
 * `CrashlyticsBroker` with inbound `appCheckToken` verification.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  DOC_VALUE_ENCODING_CAPABILITY,
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
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
const PROJECT_ID = 'demo-swift-crashlytics-live';
const IOS_APP_ID = '1:888888888888:ios:swiftcrashlyticslive';

const ALL_CRASHLYTICS_METHODS = [
  'crashlytics.setUserId',
  'crashlytics.setCustomKeys',
  'crashlytics.log',
  'crashlytics.recordError',
  'crashlytics.setCollectionEnabled',
  'crashlytics.checkForUnsentReports',
  'crashlytics.sendUnsentReports',
  'crashlytics.deleteUnsentReports',
  'crashlytics.flush',
  'crashlytics.getState',
] as const;

function makeInMemoryHostedPersistence(): HostedPersistence {
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
    seed: async () => false,
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
  } as unknown as HostedPersistence;
}

interface ObservedSwiftCrashlyticsTraffic {
  observedMethods: string[];
  attachedAppCheckMethods: Set<string>;
}

interface LiveSwiftCrashlyticsHost {
  readonly bridgeUrl: string;
  readonly traffic: ObservedSwiftCrashlyticsTraffic;
  close(): Promise<void>;
}

async function startLiveSwiftCrashlyticsHost(): Promise<LiveSwiftCrashlyticsHost> {
  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const traffic: ObservedSwiftCrashlyticsTraffic = {
    observedMethods: [],
    attachedAppCheckMethods: new Set<string>(),
  };

  const hostedRuntime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${PROJECT_ID}-default-rtdb`,
        projectId: PROJECT_ID,
        rules: {},
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      projectKey: 'swift-crashlytics-live-host',
      permissive: true,
      appOptions: {
        projectId: PROJECT_ID,
        appId: IOS_APP_ID,
      },
    },
    () => baseOrigin,
    (message) => {
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
        if (typeof method === 'string') {
          traffic.observedMethods.push(method);
          const token = opRecord.appCheckToken;
          if (typeof token === 'string' && token.length > 0) {
            traffic.attachedAppCheckMethods.add(method);
          }
        }
      }
      hostedRuntime.receive(inbound);
    },
    [...hostedRuntime.toolNames],
    hostedRuntime.instanceId,
    [
      WORKER_RELAY_CAPABILITY,
      WORKER_PORT_CAPABILITY,
      DOC_VALUE_ENCODING_CAPABILITY,
    ],
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
    async close(): Promise<void> {
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

interface AttachedSwiftCrashlyticsSocket {
  sendOp(op: Record<string, unknown>): Promise<WorkerResFrame>;
  close(): Promise<void>;
}

async function openAttachedSwiftCrashlyticsSocket(
  bridgeUrl: string,
): Promise<AttachedSwiftCrashlyticsSocket> {
  const ws = new WebSocket(bridgeUrl);
  const waiters = new Map<string, (frame: WorkerResFrame) => void>();
  let sequence = 0;

  await once(ws, 'open');
  await new Promise<void>((resolveAck, rejectAck) => {
    const timer = setTimeout(
      () => rejectAck(new Error('Timed out waiting for attach-ack')),
      5_000,
    );
    const onAttachMsg = (raw: WebSocket.RawData): void => {
      const parsed = JSON.parse(String(raw)) as BridgeMessage;
      if (parsed.type === 'attach-ack') {
        clearTimeout(timer);
        ws.off('message', onAttachMsg);
        expect(parsed.peerConnected).toBe(true);
        resolveAck();
      }
    };
    ws.on('message', onAttachMsg);
    ws.send(
      JSON.stringify({
        type: 'attach',
        protocol: 1,
        clientInfo: { platform: 'swift', deviceLabel: 'pyric-crashlytics' },
        capabilities: [DOC_VALUE_ENCODING_CAPABILITY],
      }),
    );
  });

  ws.on('message', (raw) => {
    const parsed = JSON.parse(String(raw)) as BridgeMessage;
    if (parsed.type === 'worker-res') {
      const waiter = waiters.get(parsed.id);
      if (waiter !== undefined) {
        waiters.delete(parsed.id);
        waiter(parsed);
      }
    }
  });

  return {
    async sendOp(op: Record<string, unknown>): Promise<WorkerResFrame> {
      sequence += 1;
      const id = `crash-op-${sequence}`;
      return await new Promise<WorkerResFrame>((resolveRes, rejectRes) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          rejectRes(new Error(`Timed out waiting for ${id}`));
        }, 5_000);
        waiters.set(id, (frame) => {
          clearTimeout(timer);
          resolveRes(frame);
        });
        ws.send(JSON.stringify({ type: 'worker-op', id, op }));
      });
    },
    async close(): Promise<void> {
      if (ws.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise<void>((resolveClosed) => {
        const fallback = setTimeout(() => resolveClosed(), 250);
        ws.once('close', () => {
          clearTimeout(fallback);
          resolveClosed();
        });
        ws.close(1000, 'done');
      });
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

describe('native Swift Crashlytics live-host conformance', () => {
  test('serves all 10 crashlytics.* operations, unsent report queue, and multi-app isolation over WebSocket', async () => {
    const host = await startLiveSwiftCrashlyticsHost();
    let client: AttachedSwiftCrashlyticsSocket | undefined;
    try {
      client = await openAttachedSwiftCrashlyticsSocket(host.bridgeUrl);

      expect(
        (await client.sendOp({ method: 'crashlytics.setUserId', userId: 'swift-smoke-user' })).ok,
      ).toBe(true);
      expect(
        (
          await client.sendOp({
            method: 'crashlytics.setCustomKeys',
            keys: { tier: 'pro', retries: 2, active: true },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await client.sendOp({
            method: 'crashlytics.log',
            message: 'screen:home',
            timestampMs: 1_700_000_000_000,
          })
        ).ok,
      ).toBe(true);

      const recRes = await client.sendOp({
        method: 'crashlytics.recordError',
        name: 'NSCocoaErrorDomain',
        code: '-1009',
        message: 'The Internet connection appears to be offline.',
        stack: '{NetworkClient.swift - fetchProfile():42}',
        sdkPlatform: 'ios',
        fatal: false,
      });
      expect(recRes.ok).toBe(true);

      expect(
        (await client.sendOp({ method: 'crashlytics.setCollectionEnabled', enabled: false })).ok,
      ).toBe(true);
      expect(
        (
          await client.sendOp({
            method: 'crashlytics.recordError',
            name: 'ExceptionModel',
            message: 'deferred-ios-report',
            sdkPlatform: 'ios',
            deferred: true,
          })
        ).ok,
      ).toBe(true);

      const unsentRes = await client.sendOp({ method: 'crashlytics.checkForUnsentReports' });
      expect(unsentRes.ok).toBe(true);
      if (unsentRes.ok) {
        const checkVal = unsentRes.value as { hasUnsentReports: boolean; count: number };
        expect(checkVal.hasUnsentReports).toBe(true);
        expect(checkVal.count).toBe(1);
      }

      expect((await client.sendOp({ method: 'crashlytics.sendUnsentReports' })).ok).toBe(true);
      expect(
        (
          await client.sendOp({
            method: 'crashlytics.recordError',
            name: 'ExceptionModel',
            message: 'discarded-ios-report',
            sdkPlatform: 'ios',
            deferred: true,
          })
        ).ok,
      ).toBe(true);
      expect((await client.sendOp({ method: 'crashlytics.deleteUnsentReports' })).ok).toBe(true);
      expect((await client.sendOp({ method: 'crashlytics.flush' })).ok).toBe(true);

      // Named app isolation check
      expect(
        (
          await client.sendOp({
            method: 'crashlytics.setUserId',
            appId: 'secondary-ios-app',
            userId: 'secondary-user',
          })
        ).ok,
      ).toBe(true);

      const stateRes = await client.sendOp({ method: 'crashlytics.getState' });
      expect(stateRes.ok).toBe(true);
      if (stateRes.ok) {
        const stateVal = stateRes.value as {
          userId: string;
          reports: Array<{ sdkPlatform: string; flushed: boolean }>;
          unsentReports: unknown[];
        };
        expect(stateVal.userId).toBe('swift-smoke-user');
        expect(stateVal.reports.length).toBe(2);
        expect(stateVal.reports[0]?.sdkPlatform).toBe('ios');
        expect(stateVal.reports[0]?.flushed).toBe(true);
        expect(stateVal.unsentReports.length).toBe(0);
      }
    } finally {
      await client?.close();
      await host.close();
    }
  });

  test.skipIf(shouldSkipSwiftSubprocess)(
    'runs packages/swift-client PyricCrashlyticsTests against live HostedRuntime CrashlyticsBroker',
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

      const host = await startLiveSwiftCrashlyticsHost();
      try {
        const childEnv: Record<string, string> = {
          ...baseEnv,
          PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL: host.bridgeUrl,
          PYRIC_REQUIRE_CRASHLYTICS_LIVE: '1',
          PYRIC_LIVE_PROJECT_ID: PROJECT_ID,
          PYRIC_LIVE_IOS_APP_ID: IOS_APP_ID,
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
            'PyricCrashlyticsTests',
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
        expect(combined, testDetails).toContain('PYRIC_SWIFT_CRASHLYTICS_LIVE_VERIFIED=1');

        for (const expectedMethod of ALL_CRASHLYTICS_METHODS) {
          expect(host.traffic.observedMethods).toContain(expectedMethod);
          expect(host.traffic.attachedAppCheckMethods.has(expectedMethod)).toBe(true);
        }
      } finally {
        await host.close();
      }
    },
    SWIFT_LIVE_HOST_TEST_TIMEOUT_MS,
  );
});
