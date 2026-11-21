import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { createMemoryBackend } from 'pyric/sandbox';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import {
  STORAGE_BYTE_ROUTE_CAPABILITY,
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createBlobStore } from '../../src/serve/hosted/persistence/blob-store.js';
import { inTransaction, type SqlConnection, type SqlRow } from '../../src/serve/hosted/persistence/sqlite.js';
import { createSqliteStorage } from '../../src/serve/hosted/persistence/storage.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { RtdbRulesJson } from '../../src/serve/init-payload.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const KT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/kt-client');
const PROJECT_ID = 'demo-kotlin-storage';
const DEFAULT_BUCKET = `${PROJECT_ID}.appspot.com`;
const CUSTOM_BUCKET = 'kotlin-custom-bucket';

const STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /{allPaths=**} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

const LOCKED_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

const LOCKED_RTDB_RULES: RtdbRulesJson = {
  rules: { '.read': false, '.write': false },
};

function openBunMemorySqlConnection(): SqlConnection {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE storage_objects (
      bucket TEXT NOT NULL,
      path TEXT NOT NULL,
      metadata TEXT NOT NULL,
      mime TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY (bucket, path)
    ) STRICT;
    CREATE TABLE storage_generations (
      bucket TEXT NOT NULL,
      path TEXT NOT NULL,
      generation TEXT NOT NULL,
      PRIMARY KEY (bucket, path)
    ) STRICT;
  `);
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    prepare(sql: string) {
      const stmt = db.query(sql);
      return {
        run(...values) {
          return stmt.run(...values);
        },
        get(...values) {
          const row = stmt.get(...values);
          if (row === null || row === undefined) return undefined;
          return row as SqlRow;
        },
        all(...values) {
          return stmt.all(...values) as SqlRow[];
        },
      };
    },
    close() {
      db.close();
    },
  };
}

function makeTestHostedPersistence(projectDir: string): HostedPersistence {
  const sqlConn = openBunMemorySqlConnection();
  const blobStore = createBlobStore(join(projectDir, 'objects'));
  const storage = createSqliteStorage(sqlConn, (work) => inTransaction(sqlConn, work), blobStore);
  const seedFn = async () => false;
  return {
    backend: createMemoryBackend(),
    storage,
    checkpoints: {} as HostedPersistence['checkpoints'],
    state: { seed: seedFn } as unknown as HostedPersistence['state'],
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {
      sqlConn.close();
    },
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
    seed: seedFn,
  };
}

interface LiveStorageBridgeHost {
  readonly baseOrigin: string;
  readonly bridgeUrl: string;
  close(): Promise<void>;
}

async function startLiveStorageBridgeHost(): Promise<LiveStorageBridgeHost> {
  const projectDir = createPrivateJobTmpDir('kt-stor-host');
  const persistence = makeTestHostedPersistence(projectDir);
  const bridge = createBridge({ version: 'test', project: PROJECT_ID, projectKey: projectDir });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const runtime = await createHostedRuntime(
    {
      rules: LOCKED_FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: LOCKED_RTDB_RULES,
      databaseRulesHash: null,
      storageRules: STORAGE_RULES,
      storageRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: projectDir,
      appOptions: { projectId: PROJECT_ID, storageBucket: DEFAULT_BUCKET },
    },
    () => baseOrigin,
    (frame) => {
      bridge.handleSandboxMessage(frame);
    },
    projectDir,
    { persistence, record: false, requireSessionToken: false },
  );

  await runtime.deployRules('storage', STORAGE_RULES);
  await runtime.deployRules('storage', STORAGE_RULES, { bucket: CUSTOM_BUCKET });

  const unregisterPeer = bridge.registerSandboxPeer(
    runtime.receive,
    [...runtime.toolNames],
    runtime.instanceId,
    [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY, STORAGE_BYTE_ROUTE_CAPABILITY],
  );

  const server = createServer((req, res) => {
    let rawUrl = '/';
    if (typeof req.url === 'string') rawUrl = req.url;
    const parsedUrl = new URL(rawUrl, baseOrigin);
    void runtime.storageHttp(req, res, parsedUrl).then(
      (handled) => {
        if (!handled && !res.headersSent) res.writeHead(404).end();
      },
      () => {
        if (!res.headersSent) res.writeHead(500).end();
      },
    );
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/__pyric/sandbox') {
      wss.handleUpgrade(req, socket, head, (ws) => attachPeer(bridge, ws, false));
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('Expected loopback TCP AddressInfo for Kotlin Storage bridge host');
  }
  const addressInfo: AddressInfo = addr;
  baseOrigin = `http://127.0.0.1:${addressInfo.port}`;
  const bridgeUrl = `ws://127.0.0.1:${addressInfo.port}/__pyric/sandbox`;

  return {
    baseOrigin,
    bridgeUrl,
    async close() {
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
      server.close();
      unregisterPeer();
      await runtime.close();
      persistence.close();
      removePrivateJobTmpDir(projectDir);
    },
  };
}

