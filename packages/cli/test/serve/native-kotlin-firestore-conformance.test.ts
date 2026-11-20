import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import { mintCustomToken } from 'pyric/sandbox/internal';
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
const PROJECT_ID = 'demo-kotlin-firestore';

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
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /role_items/{role}/items/{itemId} {
      allow read, write: if request.auth != null && request.auth.token.role == role;
    }
    match /rooms/{roomId} {
      allow read: if request.auth == null || request.auth.token.role == 'member';
      allow write: if request.auth != null && request.auth.token.role == 'member';
    }
  }
}`;

const EMPTY_RTDB_RULES: RtdbRulesJson = {
  rules: {
    '.read': false,
    '.write': false,
  },
};

interface LiveFirestoreBridgeHost {
  readonly bridgeUrl: string;
  close(): Promise<void>;
}

async function startLiveFirestoreBridgeHost(): Promise<LiveFirestoreBridgeHost> {
  const bridge = createBridge({ version: 'test' });
  const persistence = makeInMemoryHostedPersistence();
  const runtime = await createHostedRuntime(
    {
      rules: FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: EMPTY_RTDB_RULES,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: `${PROJECT_ID}-default-rtdb`,
        projectId: PROJECT_ID,
        rules: {
          [`${PROJECT_ID}-default-rtdb`]: EMPTY_RTDB_RULES,
        },
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: PROJECT_ID,
      sessionToken: 'tok-kotlin-firestore-live-host',
      appOptions: {
        projectId: PROJECT_ID,
      },
    },
    'http://127.0.0.1:4401',
    (frame) => {
      bridge.handleSandboxMessage(frame);
    },
    REPO_ROOT,
    { persistence: persistence as never, record: false },
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    runtime.receive,
    [...runtime.toolNames],
    runtime.instanceId,
    [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY],
  );

  await runtime.deployRules('firestore', FIRESTORE_RULES);

  const sockets = new Set<WebSocket>();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    attachPeer(bridge, socket, false);
  });
  await once(server, 'listening');
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('Expected loopback TCP AddressInfo for Kotlin Firestore bridge host');
  }
  const addressInfo: AddressInfo = addr;

  return {
    bridgeUrl: `ws://127.0.0.1:${addressInfo.port}/__pyric/sandbox`,
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      server.close();
      unregisterPeer();
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

describe('native Kotlin Firestore live-host conformance', () => {
  test('enforces Firestore Security Rules and executes CRUD and queries over WebSocket', async () => {
    const host = await startLiveFirestoreBridgeHost();
    const socket = new WebSocket(host.bridgeUrl);
    try {
      const replies = new Map<string, (frame: WorkerResFrame) => void>();
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as BridgeMessage;
        if (frame.type === 'worker-res') {
          const handler = replies.get(frame.id);
          if (handler !== undefined) {
            replies.delete(frame.id);
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
          clientSessionId: 'kotlin-firestore-ws-smoke',
          clientInfo: { platform: 'kotlin' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = async (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `kt-fs-smoke-${seq}`;
        const replyPromise = new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
        });
        socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        return replyPromise;
      };

      const deniedAnon = await sendOp({
        method: 'setDoc',
        path: 'users/anon-user',
        data: { displayName: 'Anonymous' },
      });
      expect(deniedAnon.ok).toBe(false);
      if (!deniedAnon.ok) {
        expect(deniedAnon.error.code).toBe('permission-denied');
      }

      const created = await sendOp({
        method: 'auth.createUser',
        email: 'firestore-smoke@example.com',
        password: 'ProbePassword!123',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error(`Expected auth.createUser to succeed: ${created.error.message}`);
      }
      const userVal = (created.value as { user: { uid: string } }).user;

      const ownerSet = await sendOp({
        method: 'setDoc',
        path: `users/${userVal.uid}`,
        data: { displayName: 'Smoke Owner', visits: 1 },
      });
      expect(ownerSet.ok).toBe(true);

      const ownerGet = await sendOp({
        method: 'getDoc',
        path: `users/${userVal.uid}`,
      });
      expect(ownerGet.ok).toBe(true);
      if (!ownerGet.ok) {
        throw new Error('Expected owner getDoc to succeed');
      }
      const docVal = ownerGet.value as {
        exists: boolean;
        data: Record<string, unknown>;
      };
      expect(docVal.exists).toBe(true);
      let unpackedData: Record<string, unknown> = docVal.data;
      if (typeof docVal.data.json === 'string') {
        unpackedData = JSON.parse(docVal.data.json) as Record<string, unknown>;
      }
      expect(unpackedData.displayName).toBe('Smoke Owner');
      expect(unpackedData.visits).toBe(1);

      const deniedOther = await sendOp({
        method: 'setDoc',
        path: 'users/different-uid',
        data: { displayName: 'Intruder' },
      });
      expect(deniedOther.ok).toBe(false);
      if (!deniedOther.ok) {
        expect(deniedOther.error.code).toBe('permission-denied');
      }
    } finally {
      socket.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipGradleRun)(
    'runs packages/kt-client FirestoreLiveHostConformanceTest over OkHttp against live Node host',
    async () => {
      if (!hasCompatibleJdk) {
        throw new Error(
          `PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK >= 21, detected: ${String(detectedJavaMajor)}`,
        );
      }

      const host = await startLiveFirestoreBridgeHost();
      try {
        const moderatorCustomToken = mintCustomToken({
          uid: 'kt-firestore-moderator-01',
          claims: { role: 'moderator', tier: 'pro' },
          projectId: PROJECT_ID,
          nowMs: Date.now(),
        });
        const gradlew = resolve(KT_CLIENT_DIR, 'gradlew');
        const proc = Bun.spawn(
          [
            gradlew,
            '-p',
            KT_CLIENT_DIR,
            ':cleanTest',
            ':test',
            '--tests',
            'dev.pyric.e2e.FirestoreLiveHostConformanceTest',
            '--stacktrace',
            '--no-daemon',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PYRIC_LIVE_FIRESTORE_BRIDGE_URL: host.bridgeUrl,
              PYRIC_LIVE_FIRESTORE_PROJECT_ID: PROJECT_ID,
              PYRIC_LIVE_CUSTOM_TOKEN_VALID: moderatorCustomToken,
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
            `Gradle FirestoreLiveHostConformanceTest exited ${exitCode}:\n${stdout}\n${stderr}`,
          );
        }

        const xmlPath = resolve(
          KT_CLIENT_DIR,
          'build/test-results/test/TEST-dev.pyric.e2e.FirestoreLiveHostConformanceTest.xml',
        );
        expect(existsSync(xmlPath)).toBe(true);
        const xml = readFileSync(xmlPath, 'utf8');
        const testsMatch = /\btests="(\d+)"/.exec(xml);
        let executedTests = 0;
        if (testsMatch !== null) {
          const countGroup = testsMatch[1];
          if (countGroup !== undefined) {
            executedTests = Number.parseInt(countGroup, 10);
          }
        }
        expect(executedTests).toBeGreaterThanOrEqual(5);
        expect(xml).toContain('failures="0"');
        expect(xml).toContain('errors="0"');
        expect(xml).toContain('skipped="0"');
      } finally {
        await host.close();
      }
    },
    180_000,
  );
});
