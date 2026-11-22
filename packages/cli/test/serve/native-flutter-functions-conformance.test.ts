import { afterAll, describe, expect, test } from 'bun:test';
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
import { functionsChildrenOf, isAlive, killFunctionsChildren } from '../functions-http/children.js';
import { resolveNodeExecutable } from './require-node-on-path.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_ROOT = resolve(import.meta.dir, '../..');
const FLUTTER_CLIENT_DIR = join(REPO_ROOT, 'packages/flutter-client');
const PROJECT_ID = 'demo-flutter-functions-live';

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
  hasAppCheck: boolean;
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

async function startLiveFlutterFunctionsHost() {
  resolveNodeExecutable();
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
          observedBridgeOps.push(opRecord.method);
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
    const reqUrl = new URL(req.url ?? '/', baseOrigin);
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
    const appCheckHeader = req.headers['x-firebase-appcheck'];
    const acceptHeader = req.headers.accept;
    observedRequests.push({
      method: req.method ?? 'GET',
      pathname: reqUrl.pathname,
      hasAuthBearer: typeof authHeader === 'string' && authHeader.startsWith('Bearer '),
      hasAppCheck: typeof appCheckHeader === 'string' && appCheckHeader.length > 0,
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
  gateway.update({ kind: 'ready', http: readyResult.http ?? null });

  return {
    baseOrigin,
    bridgeUrl,
    observedRequests,
    observedBridgeOps,
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

function detectFlutterBinary(): string | null {
  const fromPath = Bun.which('flutter');
  if (fromPath !== null) {
    return fromPath;
  }
  const home = homedir();
  const candidates = [
    join(home, '.local/bin/flutter'),
    join(home, '.local/flutter/bin/flutter'),
    join(home, 'flutter/bin/flutter'),
    join(home, 'fvm/default/bin/flutter'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const detectedFlutter = detectFlutterBinary();
const requireFlutterLive = process.env.PYRIC_REQUIRE_FLUTTER_LIVE === '1';
const shouldSkipFlutterSubprocess = detectedFlutter === null && !requireFlutterLive;

afterAll(() => {
  killFunctionsChildren(process.pid);
});

describe('Flutter pyric_functions live-host callable conformance', () => {
  test(
    'serves real firebase-functions onCall v2, v1, App Check, and SSE streaming over in-memory HostedRuntime',
    async () => {
      const host = await startLiveFlutterFunctionsHost();
      try {
        const echoRes = await fetch(
          `${host.baseOrigin}/${PROJECT_ID}/us-central1/pyricCallableEcho`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: { smoke: 'wire' } }),
          },
        );
        expect(echoRes.status).toBe(200);
        const echoJson = (await echoRes.json()) as { result?: { data?: unknown } };
        expect(echoJson.result?.data).toEqual({ smoke: 'wire' });

        const enforcedUnauth = await fetch(
          `${host.baseOrigin}/${PROJECT_ID}/us-central1/pyricCallableEnforced`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: null }),
          },
        );
        expect(enforcedUnauth.status).toBe(401);
      } finally {
        await host.close();
      }
    },
    60_000,
  );

  test.skipIf(shouldSkipFlutterSubprocess)(
    'runs packages/flutter-client functions_live_host_test.dart against live HostedRuntime + Functions HTTP gateway',
    async () => {
      if (detectedFlutter === null) {
        throw new Error('PYRIC_REQUIRE_FLUTTER_LIVE=1 is set, but `flutter` was not found.');
      }
      const host = await startLiveFlutterFunctionsHost();

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
        childEnv.PYRIC_LIVE_FUNCTIONS_URL = host.baseOrigin;
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
          [detectedFlutter, 'test', '--no-pub', 'test/live_host/functions_live_host_test.dart'],
          { cwd: FLUTTER_CLIENT_DIR, env: childEnv, stdout: 'pipe', stderr: 'pipe' },
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

        const paths = host.observedRequests.map((entry) => entry.pathname);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableEcho`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableV1`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableEnforced`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableConsume`);
        expect(paths).toContain(`/${PROJECT_ID}/us-central1/pyricCallableStream`);
        expect(paths).toContain(`/${PROJECT_ID}/europe-west1/regionalInt64Echo`);

        const authedRequests = host.observedRequests.filter(
          (entry) => entry.hasAuthBearer && entry.hasAppCheck,
        );
        expect(authedRequests.length).toBeGreaterThanOrEqual(3);

        const streamingRequests = host.observedRequests.filter(
          (entry) => entry.acceptsEventStream,
        );
        expect(streamingRequests.length).toBeGreaterThanOrEqual(2);

        expect(host.observedBridgeOps).toContain('auth.createUser');
        expect(host.observedBridgeOps).toContain('auth.getIdToken');
        expect(host.observedBridgeOps).toContain('appCheck.getToken');
        expect(host.observedBridgeOps).toContain('appCheck.getLimitedUseToken');
      } finally {
        await host.close();
      }
      expect(functionsChildrenOf(process.pid)).toEqual([]);
    },
    180_000,
  );
});
