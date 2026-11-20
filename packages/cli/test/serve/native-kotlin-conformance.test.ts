import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
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
import { connectDatabaseInstanceRules } from '../../src/serve/database-instance-rules-host.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { RtdbRulesJson } from '../../src/serve/init-payload.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const KT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/kt-client');
const PROJECT_ID = 'demo-kotlin-live';
const DEFAULT_INSTANCE = `${PROJECT_ID}-default-rtdb`;

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
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

const MAIN_RTDB_RULES: RtdbRulesJson = {
  rules: {
    profiles: {
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
    public: {
      '.read': true,
      '.write': 'auth != null',
      items: {
        '.indexOn': ['score', 'category', 'meta/rank', '.value'],
      },
    },
  },
};

function buildShardedRtdbRules(): Record<string, RtdbRulesJson> {
  const rulesByInstance: Record<string, RtdbRulesJson> = {
    [DEFAULT_INSTANCE]: MAIN_RTDB_RULES,
    [`${PROJECT_ID}-shard-00`]: {
      rules: {
        rooms: {
          $roomId: {
            members: {
              $uid: {
                '.read': 'auth != null',
                '.write': 'auth != null && auth.uid === $uid',
              },
            },
          },
        },
      },
    },
    [`${PROJECT_ID}-shard-01`]: {
      rules: {
        rooms: {
          $roomId: {
            members: {
              $uid: {
                '.read': false,
                '.write': false,
              },
            },
          },
        },
        audit: {
          $uid: {
            '.read': 'auth != null && auth.uid === $uid',
            '.write': 'auth != null && auth.uid === $uid',
          },
        },
      },
    },
  };

  for (let index = 2; index <= 9; index += 1) {
    const shardTag = `shard-0${index}`;
    rulesByInstance[`${PROJECT_ID}-${shardTag}`] = {
      rules: {
        shards: {
          [shardTag]: {
            $uid: {
              '.read': 'auth != null && auth.uid === $uid',
              '.write': 'auth != null && auth.uid === $uid',
            },
          },
        },
      },
    };
  }
  return rulesByInstance;
}

interface LiveKotlinBridgeHost {
  readonly bridgeUrl: string;
  close(): Promise<void>;
}

async function startLiveKotlinBridgeHost(): Promise<LiveKotlinBridgeHost> {
  const bridge = createBridge({ version: 'test' });
  const persistence = makeInMemoryHostedPersistence();
  const runtime = await createHostedRuntime(
    {
      rules: null,
      rulesHash: null,
      databaseRules: MAIN_RTDB_RULES,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: PROJECT_ID,
      sessionToken: 'tok-kotlin-live-host',
      appOptions: { projectId: PROJECT_ID },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      bridge.handleSandboxMessage(frame);
    },
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  bridge.registerSandboxPeer(
    runtime.receive,
    [...runtime.toolNames],
    runtime.instanceId,
    [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY],
  );

  await runtime.deployRules('database', JSON.stringify(MAIN_RTDB_RULES));
  connectDatabaseInstanceRules(runtime.databaseRules, {
    defaultInstance: DEFAULT_INSTANCE,
    rules: buildShardedRtdbRules(),
  });

  const sockets = new Set<WebSocket>();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    attachPeer(bridge, socket, true);
  });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    bridgeUrl: `ws://127.0.0.1:${address.port}/__pyric/sandbox`,
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      server.close();
      await runtime.close();
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

describe('native Kotlin client live-host conformance', () => {
  test('boots sharded 11-instance RTDB + Auth bridge host and enforces per-shard rules over WebSocket', async () => {
    const host = await startLiveKotlinBridgeHost();
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
          clientSessionId: 'kotlin-smoke-probe',
          clientInfo: { platform: 'kotlin' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = async (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `kotlin-smoke-${seq}`;
        const replyPromise = new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
        });
        socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        return replyPromise;
      };

      const created = await sendOp({
        method: 'auth.createUser',
        email: 'probe@example.com',
        password: 'ProbePassword!123',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error('Expected auth.createUser to succeed');
      }
      const userVal = (created.value as { user: { uid: string } }).user;

      const shard00Allowed = await sendOp({
        method: 'rtdb.set',
        instance: `${PROJECT_ID}-shard-00`,
        path: `rooms/r1/members/${userVal.uid}`,
        value: { role: 'host' },
      });
      expect(shard00Allowed.ok).toBe(true);

      const shard01Denied = await sendOp({
        method: 'rtdb.set',
        instance: `${PROJECT_ID}-shard-01`,
        path: `rooms/r1/members/${userVal.uid}`,
        value: { role: 'host' },
      });
      expect(shard01Denied.ok).toBe(false);
    } finally {
      socket.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipGradleRun)(
    'runs packages/kt-client LiveHostConformanceTest over OkHttp WebSocket against live Node host',
    async () => {
      if (!hasCompatibleJdk) {
        throw new Error(
          `PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK >= 21, detected: ${String(detectedJavaMajor)}`,
        );
      }
      const host = await startLiveKotlinBridgeHost();
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
            'dev.pyric.e2e.*LiveHostConformanceTest',
            '--stacktrace',
            '--no-daemon',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
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
            `Gradle LiveHostConformanceTest exited ${exitCode}:\n${stdout}\n${stderr}`,
          );
        }

        const resultsDir = resolve(KT_CLIENT_DIR, 'build/test-results/test');
        expect(existsSync(resultsDir)).toBe(true);
        const reportPattern = /^TEST-dev\.pyric\.e2e\..*LiveHostConformanceTest\.xml$/;
        const reportFiles = readdirSync(resultsDir).filter((name) => reportPattern.test(name));
        expect(reportFiles.length).toBeGreaterThanOrEqual(1);

        let totalTests = 0;
        for (const fileName of reportFiles) {
          const xml = readFileSync(resolve(resultsDir, fileName), 'utf8');
          const countMatch = /\btests="(\d+)"/.exec(xml);
          expect(countMatch).not.toBeNull();
          if (countMatch !== null) {
            const countRaw = countMatch[1];
            if (countRaw !== undefined) {
              const parsedCount = Number.parseInt(countRaw, 10);
              expect(parsedCount).toBeGreaterThan(0);
              totalTests += parsedCount;
            }
          }
          expect(xml).toContain('skipped="0"');
          expect(xml).toContain('failures="0"');
          expect(xml).toContain('errors="0"');
        }
        expect(totalTests).toBeGreaterThanOrEqual(2);
      } finally {
        await host.close();
      }
    },
    180_000,
  );
});
