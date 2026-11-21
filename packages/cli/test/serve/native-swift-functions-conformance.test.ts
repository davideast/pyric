import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { functionsCallableCaptureDir } from '@pyric/conformance/functions-callable-fixture';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { buildChildEnv } from '../../src/cli/sandbox-runner.js';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import {
  functionsChildrenOf,
  isAlive,
  killFunctionsChildren,
} from '../functions-http/children.js';
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
const CLI_ROOT = resolve(import.meta.dir, '../..');
const SWIFT_CLIENT_DIR = resolve(REPO_ROOT, 'packages/swift-client');
const PROJECT_ID = 'demo-swift-functions-live';
const IOS_APP_ID = '1:424242424242:ios:swiftfunctionsclient';

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

interface ObservedCallableRequest {
  method: string;
  pathname: string;
  hasAuthBearer: boolean;
  appCheckToken: string | null;
  acceptsEventStream: boolean;
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => resolveBody(raw));
    req.on('error', rejectBody);
  });
}

async function handleRegionalInt64Route(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readJsonBody(req);
  let echoedBigInput: unknown = null;
  try {
    const parsed = JSON.parse(rawBody) as { data?: Record<string, unknown> };
    if (parsed.data !== undefined && typeof parsed.data === 'object' && parsed.data !== null) {
      echoedBigInput = parsed.data.bigInput;
    }
  } catch {
    echoedBigInput = null;
  }
  const responsePayload = JSON.stringify({
    result: {
      region: 'europe-west1',
      receivedInput: echoedBigInput,
      int64: {
        '@type': 'type.googleapis.com/google.protobuf.Int64Value',
        value: '9007199254740993',
      },
    },
  });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(responsePayload)),
  });
  res.end(responsePayload);
}

