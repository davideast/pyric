/**
 * Live-host Cloud Messaging conformance harness for the Swift client SDK
 * (`packages/swift-client/Sources/PyricMessaging`).
 *
 * Boots an in-memory loopback Pyric bridge host with `messaging: true` enabled
 * on `createHostedRuntime`, verifies the WebSocket `messaging.*` operations,
 * `messaging.foreground` / `messaging.background` subscriptions, multi-recipient
 * isolation, and `messaging/disabled` capability gating, and executes
 * `swift test --filter PyricMessagingTests` against the live `MessagingBroker`.
 */
import { describe, expect, test } from 'bun:test';
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
  type WorkerSnapFrame,
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
  probeSwiftLiveToolchain,
  runManagedSubprocess,
} from './swift-live-host-subprocess.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const SWIFT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/swift-client');
const PROJECT_ID = 'demo-swift-messaging-live';
const IOS_APP_ID = '1:999999999999:ios:swiftmessagingclient';

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

interface ObservedSwiftMessagingTraffic {
  observedOps: string[];
  observedSubs: string[];
  unsubIds: string[];
}

interface LiveSwiftMessagingHost {
  readonly bridgeUrl: string;
  readonly traffic: ObservedSwiftMessagingTraffic;
  close(): Promise<void>;
}

