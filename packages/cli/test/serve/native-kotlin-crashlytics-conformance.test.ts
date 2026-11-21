import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const KT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/kt-client');
const PROJECT_ID = 'demo-kotlin-crashlytics';

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

interface ObservedCrashlyticsTraffic {
  attachedAppCheckMethods: Set<string>;
}

async function startLiveCrashlyticsBridgeHost() {
  const bridge = createBridge({ version: '0.0.0-test', project: PROJECT_ID });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const traffic: ObservedCrashlyticsTraffic = {
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
      projectKey: 'kotlin-crashlytics-live-host',
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
          method.startsWith('crashlytics.') &&
          typeof attached === 'string' &&
          attached.length > 0
        ) {
          traffic.attachedAppCheckMethods.add(method);
        }
      }
      hostedRuntime.receive(inbound);
    },
    [],
    'kotlin-crashlytics-sandbox-peer',
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

describe('native Kotlin Crashlytics live-host conformance', () => {
  test('routes Crashlytics logs, reports, custom keys, and unsent queue over HostedRuntime WebSocket bridge', async () => {
    const host = await startLiveCrashlyticsBridgeHost();
    const ws = new WebSocket(host.bridgeUrl);
    try {
      const replies = new Map<string, (frame: WorkerResFrame) => void>();

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
        }
      });

      let seq = 0;
      const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `crash-smoke-${seq}`;
        return new Promise((resolveRes) => {
          replies.set(id, resolveRes);
          ws.send(JSON.stringify({ type: 'worker-op', id, op }));
        });
      };

      expect((await sendOp({ method: 'crashlytics.setUserId', userId: 'u-smoke' })).ok).toBe(true);
      expect(
        (await sendOp({ method: 'crashlytics.setCustomKeys', keys: { env: 'ci', step: 1 } })).ok,
      ).toBe(true);
      expect(
        (await sendOp({ method: 'crashlytics.log', message: 'opening view', timestampMs: 1_000 }))
          .ok,
      ).toBe(true);

      const recRes = await sendOp({
        method: 'crashlytics.recordError',
        name: 'java.lang.RuntimeException',
        message: 'boom',
        sdkPlatform: 'android',
        fatal: false,
      });
      expect(recRes.ok).toBe(true);

      expect(
        (await sendOp({ method: 'crashlytics.setCollectionEnabled', enabled: false })).ok,
      ).toBe(true);
      expect(
        (
          await sendOp({
            method: 'crashlytics.recordError',
            name: 'java.lang.RuntimeException',
            message: 'deferred-boom',
            sdkPlatform: 'android',
            deferred: true,
          })
        ).ok,
      ).toBe(true);

      const unsentCheck = await sendOp({ method: 'crashlytics.checkForUnsentReports' });
      expect(unsentCheck.ok).toBe(true);
      if (unsentCheck.ok) {
        expect((unsentCheck.value as { hasUnsentReports: boolean }).hasUnsentReports).toBe(true);
      }

      expect((await sendOp({ method: 'crashlytics.sendUnsentReports' })).ok).toBe(true);
      expect((await sendOp({ method: 'crashlytics.flush' })).ok).toBe(true);

      const stateRes = await sendOp({ method: 'crashlytics.getState' });
      expect(stateRes.ok).toBe(true);
      if (stateRes.ok) {
        const val = stateRes.value as {
          userId: string;
          reports: unknown[];
          unsentReports: unknown[];
        };
        expect(val.userId).toBe('u-smoke');
        expect(val.reports.length).toBe(2);
        expect(val.unsentReports.length).toBe(0);
      }
    } finally {
      ws.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipGradleRun)(
    'runs CrashlyticsLiveHostConformanceTest over OkHttp WebSocket against live HostedRuntime',
    async () => {
      if (!hasCompatibleJdk) {
        throw new Error(
          `PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK 11..24 on PATH or JAVA_HOME (detected: ${String(detectedJavaMajor)})`,
        );
      }

      const host = await startLiveCrashlyticsBridgeHost();
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
            'dev.pyric.e2e.CrashlyticsLiveHostConformanceTest',
            '--stacktrace',
            '--no-daemon',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL: host.bridgeUrl,
              PYRIC_REQUIRE_CRASHLYTICS_LIVE: '1',
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
            `Gradle CrashlyticsLiveHostConformanceTest exited ${String(exitCode)}:\n${stdout}\n${stderr}`,
          );
        }

        const xmlPath = resolve(
          KT_CLIENT_DIR,
          'build/test-results/test/TEST-dev.pyric.e2e.CrashlyticsLiveHostConformanceTest.xml',
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
        expect(xml).toContain('PYRIC_KT_CRASHLYTICS_LIVE_VERIFIED=1');

        for (const expectedMethod of [
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