async function startLiveSwiftFunctionsHost() {
  const childModulePath = join(CLI_ROOT, 'dist/functions/child.js');
  const registerPath = join(CLI_ROOT, 'dist/register/index.js');
  if (!existsSync(childModulePath) || !existsSync(registerPath)) {
    throw new Error(
      `CLI dist artifacts missing (${childModulePath}); run packages/cli build first.`,
    );
  }

  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';
  const observedRequests: ObservedCallableRequest[] = [];
  const observedBridgeOps: string[] = [];
  const mintedLimitedUseTokens: string[] = [];
  const pendingLimitedMintIds = new Set<string>();

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
      projectKey: REPO_ROOT,
      permissive: true,
      appOptions: {
        projectId: PROJECT_ID,
        appId: IOS_APP_ID,
      },
    },
    () => baseOrigin,
    (message) => {
      if (message.type === 'worker-res' && message.ok && pendingLimitedMintIds.has(message.id)) {
        pendingLimitedMintIds.delete(message.id);
        const payload = message.value as { token?: unknown } | null;
        if (payload !== null && typeof payload === 'object' && typeof payload.token === 'string') {
          mintedLimitedUseTokens.push(payload.token);
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
        if (typeof opRecord.method === 'string') {
          observedBridgeOps.push(opRecord.method);
          if (opRecord.method === 'appCheck.getLimitedUseToken') {
            pendingLimitedMintIds.add(inbound.id);
          }
        }
      }
      hostedRuntime.receive(inbound);
    },
    [...hostedRuntime.toolNames],
    hostedRuntime.instanceId,
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
  );

  const gateway = createFunctionsHttpGateway({
    projectId: PROJECT_ID,
    initial: { kind: 'starting' },
    plane: 'pyric-sandbox',
  });

  const regionalRoutePath = `/${PROJECT_ID}/europe-west1/regionalInt64Echo`;

  const server = createServer((req, res) => {
    let rawRequestUrl = '/';
    if (typeof req.url === 'string' && req.url.length > 0) {
      rawRequestUrl = req.url;
    }
    const reqUrl = new URL(rawRequestUrl, baseOrigin);
    if (reqUrl.pathname === '/__pyric/health') {
      const body = JSON.stringify({
        ok: true,
        mode: 'sandbox',
        sandboxConnected: true,
        instanceId: hostedRuntime.instanceId,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    const authHeader = req.headers.authorization;
    const rawAppCheckHeader = req.headers['x-firebase-appcheck'];
    let appCheckToken: string | null = null;
    if (typeof rawAppCheckHeader === 'string' && rawAppCheckHeader.length > 0) {
      appCheckToken = rawAppCheckHeader;
    }
    const acceptHeader = req.headers.accept;
    let observedMethod = 'GET';
    if (typeof req.method === 'string' && req.method.length > 0) {
      observedMethod = req.method;
    }
    observedRequests.push({
      method: observedMethod,
      pathname: reqUrl.pathname,
      hasAuthBearer: typeof authHeader === 'string' && authHeader.startsWith('Bearer '),
      appCheckToken,
      acceptsEventStream:
        typeof acceptHeader === 'string' && acceptHeader.includes('text/event-stream'),
    });

    if (req.method === 'POST' && reqUrl.pathname === regionalRoutePath) {
      void handleRegionalInt64Route(req, res);
      return;
    }

    void gateway.handle(req, res, () => true).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'not-found' } }));
      }
    });
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

  const fixtureCwd = join(functionsCallableCaptureDir, 'fixture');
  const fixtureEntry = join(fixtureCwd, 'index.cjs');
  const childEnv = buildChildEnv(process.env, {
    serveUrl: baseOrigin,
    registerUrl: pathToFileURL(registerPath).href,
    instanceId: hostedRuntime.instanceId,
  });

  const functionsChild = spawnFunctionsChild({
    cwd: fixtureCwd,
    entry: fixtureEntry,
    env: childEnv,
    instance: PROJECT_ID,
    location: 'us-central1',
    projectId: PROJECT_ID,
    childModuleUrl: childModulePath,
  });

  let readyResult: Awaited<FunctionsChildHandle['ready']>;
  try {
    readyResult = await functionsChild.ready;
  } catch (error) {
    await functionsChild.stop().catch(() => 0);
    server.close();
    unregisterPeer();
    await hostedRuntime.close();
    throw error;
  }
  let readyHttp = null;
  if (readyResult.http !== undefined) {
    readyHttp = readyResult.http;
  }
  gateway.update({ kind: 'ready', http: readyHttp });

  return {
    baseOrigin,
    bridgeUrl,
    observedRequests,
    observedBridgeOps,
    mintedLimitedUseTokens,
    async close() {
      gateway.update({ kind: 'stopped' });
      const childPid = functionsChild.child.pid;
      await functionsChild.stop().catch(() => 0);
      if (childPid !== undefined && isAlive(childPid)) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Process exited between liveness check and signal.
        }
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

function detectRunnableSwiftBinary(): string | null {
  const candidates: string[] = [];
  const fromPath = Bun.which('swift');
  if (fromPath !== null) {
    candidates.push(fromPath);
  }
  const localSwift = join(homedir(), '.local/bin/swift');
  if (existsSync(localSwift) && !candidates.includes(localSwift)) {
    candidates.push(localSwift);
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['test', '--version'], { encoding: 'utf8' });
    if (probe.error === undefined && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

const requireSwiftLive = process.env.PYRIC_REQUIRE_SWIFT_LIVE === '1';
const isGenericCiShard = process.env.CI === 'true' && !requireSwiftLive;
const detectedSwiftBinary = detectRunnableSwiftBinary();
const shouldSkipSwiftSubprocess =
  !requireSwiftLive && (isGenericCiShard || detectedSwiftBinary === null);

afterAll(() => {
  killFunctionsChildren(process.pid);
});

describe('native Swift PyricFunctions live-host callable conformance', () => {
  test(
    'serves real firebase-functions onCall v2, Int64Value, App Check gating, and SSE streaming over in-memory HostedRuntime',
    async () => {
      const host = await startLiveSwiftFunctionsHost();
      try {
        const echoRes = await fetch(
          `${host.baseOrigin}/${PROJECT_ID}/us-central1/pyricCallableEcho`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              data: {
                bigLong: {
                  '@type': 'type.googleapis.com/google.protobuf.Int64Value',
                  value: '9007199254740991',
                },
              },
            }),
          },
        );
        expect(echoRes.status).toBe(200);
        const echoJson = (await echoRes.json()) as {
          result?: { data?: { bigLong?: unknown } };
        };
        expect(String(echoJson.result?.data?.bigLong)).toBe('9007199254740991');

        const enforcedUnauth = await fetch(
          `${host.baseOrigin}/${PROJECT_ID}/us-central1/pyricCallableEnforced`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: null }),
          },
        );
        expect(enforcedUnauth.status).toBe(401);

        const streamRes = await fetch(
          `${host.baseOrigin}/${PROJECT_ID}/us-central1/pyricCallableStream`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body: JSON.stringify({ data: { chunks: ['s1', 's2'] } }),
          },
        );
        expect(streamRes.status).toBe(200);
        const sseText = await streamRes.text();
        expect(sseText).toContain('data: {"message":"s1"}');
        expect(sseText).toContain('data: {"message":"s2"}');
        expect(sseText).toContain('"acceptsStreaming":true');
      } finally {
        await host.close();
      }
    },
    60_000,
  );

  test.skipIf(shouldSkipSwiftSubprocess)(
    'runs packages/swift-client PyricFunctionsTests against live HostedRuntime + Functions HTTP gateway',
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

      const host = await startLiveSwiftFunctionsHost();

      try {
        const childEnv: Record<string, string> = {
          ...baseEnv,
          PYRIC_LIVE_BRIDGE_URL: host.bridgeUrl,
          PYRIC_LIVE_FUNCTIONS_URL: host.baseOrigin,
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
            'PyricFunctionsTests',
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

        const paths = host.observedRequests.map((entry) => entry.pathname);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableEcho`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableV1`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableEnforced`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableConsume`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableStream`);
        expect(paths).toContain(`/${PROJECT_ID}/europe-west1/regionalInt64Echo`);

        const authedRequests = host.observedRequests.filter(
          (entry) => entry.hasAuthBearer && entry.appCheckToken !== null,
        );
        expect(authedRequests.length).toBeGreaterThanOrEqual(3);

        const streamingRequests = host.observedRequests.filter(
          (entry) => entry.acceptsEventStream,
        );
        expect(streamingRequests.length).toBeGreaterThanOrEqual(3);

        expect(host.observedBridgeOps).toContain('auth.createUser');
        expect(host.observedBridgeOps).toContain('auth.getIdToken');
        expect(host.observedBridgeOps).toContain('appCheck.getToken');
        expect(host.observedBridgeOps).toContain('appCheck.getLimitedUseToken');
        expect(host.mintedLimitedUseTokens.length).toBeGreaterThanOrEqual(2);
        expect(host.mintedLimitedUseTokens[0]).not.toBe(host.mintedLimitedUseTokens[1]);

        // Replaying the first single-use App Check token proves pyricCallableConsume marked it consumed.
        const firstConsumedToken = host.mintedLimitedUseTokens[0];
        if (firstConsumedToken === undefined) {
          throw new Error('Expected minted limited-use App Check token from Swift live-host test');
        }
        const replayRes = await fetch(
          `${host.baseOrigin}/${PROJECT_ID}/us-central1/pyricCallableConsume`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-firebase-appcheck': firstConsumedToken,
            },
            body: JSON.stringify({ data: { replay: true } }),
          },
        );
        expect(replayRes.status).toBe(200);
        const replayJson = (await replayRes.json()) as {
          result?: { app?: { alreadyConsumed?: boolean } };
        };
        expect(replayJson.result?.app?.alreadyConsumed).toBe(true);
      } finally {
        await host.close();
      }

      expect(functionsChildrenOf(process.pid)).toEqual([]);
    },
    SWIFT_LIVE_HOST_TEST_TIMEOUT_MS,
  );
});