async function startLiveSwiftMessagingHost(
  messagingEnabled = true,
): Promise<LiveSwiftMessagingHost> {
  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const traffic: ObservedSwiftMessagingTraffic = {
    observedOps: [],
    observedSubs: [],
    unsubIds: [],
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
      messaging: messagingEnabled,
      projectKey: 'swift-messaging-live-host',
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
        if (typeof opRecord.method === 'string') {
          traffic.observedOps.push(opRecord.method);
        }
      } else if (inbound.type === 'worker-sub') {
        const subRecord = inbound.sub as Record<string, unknown>;
        if (typeof subRecord.target === 'string') {
          traffic.observedSubs.push(subRecord.target);
        }
      } else if (inbound.type === 'worker-unsub') {
        traffic.unsubIds.push(inbound.subId);
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

interface AttachedSwiftMessagingSocket {
  readonly snaps: WorkerSnapFrame[];
  subscribe(subId: string, sub: Record<string, unknown>): void;
  unsubscribe(subId: string): void;
  sendOp(op: Record<string, unknown>): Promise<WorkerResFrame>;
  close(): Promise<void>;
}

async function openAttachedSwiftMessagingSocket(
  bridgeUrl: string,
): Promise<AttachedSwiftMessagingSocket> {
  const ws = new WebSocket(bridgeUrl);
  const waiters = new Map<string, (frame: WorkerResFrame) => void>();
  const snaps: WorkerSnapFrame[] = [];
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
        clientInfo: { platform: 'swift', deviceLabel: 'pyric-messaging' },
        capabilities: [DOC_VALUE_ENCODING_CAPABILITY],
      }),
    );
  });

  ws.on('message', (raw) => {
    const parsed = JSON.parse(String(raw)) as BridgeMessage;
    if (parsed.type === 'worker-snap') {
      snaps.push(parsed);
      return;
    }
    if (parsed.type === 'worker-res') {
      const waiter = waiters.get(parsed.id);
      if (waiter !== undefined) {
        waiters.delete(parsed.id);
        waiter(parsed);
      }
    }
  });

  return {
    snaps,
    subscribe(subId: string, sub: Record<string, unknown>): void {
      ws.send(JSON.stringify({ type: 'worker-sub', subId, sub }));
    },
    unsubscribe(subId: string): void {
      ws.send(JSON.stringify({ type: 'worker-unsub', subId }));
    },
    async sendOp(op: Record<string, unknown>): Promise<WorkerResFrame> {
      sequence += 1;
      const id = `msg-op-${sequence}`;
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

const SWIFT_TOOLCHAIN = probeSwiftLiveToolchain();
const shouldSkipSwiftSubprocess = SWIFT_TOOLCHAIN.skip;
const detectedSwiftBinary = SWIFT_TOOLCHAIN.swiftBinary;
if (SWIFT_TOOLCHAIN.skip && SWIFT_TOOLCHAIN.skipReason !== null) {
  console.warn(`[native-swift-messaging-conformance] skipping PyricMessagingTests: ${SWIFT_TOOLCHAIN.skipReason}`);
}

describe('native Swift Cloud Messaging live-host conformance', () => {
  test('serves token, topic, condition, visibility, deliver, multi-recipient, and disabled gates over WebSocket', async () => {
    const host = await startLiveSwiftMessagingHost(true);
    let clientA: AttachedSwiftMessagingSocket | undefined;
    let clientB: AttachedSwiftMessagingSocket | undefined;
    try {
      clientA = await openAttachedSwiftMessagingSocket(host.bridgeUrl);
      clientB = await openAttachedSwiftMessagingSocket(host.bridgeUrl);

      clientA.subscribe('msg-fg-a', {
        target: 'messaging.foreground',
        recipientId: 'swift-app-a',
      });
      clientB.subscribe('msg-bg-b', {
        target: 'messaging.background',
        recipientId: 'swift-app-b',
      });

      const tokARes = await clientA.sendOp({
        method: 'messaging.getToken',
        registrationId: 'swift-reg-a',
        recipientId: 'swift-app-a',
      });
      expect(tokARes.ok).toBe(true);
      const tokenA = (tokARes.value as { token: string }).token;
      expect(tokenA.length).toBe(142);

      const tokBRes = await clientB.sendOp({
        method: 'messaging.getToken',
        registrationId: 'swift-reg-b',
        recipientId: 'swift-app-b',
      });
      expect(tokBRes.ok).toBe(true);
      const tokenB = (tokBRes.value as { token: string }).token;
      expect(tokenB).not.toBe(tokenA);

      expect(
        (
          await clientA.sendOp({
            method: 'messaging.setVisibility',
            state: 'visible',
            recipientId: 'swift-app-a',
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await clientB.sendOp({
            method: 'messaging.setVisibility',
            state: 'hidden',
            recipientId: 'swift-app-b',
          })
        ).ok,
      ).toBe(true);

      expect(
        (
          await clientA.sendOp({
            method: 'messaging.subscribeToTopic',
            tokens: [tokenA, tokenB],
            topic: 'swift_smoke',
          })
        ).ok,
      ).toBe(true);

      const sendRes = await clientA.sendOp({
        method: 'messaging.send',
        message: {
          topic: 'swift_smoke',
          data: { origin: 'swift-wire' },
        },
      });
      expect(sendRes.ok).toBe(true);
      expect(clientA.snaps.length).toBe(1);
      expect(clientB.snaps.length).toBe(1);

      const firstSnapValue = clientA.snaps[0]?.value as { messageId: string };
      expect(typeof firstSnapValue.messageId).toBe('string');
      expect(firstSnapValue.messageId.length).toBeGreaterThan(0);

      const deliverB = await clientB.sendOp({
        method: 'messaging.deliver',
        recipientId: 'swift-app-b',
        spec: {
          data: { direct: 'bg-b' },
          messageId: 'deliver-b-1',
        },
      });
      expect(deliverB.ok).toBe(true);
      expect(clientB.snaps.length).toBe(2);

      const unsubTopicRes = await clientA.sendOp({
        method: 'messaging.unsubscribeFromTopic',
        tokens: [tokenB],
        topic: 'swift_smoke',
      });
      expect(unsubTopicRes.ok).toBe(true);

      clientA.unsubscribe('msg-fg-a');
      const delRes = await clientA.sendOp({
        method: 'messaging.deleteToken',
        registrationId: 'swift-reg-a',
        recipientId: 'swift-app-a',
      });
      expect(delRes.ok).toBe(true);

      const deadSend = await clientA.sendOp({
        method: 'messaging.send',
        message: { token: tokenA, data: { dead: '1' } },
      });
      expect(deadSend.ok).toBe(false);
      if (!deadSend.ok) {
        expect(deadSend.error.code).toBe('NOT_FOUND');
      }
    } finally {
      await clientA?.close();
      await clientB?.close();
      await host.close();
    }

    const disabledHost = await startLiveSwiftMessagingHost(false);
    let disabledClient: AttachedSwiftMessagingSocket | undefined;
    try {
      disabledClient = await openAttachedSwiftMessagingSocket(disabledHost.bridgeUrl);
      const disabledOp = await disabledClient.sendOp({ method: 'messaging.getToken' });
      expect(disabledOp.ok).toBe(false);
      if (!disabledOp.ok) {
        expect(disabledOp.error.code).toBe('messaging/disabled');
      }
    } finally {
      await disabledClient?.close();
      await disabledHost.close();
    }
  });

  test.skipIf(shouldSkipSwiftSubprocess)(
    'runs packages/swift-client PyricMessagingTests against live HostedRuntime MessagingBroker',
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

      const host = await startLiveSwiftMessagingHost(true);
      try {
        const childEnv: Record<string, string> = {
          ...baseEnv,
          PYRIC_LIVE_MESSAGING_BRIDGE_URL: host.bridgeUrl,
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
            'PyricMessagingTests',
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

        expect(host.traffic.observedOps).toContain('messaging.getToken');
        expect(host.traffic.observedOps).toContain('messaging.deleteToken');
        expect(host.traffic.observedOps).toContain('messaging.subscribeToTopic');
        expect(host.traffic.observedOps).toContain('messaging.unsubscribeFromTopic');
        expect(host.traffic.observedOps).toContain('messaging.setVisibility');
        expect(host.traffic.observedOps).toContain('messaging.deliver');
        expect(host.traffic.observedOps).toContain('messaging.send');
        expect(host.traffic.observedSubs).toContain('messaging.foreground');
        expect(host.traffic.observedSubs).toContain('messaging.background');
        expect(host.traffic.unsubIds.length).toBeGreaterThanOrEqual(2);
      } finally {
        await host.close();
      }
    },
    SWIFT_LIVE_HOST_TEST_TIMEOUT_MS,
  );
});