function detectCompatibleJavaMajor(): number | null {
  let javaBin = 'java';
  const javaHome = process.env.JAVA_HOME;
  if (typeof javaHome === 'string' && javaHome.length > 0) {
    const candidate = resolve(javaHome, 'bin/java');
    if (existsSync(candidate)) javaBin = candidate;
  }
  const probe = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
  if (probe.error !== undefined) return null;
  let combined = '';
  if (typeof probe.stderr === 'string') combined += probe.stderr;
  if (typeof probe.stdout === 'string') combined += `\n${probe.stdout}`;
  const match = /version "(\d+)(?:[."]|$)/.exec(combined);
  if (match === null) return null;
  const majorRaw = match[1];
  if (majorRaw === undefined) return null;
  const major = Number.parseInt(majorRaw, 10);
  if (Number.isNaN(major)) return null;
  return major;
}

const requireKotlinLive = process.env.PYRIC_REQUIRE_KOTLIN_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireKotlinLive;
const detectedJavaMajor = detectCompatibleJavaMajor();
const hasCompatibleJdk = detectedJavaMajor !== null && detectedJavaMajor >= 21;
const shouldSkipGradleRun = !requireKotlinLive && (isGenericCiShard || !hasCompatibleJdk);

describe('native Kotlin Storage live-host conformance', () => {
  test('enforces Storage Security Rules and transfers bytes over HostedRuntime WebSocket + HTTP byte route', async () => {
    const host = await startLiveStorageBridgeHost();
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
          clientSessionId: 'kotlin-storage-ws-smoke',
          clientInfo: { platform: 'kotlin' },
        } satisfies BridgeMessage),
      );
      await ackPromise;

      let seq = 0;
      const sendOp = async (op: Record<string, unknown>): Promise<WorkerResFrame> => {
        seq += 1;
        const id = `kt-stor-smoke-${seq}`;
        const replyPromise = new Promise<WorkerResFrame>((resolveReply) => {
          replies.set(id, resolveReply);
        });
        socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
        return replyPromise;
      };

      const deniedAnon = await sendOp({
        method: 'storage.beginUpload',
        path: 'smoke/hello.txt',
        size: 5,
        defaultBucket: DEFAULT_BUCKET,
      });
      expect(deniedAnon.ok).toBe(false);
      if (!deniedAnon.ok) expect(deniedAnon.error.code).toBe('storage/unauthorized');

      const created = await sendOp({
        method: 'auth.createUser',
        email: 'storage-smoke@example.com',
        password: 'SmokePassword!123',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(`auth.createUser failed: ${created.error.message}`);
      const userUid = (created.value as { user: { uid: string } }).user.uid;
      const userLens = { mode: 'as', uid: userUid };

      const payloadBytes = new TextEncoder().encode('hello-storage');
      const begun = await sendOp({
        method: 'storage.beginUpload',
        path: 'smoke/hello.txt',
        size: payloadBytes.byteLength,
        contentType: 'text/plain',
        defaultBucket: DEFAULT_BUCKET,
        actAs: userLens,
      });
      expect(begun.ok).toBe(true);
      if (!begun.ok) throw new Error('Expected storage.beginUpload to succeed');
      const begunVal = begun.value as { uploadId: string; uploadUrl: string };
      const putRes = await fetch(new URL(begunVal.uploadUrl, host.baseOrigin).href, {
        method: 'PUT',
        headers: {
          'content-range': `bytes 0-${payloadBytes.byteLength - 1}/${payloadBytes.byteLength}`,
        },
        body: payloadBytes,
      });
      expect(putRes.status).toBe(200);

      const finished = await sendOp({
        method: 'storage.finishUpload',
        uploadId: begunVal.uploadId,
        actAs: userLens,
      });
      expect(finished.ok).toBe(true);

      const dlUrlRes = await sendOp({
        method: 'storage.getDownloadURL',
        path: 'smoke/hello.txt',
        defaultBucket: DEFAULT_BUCKET,
        actAs: userLens,
      });
      expect(dlUrlRes.ok).toBe(true);
      if (!dlUrlRes.ok) throw new Error('Expected storage.getDownloadURL to succeed');
      const dlPath = (dlUrlRes.value as { path: string }).path;
      const tokenFetch = await fetch(new URL(dlPath, host.baseOrigin).href);
      expect(tokenFetch.status).toBe(200);
      expect(await tokenFetch.text()).toBe('hello-storage');

      const listed = await sendOp({
        method: 'storage.listAll',
        path: 'smoke',
        defaultBucket: DEFAULT_BUCKET,
        actAs: userLens,
      });
      expect(listed.ok).toBe(true);

      const deleted = await sendOp({
        method: 'storage.deleteObject',
        path: 'smoke/hello.txt',
        defaultBucket: DEFAULT_BUCKET,
        actAs: userLens,
      });
      expect(deleted.ok).toBe(true);
    } finally {
      socket.terminate();
      await host.close();
    }
  });

  test.skipIf(shouldSkipGradleRun)(
    'runs packages/kt-client StorageLiveHostConformanceTest over OkHttp against live Node host',
    async () => {
      if (!hasCompatibleJdk) {
        throw new Error(
          `PYRIC_REQUIRE_KOTLIN_LIVE=1 requires JDK >= 21, detected: ${String(detectedJavaMajor)}`,
        );
      }

      const host = await startLiveStorageBridgeHost();
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
            'dev.pyric.e2e.Storage*LiveHostConformanceTest',
            '--stacktrace',
            '--no-daemon',
          ],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PYRIC_LIVE_STORAGE_BRIDGE_URL: host.bridgeUrl,
              PYRIC_LIVE_STORAGE_PROJECT_ID: PROJECT_ID,
              PYRIC_LIVE_STORAGE_DEFAULT_BUCKET: DEFAULT_BUCKET,
              PYRIC_LIVE_STORAGE_CUSTOM_BUCKET: CUSTOM_BUCKET,
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
            `Gradle Storage*LiveHostConformanceTest exited ${exitCode}:\n${stdout}\n${stderr}`,
          );
        }

        const resultsDir = resolve(KT_CLIENT_DIR, 'build/test-results/test');
        expect(existsSync(resultsDir)).toBe(true);
        const reportPattern = /^TEST-dev\.pyric\.e2e\.Storage.*LiveHostConformanceTest\.xml$/;
        const reportNames = readdirSync(resultsDir).filter((entry) => reportPattern.test(entry));
        expect(reportNames.length).toBeGreaterThanOrEqual(1);

        let totalExecutedTests = 0;
        for (const reportName of reportNames) {
          const xml = readFileSync(resolve(resultsDir, reportName), 'utf8');
          const testsMatch = /\btests="(\d+)"/.exec(xml);
          let executedTests = 0;
          if (testsMatch !== null) {
            const countGroup = testsMatch[1];
            if (countGroup !== undefined) executedTests = Number.parseInt(countGroup, 10);
          }
          expect(executedTests).toBeGreaterThanOrEqual(1);
          expect(xml).toContain('failures="0"');
          expect(xml).toContain('errors="0"');
          expect(xml).toContain('skipped="0"');
          totalExecutedTests += executedTests;
        }
        expect(totalExecutedTests).toBeGreaterThanOrEqual(5);
      } finally {
        await host.close();
      }
    },
    180_000,
  );
});
