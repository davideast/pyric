/**
 * Live-host conformance harness for the Swift client SDK (`packages/swift-client`).
 *
 * Boots an authoritative loopback Pyric bridge host on `127.0.0.1:0` with the
 * default Realtime Database instance plus named shards `shard-00`..`shard-09`
 * loaded under independent Security Rules, verifies the multi-shard WebSocket
 * wire contract directly, and runs `swift test --filter PyricLiveHostTests`
 * against the live loopback endpoint whenever `swift` is installed (or fails
 * closed when `PYRIC_REQUIRE_SWIFT_LIVE=1` is set in macOS CI).
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { openStorageBackend } from '../../../pyric/src/storage/persistence.js';
import {
  MAX_BRIDGE_FRAME_BYTES,
  STORAGE_BYTE_ROUTE_CAPABILITY,
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../src/serve/init-payload.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const DEFAULT_RTDB_INSTANCE = 'demo-swift-live-default-rtdb';
const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /role_items/{role}/items/{itemId} {
      allow read, write: if request.auth != null && request.auth.token.role == role;
    }
  }
}`;
const NAMED_SHARDS: readonly string[] = [
  'shard-00',
  'shard-01',
  'shard-02',
  'shard-03',
  'shard-04',
  'shard-05',
  'shard-06',
  'shard-07',
  'shard-08',
  'shard-09',
];

const MAIN_RULES = {
  rules: {
    users: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
        '.write': 'auth != null && auth.uid === $uid',
        catalog: {
          '.indexOn': ['score', 'role', 'meta/rank', '.value'],
        },
        scores: {
          '.indexOn': ['.value'],
        },
      },
    },
  },
};

const SHARD_00_RULES = {
  rules: {
    rooms: {
      $roomId: {
        '.read': 'auth != null',
        '.write': 'auth != null && newData.child("owner").val() === auth.uid',
      },
    },
  },
};

const SHARD_01_RULES = {
  rules: {
    catalog: {
      $itemId: {
        '.read': true,
        '.write': false,
      },
    },
    ops: {
      $opId: {
        '.read': 'auth != null && auth.token.role === "ops"',
        '.write': 'auth != null && auth.token.role === "ops"',
      },
    },
  },
};

function shardNamedRules(shardName: string): { rules: Record<string, unknown> } {
  return {
    rules: {
      shards: {
        [shardName]: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
      },
    },
  };
}

function isDedicatedRuleShard(shardName: string): boolean {
  return shardName === 'shard-00' || shardName === 'shard-01';
}

function buildMultiShardDatabaseRules(): Record<string, { rules: Record<string, unknown> }> {
  const rulesByInstance: Record<string, { rules: Record<string, unknown> }> = {
    [DEFAULT_RTDB_INSTANCE]: MAIN_RULES,
    'shard-00': SHARD_00_RULES,
    'shard-01': SHARD_01_RULES,
  };
  for (const shard of NAMED_SHARDS) {
    if (!isDedicatedRuleShard(shard)) {
      rulesByInstance[shard] = shardNamedRules(shard);
    }
  }
  return rulesByInstance;
}

function requiresLiveSwift(env: NodeJS.ProcessEnv): boolean {
  return env.PYRIC_REQUIRE_SWIFT_LIVE === '1';
}

function shouldSkipLiveSwiftRun(swiftBinary: string | null, env: NodeJS.ProcessEnv): boolean {
  if (requiresLiveSwift(env)) return false;
  return swiftBinary === null;
}

const DETECTED_SWIFT_BINARY = Bun.which('swift');
const SKIPS_SWIFT_SUBPROCESS = shouldSkipLiveSwiftRun(DETECTED_SWIFT_BINARY, process.env);

interface LoopbackSwiftBridgeHost {
  readonly port: number;
  readonly wsUrl: string;
  close(): Promise<void>;
}

async function listenUpgradeServer(): Promise<{
  server: Server;
  wss: WebSocketServer;
  sockets: Set<Socket>;
  port: number;
}> {
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BRIDGE_FRAME_BYTES,
  });
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' }).end('Upgrade Required');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket as Socket);
    socket.once('close', () => sockets.delete(socket as Socket));
    let requestPath = '/';
    if (req.url !== undefined) {
      requestPath = req.url;
    }
    const parsed = new URL(requestPath, 'http://127.0.0.1');
    if (parsed.pathname !== '/__pyric/sandbox') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const hasBoundPort = address !== null && typeof address === 'object';
  if (!hasBoundPort) {
    await closeUpgradeServer(server, wss, sockets);
    throw new Error('Expected bound IPv4 AddressInfo for loopback Swift WebSocketServer.');
  }
  return { server, wss, sockets, port: (address as AddressInfo).port };
}

function settleCallback(register: (done: () => void) => void, fallbackMs = 200): Promise<void> {
  return new Promise<void>((resolveSettle) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSettle();
    };
    const timer = setTimeout(done, fallbackMs);
    timer.unref();
    try {
      register(done);
    } catch {
      done();
    }
  });
}

async function closeUpgradeServer(
  server: Server,
  wss: WebSocketServer,
  sockets: Set<Socket>,
): Promise<void> {
  let serverClosed = Promise.resolve();
  if (server.listening) {
    serverClosed = settleCallback((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    });
  }
  for (const clientSocket of wss.clients) {
    clientSocket.terminate();
  }
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await settleCallback((done) => {
    wss.close(() => done());
  });
  await serverClosed;
}

async function startLoopbackSwiftBridgeHost(): Promise<LoopbackSwiftBridgeHost> {
  const { server, wss, sockets, port } = await listenUpgradeServer();
  const wsUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const bridge = createBridge({
    mode: 'sandbox',
    project: 'demo-swift-live',
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });

  let runtime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  let disconnectHosted: (() => void) | undefined;
  try {
    const persistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend(`mem-swift-live-${randomUUID()}`),
      checkpoints: {},
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    };
    const rulesByInstance = buildMultiShardDatabaseRules();
    const payload: InitPayload = {
      rules: FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: MAIN_RULES,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: DEFAULT_RTDB_INSTANCE,
        projectId: 'demo-swift-live',
        rules: rulesByInstance,
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: wsUrl,
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: REPO_ROOT,
      appOptions: { projectId: 'demo-swift-live' },
    };
    runtime = await createHostedRuntime(
      payload,
      baseUrl,
      (message) => bridge.handleSandboxMessage(message),
      REPO_ROOT,
      {
        persistence: persistence as never,
        record: false,
      },
    );
    const activeRuntime = runtime;
    disconnectHosted = bridge.registerSandboxPeer(
      (message) => activeRuntime.receive(message),
      [...activeRuntime.toolNames],
      activeRuntime.instanceId,
      [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY, STORAGE_BYTE_ROUTE_CAPABILITY],
    );
    await activeRuntime.deployRules('firestore', FIRESTORE_RULES);
    wss.on('connection', (ws) => {
      attachPeer(bridge, ws, false);
    });
  } catch (error) {
    disconnectHosted?.();
    await closeUpgradeServer(server, wss, sockets);
    await runtime?.close();
    throw error;
  }

  const hostedRuntime = runtime;
  const unregisterPeer = disconnectHosted;
  return {
    port,
    wsUrl,
    async close(): Promise<void> {
      try {
        await closeUpgradeServer(server, wss, sockets);
      } finally {
        unregisterPeer?.();
        await hostedRuntime.close();
      }
    },
  };
}

interface WireFrame {
  readonly type?: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly peerConnected?: boolean;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code?: string; readonly message?: string };
}

function isAttachAckFrame(frame: WireFrame): boolean {
  return frame.type === 'attach-ack';
}

function isWorkerResultFrame(frame: WireFrame): frame is WireFrame & { readonly id: string } {
  return frame.type === 'worker-res' && typeof frame.id === 'string';
}

async function openAttachedSocket(wsUrl: string): Promise<{
  sendOp(op: Record<string, unknown>): Promise<WireFrame>;
  close(): Promise<void>;
}> {
  const ws = new WebSocket(wsUrl);
  const waiters = new Map<string, (frame: WireFrame) => void>();
  let attachWaiter: ((frame: WireFrame) => void) | null = null;
  let sequence = 0;

  ws.on('message', (raw) => {
    const parsed = JSON.parse(String(raw)) as WireFrame;
    if (isAttachAckFrame(parsed) && attachWaiter !== null) {
      const resume = attachWaiter;
      attachWaiter = null;
      resume(parsed);
      return;
    }
    if (isWorkerResultFrame(parsed)) {
      const waiter = waiters.get(parsed.id);
      if (waiter !== undefined) {
        waiters.delete(parsed.id);
        waiter(parsed);
      }
    }
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once('open', () => resolveOpen());
    ws.once('error', rejectOpen);
  });

  const attachAck = await new Promise<WireFrame>((resolveAck, rejectAck) => {
    const timer = setTimeout(() => rejectAck(new Error('Timed out waiting for attach-ack')), 5_000);
    attachWaiter = (frame) => {
      clearTimeout(timer);
      resolveAck(frame);
    };
    ws.send(JSON.stringify({
      type: 'attach',
      protocol: 1,
      clientInfo: { platform: 'swift' },
      capabilities: ['doc-value-encoding-v1'],
    }));
  });
  expect(attachAck.peerConnected).toBe(true);

  return {
    async sendOp(op: Record<string, unknown>): Promise<WireFrame> {
      sequence += 1;
      const id = `rop-${sequence}`;
      return await new Promise<WireFrame>((resolveRes, rejectRes) => {
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
      if (ws.readyState === WebSocket.CLOSED) return;
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

describe('Swift native SDK live-host conformance', () => {
  test('loopback bridge host enforces Auth and 11-shard RTDB isolation over WebSocket', async () => {
    const host = await startLoopbackSwiftBridgeHost();
    let client: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;
    try {
      client = await openAttachedSocket(host.wsUrl);

      const deniedAnon = await client.sendOp({
        method: 'rtdb.set',
        path: '/users/unauthed',
        value: { displayName: 'Blocked' },
        actAs: { mode: 'anon' },
      });
      expect(deniedAnon.ok).toBe(false);
      expect(deniedAnon.error?.code).toBe('PERMISSION_DENIED');

      const created = await client.sendOp({
        method: 'auth.createUser',
        email: 'pilot@example.test',
        password: 'correct-horse-battery',
      });
      expect(created.ok).toBe(true);
      const userRecord = created.value?.user as { uid?: string } | undefined;
      let uid = '';
      if (typeof userRecord?.uid === 'string') {
        uid = userRecord.uid;
      }
      expect(uid.length).toBeGreaterThan(0);

      const userLens = { mode: 'as', uid };
      const writeMain = await client.sendOp({
        method: 'rtdb.set',
        path: `/users/${uid}`,
        value: { displayName: 'Pilot One' },
        actAs: userLens,
      });
      expect(writeMain.ok).toBe(true);

      const writeShard00 = await client.sendOp({
        method: 'rtdb.set',
        instance: 'shard-00',
        path: '/rooms/r1',
        value: { owner: uid, topic: 'navigation' },
        actAs: userLens,
      });
      expect(writeShard00.ok).toBe(true);

      const deniedShard01 = await client.sendOp({
        method: 'rtdb.get',
        instance: 'shard-01',
        path: '/rooms/r1',
        actAs: userLens,
      });
      expect(deniedShard01.ok).toBe(false);
      expect(deniedShard01.error?.code).toBe('PERMISSION_DENIED');

      const writeShard09 = await client.sendOp({
        method: 'rtdb.set',
        instance: 'shard-09',
        path: '/shards/shard-09/status',
        value: 'ready',
        actAs: userLens,
      });
      expect(writeShard09.ok).toBe(true);
    } finally {
      await client?.close();
      await host.close();
    }
  });

  test.skipIf(SKIPS_SWIFT_SUBPROCESS)(
    'PyricLiveHostTests pass against the live loopback Pyric bridge host',
    async () => {
      const swiftBinary = Bun.which('swift');
      if (swiftBinary === null) {
        throw new Error('PYRIC_REQUIRE_SWIFT_LIVE=1 is set, but `swift` was not found in PATH.');
      }

      const swiftPackageDir = join(REPO_ROOT, 'packages/swift-client');
      const host = await startLoopbackSwiftBridgeHost();
      try {
        const childEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) {
            childEnv[key] = value;
          }
        }
        const nowMs = Date.now();
        const validCustomToken = mintCustomToken({
          uid: 'swift-custom-uid-01',
          claims: { role: 'ops', tier: 'enterprise' },
          projectId: 'demo-swift-live',
          nowMs,
        });
        const mismatchCustomToken = mintCustomToken({
          uid: 'swift-custom-uid-mismatch',
          projectId: 'other-swift-project',
          nowMs,
        });
        childEnv.PYRIC_LIVE_BRIDGE_URL = host.wsUrl;
        childEnv.PYRIC_LIVE_CUSTOM_TOKEN_VALID = validCustomToken;
        childEnv.PYRIC_LIVE_CUSTOM_TOKEN_MISMATCH = mismatchCustomToken;

        const child = Bun.spawn(
          [
            swiftBinary,
            'test',
            '--no-parallel',
            '--package-path',
            swiftPackageDir,
            '--filter',
            'PyricLiveHostTests',
          ],
          {
            cwd: REPO_ROOT,
            env: childEnv,
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const killTimer = setTimeout(() => child.kill(), 180_000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          const combinedOutput = `${stdout}\n${stderr}`;
          expect(exitCode, combinedOutput).toBe(0);
          expect(combinedOutput).not.toContain('with 0 tests');
        } finally {
          clearTimeout(killTimer);
          child.kill();
        }
      } finally {
        await host.close();
      }
    },
    240_000,
  );
});
