import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import {
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

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const KT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/kt-client');
const PROJECT_ID = 'demo-kotlin-messaging';

function makeInMemoryHostedPersistence(): HostedPersistence {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  } as unknown as HostedPersistence['storage'];
  const seedFn = async () => false;
  return {
    backend: {
      ...createMemoryBackend(),
      retryFailedFlush: false,
    } as unknown as HostedPersistence['backend'],
    storage: storageStub,
    checkpoints: {} as HostedPersistence['checkpoints'],
    state: { seed: seedFn } as unknown as HostedPersistence['state'],
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close: () => {},
    status: () => ({
      state: 'healthy' as const,
      commits: 0,
      lastCommitMs: 0,
      maxCommitMs: 0,
      failedAt: null,
    }),
    onFailure: () => () => {},
    markUnhealthy: () => {},
    seed: seedFn as unknown as HostedPersistence['seed'],
  };
}

interface ObservedMessagingTraffic {
  attachedAppCheckMethods: Set<string>;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, 'utf8'));
    } else {
      chunks.push(chunk as Buffer);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startLiveMessagingBridgeHost() {
  const bridge = createBridge({ version: '0.0.0-test', project: PROJECT_ID });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const traffic: ObservedMessagingTraffic = {
    attachedAppCheckMethods: new Set(),
  };

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
      messaging: true,
      projectKey: 'kotlin-messaging-live-host',
      permissive: true,
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
        const attached = opRecord.appCheckToken;
        if (
          typeof method === 'string' &&
          method.startsWith('messaging.') &&
          typeof attached === 'string' &&
          attached.length > 0
        ) {
          traffic.attachedAppCheckMethods.add(method);
        }
      }
      hostedRuntime.receive(inbound);
    },
    [],
    'kotlin-messaging-sandbox-peer',
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
  );

  let adminSocket: WebSocket | null = null;
  let adminSeq = 0;
  const adminReplies = new Map<string, (frame: WorkerResFrame) => void>();

  async function ensureAdminSocket(bridgeUrl: string): Promise<WebSocket> {
    if (adminSocket !== null && adminSocket.readyState === WebSocket.OPEN) {
      return adminSocket;
    }
    const ws = new WebSocket(bridgeUrl);
    await once(ws, 'open');
    await new Promise<void>((resolveAck) => {
      const onMsg = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'attach-ack') {
          ws.off('message', onMsg);
          resolveAck();
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ type: 'attach', protocol: 1, capabilities: [] }));
    });
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as BridgeMessage;
      if (frame.type === 'worker-res') {
        const waiter = adminReplies.get(frame.id);
        if (waiter !== undefined) {
          adminReplies.delete(frame.id);
          waiter(frame);
        }
      }
    });
    adminSocket = ws;
    return ws;
  }

  async function handleAdminHttp(
    req: IncomingMessage,
    res: ServerResponse,
    bridgeUrl: string,
  ): Promise<void> {
    const rawBody = await readRequestBody(req);
    const parsed = JSON.parse(rawBody) as {
      action: 'send' | 'deliver';
      message?: Record<string, unknown>;
      spec?: Record<string, unknown>;
    };
    const ws = await ensureAdminSocket(bridgeUrl);
    adminSeq += 1;
    const opId = `fcm-admin-${adminSeq}`;
    let opPayload: Record<string, unknown>;
    if (parsed.action === 'send') {
      opPayload = { method: 'messaging.send', message: parsed.message };
    } else {
      opPayload = { method: 'messaging.deliver', spec: parsed.spec };
    }
    const reply = await new Promise<WorkerResFrame>((resolveRes) => {
      adminReplies.set(opId, resolveRes);
      ws.send(JSON.stringify({ type: 'worker-op', id: opId, op: opPayload }));
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  }

  let resolvedBridgeUrl = '';
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__test/fcm-admin') {
      void handleAdminHttp(req, res, resolvedBridgeUrl).catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { message: String(err) } }));
      });
      return;
    }
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
  resolvedBridgeUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;
  const adminUrl = `${baseOrigin}/__test/fcm-admin`;

  return {
    bridgeUrl: resolvedBridgeUrl,
    adminUrl,
    traffic,
    async close() {
      if (adminSocket !== null) {
        adminSocket.terminate();
        adminSocket = null;
      }
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
  if (match === null || match[1] === undefined) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  if (Number.isNaN(major)) {
    return null;
  }
  return major;
}

const requireKotlinLive = process.env.PYRIC_REQUIRE_KOTLIN_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireKotlinLive;
const detectedJavaMajor = detectCompatibleJavaMajor();
const hasCompatibleJdk =
  detectedJavaMajor !== null && detectedJavaMajor >= 11 && detectedJavaMajor <= 24;
const shouldSkipGradleRun = !requireKotlinLive && (isGenericCiShard || !hasCompatibleJdk);

describe('native Kotlin Cloud Messaging live-host conformance', () => {
  test('routes FCM tokens, topics, conditions, and visibility over HostedRuntime WebSocket bridge', async () => {
    const host = await startLiveMessagingBridgeHost();
    const ws = new WebSocket(host.bridgeUrl);
    try {
      const replies = new Map<string, (frame: WorkerResFrame) => void>();
      const fgPayloads: Array<Record<string, unknown>> = [];
      const bgPayloads: Array<Record<string, unknown>> = [];

      await once(ws, 'open');
      await new Promise<void>((resolveAck) => {
        const onMsg = (raw: WebSocket.RawData) => {
          const frame = JSON.parse(String(raw)) as BridgeMessage;
          if (frame.type === 'attach-ack') {
            ws.off('message', onMsg);
            resolveAck();
          }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ type: 'attach', protocol: 1, capabilities: [] }));
      });

      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
            replies.delete(frame.id);
            handler(frame);
          }
        } else if (frame.type === 'worker-snap') {
          const snap = frame as WorkerSnapFrame;
          if (snap.subId === 'sub-fg') {
            fgPayloads.push(snap.value as Record<string, unknown>);
          } else if (snap.subId === 'sub-bg') {
            bgPayloads.push(snap.value as Record<string, unknown>);
          }
        }
      });

      let seq = 0;
      const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `fcm-smoke-${seq}`;
        return new Promise((resolveRes) => {
          replies.set(id, resolveRes);
          ws.send(JSON.stringify({ type: 'worker-op', id, op }));
        });
      };

      ws.send(
        JSON.stringify({
          type: 'worker-sub',
          subId: 'sub-fg',
          sub: { target: 'messaging.foreground' },
        }),
      );
      ws.send(
        JSON.stringify({
          type: 'worker-sub',
          subId: 'sub-bg',
          sub: { target: 'messaging.background' },
        }),
      );

      const tokRes = await sendOp({
        method: 'messaging.getToken',
        registrationId: 'swreg-port-default',
      });
      expect(tokRes.ok).toBe(true);
      let mintedToken = '';
      if (tokRes.ok) {
        mintedToken = (tokRes.value as { token: string }).token;
      }
      expect(mintedToken.includes(':')).toBe(true);

      const subRes = await sendOp({
        method: 'messaging.subscribeToTopic',
        tokens: [mintedToken],
        topic: 'alerts',
      });
      expect(subRes.ok).toBe(true);

      await sendOp({ method: 'messaging.setVisibility', state: 'hidden' });
      const bgSend = await sendOp({
        method: 'messaging.send',
        message: { topic: 'alerts', data: { mode: 'bg' } },
      });
      expect(bgSend.ok).toBe(true);
      await Bun.sleep(50);
      expect(bgPayloads.length).toBe(1);
      expect(fgPayloads.length).toBe(0);

      await sendOp({ method: 'messaging.setVisibility', state: 'visible' });
      const fgSend = await sendOp({
        method: 'messaging.send',
        message: { token: mintedToken, data: { mode: 'fg' } },
      });
      expect(fgSend.ok).toBe(true);
      await Bun.sleep(50);
      expect(fgPayloads.length).toBe(1);
      expect(bgPayloads.length).toBe(1);
    } finally {
      ws.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipGradleRun)(
    'runs MessagingLiveHostConformanceTest over OkHttp WebSocket against live HostedRuntime',
    async () => {
      if (!hasCompatibleJdk) {
        throw new Error(
          `PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK 11..24 on PATH or JAVA_HOME (detected: ${String(detectedJavaMajor)})`,
        );
      }

      const host = await startLiveMessagingBridgeHost();
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
            'dev.pyric.e2e.MessagingLiveHostConformanceTest',
            '--stacktrace',
            '--no-daemon',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PYRIC_LIVE_MESSAGING_BRIDGE_URL: host.bridgeUrl,
              PYRIC_LIVE_MESSAGING_ADMIN_URL: host.adminUrl,
              PYRIC_REQUIRE_MESSAGING_LIVE: '1',
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
            `Gradle MessagingLiveHostConformanceTest exited ${String(exitCode)}:\n${stdout}\n${stderr}`,
          );
        }

        const xmlPath = resolve(
          KT_CLIENT_DIR,
          'build/test-results/test/TEST-dev.pyric.e2e.MessagingLiveHostConformanceTest.xml',
        );
        expect(existsSync(xmlPath)).toBe(true);
        const xml = readFileSync(xmlPath, 'utf8');
        const testsMatch = /\btests="(\d+)"/.exec(xml);
        expect(testsMatch).not.toBeNull();
        let executedTests = 0;
        if (testsMatch !== null && testsMatch[1] !== undefined) {
          executedTests = Number.parseInt(testsMatch[1], 10);
        }
        expect(executedTests).toBeGreaterThanOrEqual(1);
        expect(xml).toContain('skipped="0"');
        expect(xml).toContain('failures="0"');
        expect(xml).toContain('errors="0"');
        expect(xml).toContain('PYRIC_KT_MESSAGING_LIVE_VERIFIED=1');

        for (const expectedMethod of [
          'messaging.getToken',
          'messaging.deleteToken',
          'messaging.subscribeToTopic',
          'messaging.unsubscribeFromTopic',
          'messaging.setVisibility',
          'messaging.send',
        ]) {
          expect(host.traffic.attachedAppCheckMethods.has(expectedMethod)).toBe(true);
        }
      } finally {
        await host.close();
      }
    },
    180_000,
  );
});
