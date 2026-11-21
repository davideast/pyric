/**
 * Live-host Crashlytics conformance harness for the Flutter client SDK
 * (`packages/flutter-client/lib/pyric_crashlytics.dart`).
 *
 * Boots an in-memory loopback Pyric bridge host (`createHostedRuntime` +
 * `host-crashlytics.ts`), verifies all 10 `crashlytics.*` WebSocket operations
 * directly, and executes `flutter test` against
 * `test/crashlytics/crashlytics_live_host_test.dart` with inbound App Check
 * token verification.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  DOC_VALUE_ENCODING_CAPABILITY,
  MAX_BRIDGE_FRAME_BYTES,
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import type { InitPayload } from '../../src/serve/init-payload.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const FLUTTER_CLIENT_DIR = join(REPO_ROOT, 'packages/flutter-client');
const PROJECT_ID = 'demo-flutter-crashlytics-live';

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

function detectFlutterBinary(): string | null {
  const fromPath = Bun.which('flutter');
  if (fromPath !== null) return fromPath;
  const home = homedir();
  for (const rel of ['.local/bin/flutter', '.local/flutter/bin/flutter']) {
    const candidate = join(home, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function shouldSkipLiveFlutterRun(flutterBinary: string | null, env: NodeJS.ProcessEnv): boolean {
  if (env.PYRIC_REQUIRE_FLUTTER_LIVE === '1') return false;
  if (env.CI === 'true') return true;
  return flutterBinary === null;
}

const DETECTED_FLUTTER_BINARY = detectFlutterBinary();
const SKIPS_FLUTTER_SUBPROCESS = shouldSkipLiveFlutterRun(
  DETECTED_FLUTTER_BINARY,
  process.env,
);

interface LoopbackCrashlyticsHost {
  readonly port: number;
  readonly wsUrl: string;
  readonly observedOps: string[];
  readonly attachedAppCheckMethods: Set<string>;
  close(): Promise<void>;
}

async function closeWebSocketServer(
  wss: WebSocketServer,
  sockets: Set<WebSocket>,
): Promise<void> {
  for (const socket of sockets) {
    socket.terminate();
  }
  sockets.clear();
  await new Promise<void>((resolveClose) => {
    const fallback = setTimeout(() => resolveClose(), 200);
    fallback.unref();
    wss.close(() => {
      clearTimeout(fallback);
      resolveClose();
    });
  });
}

async function startLoopbackCrashlyticsHost(): Promise<LoopbackCrashlyticsHost> {
  const sockets = new Set<WebSocket>();
  const observedOps: string[] = [];
  const attachedAppCheckMethods = new Set<string>();
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    path: '/__pyric/sandbox',
    maxPayload: MAX_BRIDGE_FRAME_BYTES,
  });
  await once(wss, 'listening');
  const address = wss.address();
  const hasBoundPort = address !== null && typeof address === 'object';
  if (!hasBoundPort) {
    await closeWebSocketServer(wss, sockets);
    throw new Error('Expected bound IPv4 AddressInfo for Crashlytics WebSocketServer.');
  }
  const port = (address as AddressInfo).port;
  const wsUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });

  let runtime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  let disconnectHosted: (() => void) | undefined;
  try {
    const payload: InitPayload = {
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
      bridgeUrl: wsUrl,
      seed: null,
      capture: false,
      hosted: true,
      permissive: true,
      projectKey: REPO_ROOT,
      appOptions: { projectId: PROJECT_ID },
    };
    runtime = await createHostedRuntime(
      payload,
      baseUrl,
      (message) => bridge.handleSandboxMessage(message),
      REPO_ROOT,
      { persistence: makeInMemoryHostedPersistence(), record: false },
    );
    const activeRuntime = runtime;
    disconnectHosted = bridge.registerSandboxPeer(
      (inbound) => {
        if (inbound.type === 'worker-op') {
          const opRecord = inbound.op as Record<string, unknown>;
          const method = opRecord.method;
          const attached = opRecord.appCheckToken;
          if (typeof method === 'string') {
            observedOps.push(method);
            if (
              method.startsWith('crashlytics.') &&
              typeof attached === 'string' &&
              attached.length > 0
            ) {
              attachedAppCheckMethods.add(method);
            }
          }
        }
        activeRuntime.receive(inbound);
      },
      [...activeRuntime.toolNames],
      activeRuntime.instanceId,
      [
        WORKER_PORT_CAPABILITY,
        WORKER_RELAY_CAPABILITY,
        DOC_VALUE_ENCODING_CAPABILITY,
      ],
    );
    wss.on('connection', (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      attachPeer(bridge, ws, false);
    });
  } catch (error) {
    disconnectHosted?.();
    await closeWebSocketServer(wss, sockets);
    await runtime?.close();
    throw error;
  }

  const hostedRuntime = runtime;
  const unregisterPeer = disconnectHosted;
  return {
    port,
    wsUrl,
    observedOps,
    attachedAppCheckMethods,
    async close(): Promise<void> {
      try {
        await closeWebSocketServer(wss, sockets);
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
  readonly value?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface AttachedCrashlyticsSocket {
  sendOp(op: Record<string, unknown>): Promise<WireFrame>;
  close(): Promise<void>;
}

async function openAttachedCrashlyticsSocket(
  wsUrl: string,
): Promise<AttachedCrashlyticsSocket> {
  const ws = new WebSocket(wsUrl);
  const waiters = new Map<string, (frame: WireFrame) => void>();
  let attachWaiter: ((frame: WireFrame) => void) | null = null;
  let sequence = 0;

  ws.on('message', (raw) => {
    const parsed = JSON.parse(String(raw)) as WireFrame;
    if (parsed.type === 'attach-ack' && attachWaiter !== null) {
      const resume = attachWaiter;
      attachWaiter = null;
      resume(parsed);
      return;
    }
    if (parsed.type === 'worker-res' && typeof parsed.id === 'string') {
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
    const timer = setTimeout(
      () => rejectAck(new Error('Timed out waiting for attach-ack')),
      5_000,
    );
    attachWaiter = (frame) => {
      clearTimeout(timer);
      resolveAck(frame);
    };
    ws.send(
      JSON.stringify({
        type: 'attach',
        protocol: 1,
        clientInfo: { platform: 'flutter' },
        capabilities: [DOC_VALUE_ENCODING_CAPABILITY],
      }),
    );
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

interface FlutterMachineSummary {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

function summarizeFlutterMachineOutput(stdout: string): FlutterMachineSummary {
  const namesById = new Map<number, string>();
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const rawLine of stdout.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      parsed.type === 'testStart' &&
      typeof parsed.test === 'object' &&
      parsed.test !== null
    ) {
      const testObj = parsed.test as { id?: unknown; name?: unknown };
      if (typeof testObj.id === 'number' && typeof testObj.name === 'string') {
        namesById.set(testObj.id, testObj.name);
      }
      continue;
    }
    if (parsed.type !== 'testDone' || parsed.hidden === true) {
      continue;
    }
    let testName = '';
    if (typeof parsed.testID === 'number') {
      const recorded = namesById.get(parsed.testID);
      if (recorded !== undefined) {
        testName = recorded;
      }
    }
    if (testName.startsWith('loading ')) {
      continue;
    }
    if (parsed.skipped === true) {
      skipped += 1;
    } else if (parsed.result === 'success') {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return { passed, failed, skipped };
}

describe('Flutter Crashlytics live-host conformance', () => {
  test('loopback WebSocket bridge routes all 10 crashlytics.* operations with sdkPlatform flutter', async () => {
    const host = await startLoopbackCrashlyticsHost();
    let client: AttachedCrashlyticsSocket | undefined;
    try {
      client = await openAttachedCrashlyticsSocket(host.wsUrl);

      expect(
        (await client.sendOp({ method: 'crashlytics.setUserId', userId: 'u-flutter-smoke' })).ok,
      ).toBe(true);
      expect(
        (
          await client.sendOp({
            method: 'crashlytics.setCustomKeys',
            keys: { screen: 'home', attempt: 1, online: true },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await client.sendOp({
            method: 'crashlytics.log',
            message: 'flutter-wire-crumb',
            timestampMs: 1_500,
          })
        ).ok,
      ).toBe(true);

      const recRes = await client.sendOp({
        method: 'crashlytics.recordError',
        name: 'StateError',
        message: 'Bad state: empty cart',
        stack: '#0 main (file:///app/main.dart:10:5)',
        sdkPlatform: 'flutter',
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
            name: 'StateError',
            message: 'discarded-unsent',
            sdkPlatform: 'flutter',
            deferred: true,
          })
        ).ok,
      ).toBe(true);
      expect((await client.sendOp({ method: 'crashlytics.deleteUnsentReports' })).ok).toBe(true);

      expect(
        (
          await client.sendOp({
            method: 'crashlytics.recordError',
            name: 'CrashlyticsSimulatedCrashError',
            message: 'promoted-fatal',
            sdkPlatform: 'flutter',
            fatal: true,
            deferred: true,
          })
        ).ok,
      ).toBe(true);

      const unsentRes = await client.sendOp({ method: 'crashlytics.checkForUnsentReports' });
      expect(unsentRes.ok).toBe(true);
      const unsentVal = unsentRes.value as { hasUnsentReports?: boolean } | undefined;
      expect(unsentVal?.hasUnsentReports).toBe(true);

      expect((await client.sendOp({ method: 'crashlytics.sendUnsentReports' })).ok).toBe(true);
      expect((await client.sendOp({ method: 'crashlytics.flush' })).ok).toBe(true);

      const stateRes = await client.sendOp({ method: 'crashlytics.getState' });
      expect(stateRes.ok).toBe(true);
      const stateVal = stateRes.value as {
        userId?: string;
        didCrashOnPreviousExecution?: boolean;
        reports?: Array<{ sdkPlatform?: string; flushed?: boolean }>;
        unsentReports?: unknown[];
      };
      expect(stateVal.userId).toBe('u-flutter-smoke');
      expect(stateVal.didCrashOnPreviousExecution).toBe(true);
      expect(stateVal.reports?.length).toBe(2);
      expect(stateVal.reports?.[0]?.sdkPlatform).toBe('flutter');
      expect(stateVal.reports?.[0]?.flushed).toBe(true);
      expect(stateVal.unsentReports?.length).toBe(0);
    } finally {
      await client?.close();
      await host.close();
    }
  });

  test.skipIf(SKIPS_FLUTTER_SUBPROCESS)(
    'Flutter pyric_crashlytics live-host suite passes against HostedRuntime CrashlyticsBroker',
    async () => {
      const flutterBinary = detectFlutterBinary();
      if (flutterBinary === null) {
        throw new Error(
          'PYRIC_REQUIRE_FLUTTER_LIVE=1 is set, but `flutter` was not found.',
        );
      }

      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          childEnv[key] = value;
        }
      }
      const localBin = join(homedir(), '.local/bin');
      let existingPath = '';
      if (typeof childEnv.PATH === 'string') {
        existingPath = childEnv.PATH;
      }
      if (existingPath.length > 0 && !existingPath.includes(localBin)) {
        childEnv.PATH = `${localBin}:${existingPath}`;
      } else if (existingPath.length === 0) {
        childEnv.PATH = localBin;
      }

      const packageConfigPath = join(
        FLUTTER_CLIENT_DIR,
        '.dart_tool/package_config.json',
      );
      if (!existsSync(packageConfigPath)) {
        const pubGet = Bun.spawn([flutterBinary, 'pub', 'get'], {
          cwd: FLUTTER_CLIENT_DIR,
          env: childEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [pubExit, pubOut, pubErr] = await Promise.all([
          pubGet.exited,
          new Response(pubGet.stdout).text(),
          new Response(pubGet.stderr).text(),
        ]);
        expect(pubExit, `${pubOut}\n${pubErr}`).toBe(0);
      }

      const host = await startLoopbackCrashlyticsHost();
      try {
        childEnv.PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL = host.wsUrl;
        childEnv.PYRIC_LIVE_PROJECT_ID = PROJECT_ID;
        childEnv.PYRIC_REQUIRE_CRASHLYTICS_LIVE = '1';

        const child = Bun.spawn(
          [
            flutterBinary,
            'test',
            '--no-pub',
            '--machine',
            'test/crashlytics/crashlytics_live_host_test.dart',
          ],
          {
            cwd: FLUTTER_CLIENT_DIR,
            env: childEnv,
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const killTimer = setTimeout(() => child.kill(), 120_000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          const combinedOutput = `${stdout}\n${stderr}`;
          expect(exitCode, combinedOutput).toBe(0);
          expect(combinedOutput).toContain('PYRIC_FLUTTER_CRASHLYTICS_LIVE_VERIFIED=1');

          const summary = summarizeFlutterMachineOutput(stdout);
          expect(summary.failed, combinedOutput).toBe(0);
          expect(summary.skipped, combinedOutput).toBe(0);
          expect(summary.passed, combinedOutput).toBeGreaterThanOrEqual(1);
        } finally {
          clearTimeout(killTimer);
          child.kill();
        }

        for (const expectedMethod of ALL_CRASHLYTICS_METHODS) {
          expect(host.observedOps).toContain(expectedMethod);
          expect(host.attachedAppCheckMethods.has(expectedMethod)).toBe(true);
        }
      } finally {
        await host.close();
      }
    },
    120_000,
  );
});
