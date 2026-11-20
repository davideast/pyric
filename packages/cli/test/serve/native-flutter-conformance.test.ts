/**
 * Live-host conformance harness for the Flutter client SDK (`packages/flutter-client`).
 *
 * Boots an authoritative loopback Pyric bridge host on `127.0.0.1:0` with
 * Firestore Security Rules plus 11 Realtime Database instances under
 * independent rulesets, verifies the WebSocket wire contract directly, and runs
 * `flutter test --machine` across `test/live_host_conformance_test.dart` and
 * `test/live_host/*_test.dart` against the live loopback endpoint.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend } from 'pyric/sandbox';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { openStorageBackend } from '../../../pyric/src/storage/persistence.js';
import {
  DOC_VALUE_ENCODING_CAPABILITY,
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
const FLUTTER_CLIENT_DIR = join(REPO_ROOT, 'packages/flutter-client');
const PROJECT_ID = 'demo-flutter-live';
const DEFAULT_RTDB_INSTANCE = `${PROJECT_ID}-default-rtdb`;

const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      match /items/{itemId} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /links/{linkId} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
      match /rooms/{roomId}/entries/{entryId} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }
    match /{path=**}/entries/{entryId} {
      allow read: if request.auth != null && resource.data.ownerUid == request.auth.uid;
    }
    match /verified_users/{uid} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.email != null
        && request.auth.token.email_verified == true;
    }
    match /provider_profiles/{provider}/users/{uid} {
      allow read, write: if request.auth != null
        && request.auth.uid == uid
        && request.auth.token.firebase.sign_in_provider == provider;
    }
    match /role_items/{role}/items/{itemId} {
      allow read, write: if request.auth != null && request.auth.token.role == role;
    }
    match /tenant_rooms/{tenantId}/rooms/{roomId} {
      allow read, write: if request.auth != null
        && request.auth.token.firebase.tenant == tenantId;
    }
  }
}`;

const NAMED_SHARDS: readonly string[] = [
  'shard-00', 'shard-01', 'shard-02', 'shard-03', 'shard-04',
  'shard-05', 'shard-06', 'shard-07', 'shard-08', 'shard-09',
];

const MAIN_RULES = {
  rules: {
    users: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
        '.write': 'auth != null && auth.uid === $uid',
        catalog: { '.indexOn': ['score', 'role', 'meta/rank', '.value'] },
        scores: { '.indexOn': ['.value'] },
      },
    },
    provider_claims: {
      $provider: {
        $uid: {
          '.read': 'auth != null && auth.uid === $uid && auth.token.firebase.sign_in_provider === $provider',
          '.write': 'auth != null && auth.uid === $uid && auth.token.firebase.sign_in_provider === $provider',
        },
      },
    },
    email_claims: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid && auth.token.email != null && auth.token.email_verified === false',
        '.write': 'auth != null && auth.uid === $uid && auth.token.email != null && auth.token.email_verified === false',
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
    catalog: { $itemId: { '.read': true, '.write': false } },
    ops: {
      $opId: {
        '.read': 'auth != null && auth.token.role === "ops"',
        '.write': 'auth != null && auth.token.role === "ops"',
      },
    },
  },
};

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
      rulesByInstance[shard] = {
        rules: { shards: { [shard]: { '.read': 'auth != null', '.write': 'auth != null' } } },
      };
    }
  }
  return rulesByInstance;
}

function discoverLiveHostTestFiles(): string[] {
  const files = ['test/live_host_conformance_test.dart'];
  const liveHostDir = join(FLUTTER_CLIENT_DIR, 'test/live_host');
  if (existsSync(liveHostDir)) {
    const extra = readdirSync(liveHostDir).filter((name) => name.endsWith('_test.dart')).sort();
    for (const fileName of extra) files.push(`test/live_host/${fileName}`);
  }
  return files;
}

function detectFlutterBinary(): string | null {
  const fromPath = Bun.which('flutter');
  if (fromPath !== null) return fromPath;
  const home = homedir();
  const localBinCandidate = join(home, '.local/bin/flutter');
  if (existsSync(localBinCandidate)) return localBinCandidate;
  const localFlutterCandidate = join(home, '.local/flutter/bin/flutter');
  if (existsSync(localFlutterCandidate)) return localFlutterCandidate;
  return null;
}

function requiresLiveFlutter(env: NodeJS.ProcessEnv): boolean {
  return env.PYRIC_REQUIRE_FLUTTER_LIVE === '1';
}

function isGenericCiShard(env: NodeJS.ProcessEnv): boolean {
  return env.CI === 'true' && !requiresLiveFlutter(env);
}

function shouldSkipLiveFlutterRun(flutterBinary: string | null, env: NodeJS.ProcessEnv): boolean {
  if (requiresLiveFlutter(env)) return false;
  if (isGenericCiShard(env)) return true;
  return flutterBinary === null;
}

const DETECTED_FLUTTER_BINARY = detectFlutterBinary();
const SKIPS_FLUTTER_SUBPROCESS = shouldSkipLiveFlutterRun(DETECTED_FLUTTER_BINARY, process.env);

interface LoopbackFlutterBridgeHost {
  readonly port: number;
  readonly wsUrl: string;
  close(): Promise<void>;
}

async function closeWebSocketServer(wss: WebSocketServer, sockets: Set<WebSocket>): Promise<void> {
  for (const socket of sockets) socket.terminate();
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

async function startLoopbackFlutterBridgeHost(): Promise<LoopbackFlutterBridgeHost> {
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({
    port: 0, host: '127.0.0.1', path: '/__pyric/sandbox', maxPayload: MAX_BRIDGE_FRAME_BYTES,
  });
  await once(wss, 'listening');
  const address = wss.address();
  const hasBoundPort = address !== null && typeof address === 'object';
  if (!hasBoundPort) {
    await closeWebSocketServer(wss, sockets);
    throw new Error('Expected bound IPv4 AddressInfo for loopback Flutter WebSocketServer.');
  }
  const port = (address as AddressInfo).port;
  const wsUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const bridge = createBridge({
    mode: 'sandbox', project: PROJECT_ID, projectKey: REPO_ROOT, version: '0.0.0-test',
  });

  let runtime: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  let disconnectHosted: (() => void) | undefined;
  try {
    const persistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend(`mem-flutter-live-${randomUUID()}`),
      checkpoints: {},
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    };
    const payload: InitPayload = {
      rules: FIRESTORE_RULES,
      rulesHash: null,
      databaseRules: MAIN_RULES,
      databaseRulesHash: null,
      databaseInstances: {
        defaultInstance: DEFAULT_RTDB_INSTANCE,
        projectId: PROJECT_ID,
        rules: buildMultiShardDatabaseRules(),
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: wsUrl,
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: REPO_ROOT,
      appOptions: { projectId: PROJECT_ID },
    };
    runtime = await createHostedRuntime(
      payload, baseUrl, (message) => bridge.handleSandboxMessage(message), REPO_ROOT,
      { persistence: persistence as never, record: false },
    );
    const activeRuntime = runtime;
    disconnectHosted = bridge.registerSandboxPeer(
      (message) => activeRuntime.receive(message),
      [...activeRuntime.toolNames],
      activeRuntime.instanceId,
      [
        WORKER_PORT_CAPABILITY,
        WORKER_RELAY_CAPABILITY,
        STORAGE_BYTE_ROUTE_CAPABILITY,
        DOC_VALUE_ENCODING_CAPABILITY,
      ],
    );
    await activeRuntime.deployRules('firestore', FIRESTORE_RULES);
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
      type: 'attach', protocol: 1, clientInfo: { platform: 'flutter' },
      capabilities: [DOC_VALUE_ENCODING_CAPABILITY],
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
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type === 'testStart' && typeof parsed.test === 'object' && parsed.test !== null) {
      const testObj = parsed.test as { id?: unknown; name?: unknown };
      if (typeof testObj.id === 'number' && typeof testObj.name === 'string') {
        namesById.set(testObj.id, testObj.name);
      }
      continue;
    }
    if (parsed.type !== 'testDone' || parsed.hidden === true) continue;
    let testName = '';
    if (typeof parsed.testID === 'number') {
      const recorded = namesById.get(parsed.testID);
      if (recorded !== undefined) testName = recorded;
    }
    if (testName.startsWith('loading ')) continue;
    if (parsed.skipped === true) skipped += 1;
    else if (parsed.result === 'success') passed += 1;
    else failed += 1;
  }
  return { passed, failed, skipped };
}

describe('Flutter native SDK live-host conformance', () => {
  test('loopback bridge host enforces Auth, 11-shard RTDB isolation, and Firestore Security Rules over WebSocket', async () => {
    const host = await startLoopbackFlutterBridgeHost();
    let client: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;
    try {
      client = await openAttachedSocket(host.wsUrl);
      const anonLens = { mode: 'anon' };
      const deniedRtdbAnon = await client.sendOp({
        method: 'rtdb.set', path: '/users/unauthed', value: { displayName: 'Blocked' }, actAs: anonLens,
      });
      expect(deniedRtdbAnon.ok).toBe(false);
      expect(deniedRtdbAnon.error?.code).toBe('PERMISSION_DENIED');

      const deniedFirestoreAnon = await client.sendOp({
        method: 'setDoc', path: 'users/unauthed', data: { displayName: 'Blocked' }, actAs: anonLens,
      });
      expect(deniedFirestoreAnon.ok).toBe(false);
      expect(deniedFirestoreAnon.error?.code).toBe('permission-denied');

      const created = await client.sendOp({
        method: 'auth.createUser', email: 'wire-probe@example.test', password: 'correct-horse-battery',
      });
      expect(created.ok).toBe(true);
      const createdPayload = created.value as { user?: { uid?: string } } | undefined;
      let uid = '';
      if (typeof createdPayload?.user?.uid === 'string') uid = createdPayload.user.uid;
      expect(uid.length).toBeGreaterThan(0);

      const userLens = { mode: 'as', uid };
      const writeMainRtdb = await client.sendOp({
        method: 'rtdb.set', path: `/users/${uid}`, value: { displayName: 'Flutter Wire Probe' }, actAs: userLens,
      });
      expect(writeMainRtdb.ok).toBe(true);

      const writeShard00 = await client.sendOp({
        method: 'rtdb.set', instance: 'shard-00', path: '/rooms/r1', value: { owner: uid, topic: 'navigation' }, actAs: userLens,
      });
      expect(writeShard00.ok).toBe(true);

      const deniedShard01 = await client.sendOp({
        method: 'rtdb.get', instance: 'shard-01', path: '/rooms/r1', actAs: userLens,
      });
      expect(deniedShard01.ok).toBe(false);
      expect(deniedShard01.error?.code).toBe('PERMISSION_DENIED');

      const writeFirestoreOwner = await client.sendOp({
        method: 'setDoc', path: `users/${uid}`, data: { displayName: 'Flutter Wire Probe', visits: 1 }, actAs: userLens,
      });
      expect(writeFirestoreOwner.ok).toBe(true);

      const deniedFirestoreOther = await client.sendOp({
        method: 'setDoc', path: 'users/other-uid', data: { displayName: 'Intruder' }, actAs: userLens,
      });
      expect(deniedFirestoreOther.ok).toBe(false);
      expect(deniedFirestoreOther.error?.code).toBe('permission-denied');
    } finally {
      await client?.close();
      await host.close();
    }
  });

  test.skipIf(SKIPS_FLUTTER_SUBPROCESS)(
    'live-host Dart conformance suites pass over dart:io WebSocket against the live loopback Pyric bridge host',
    async () => {
      const flutterBinary = detectFlutterBinary();
      if (flutterBinary === null) {
        throw new Error('PYRIC_REQUIRE_FLUTTER_LIVE=1 is set, but `flutter` was not found.');
      }

      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnv[key] = value;
      }
      const localBin = join(homedir(), '.local/bin');
      let existingPath = '';
      if (typeof childEnv.PATH === 'string') existingPath = childEnv.PATH;
      if (existingPath.length > 0 && !existingPath.includes(localBin)) {
        childEnv.PATH = `${localBin}:${existingPath}`;
      } else if (existingPath.length === 0) {
        childEnv.PATH = localBin;
      }

      const packageConfigPath = join(FLUTTER_CLIENT_DIR, '.dart_tool/package_config.json');
      if (!existsSync(packageConfigPath)) {
        const pubGet = Bun.spawn([flutterBinary, 'pub', 'get'], {
          cwd: FLUTTER_CLIENT_DIR, env: childEnv, stdout: 'pipe', stderr: 'pipe',
        });
        const [pubExit, pubOut, pubErr] = await Promise.all([
          pubGet.exited, new Response(pubGet.stdout).text(), new Response(pubGet.stderr).text(),
        ]);
        expect(pubExit, `${pubOut}\n${pubErr}`).toBe(0);
      }

      const suiteFiles = discoverLiveHostTestFiles();
      const nowMs = Date.now();
      const host = await startLoopbackFlutterBridgeHost();
      let verifier: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;
      try {
        childEnv.PYRIC_LIVE_BRIDGE_URL = host.wsUrl;
        childEnv.PYRIC_LIVE_PROJECT_ID = PROJECT_ID;
        childEnv.PYRIC_LIVE_CUSTOM_TOKEN_VALID = mintCustomToken({
          uid: 'flutter-custom-uid-01', claims: { role: 'ops', tier: 'enterprise' },
          projectId: PROJECT_ID, nowMs,
        });
        childEnv.PYRIC_LIVE_CUSTOM_TOKEN_MISMATCH = mintCustomToken({
          uid: 'flutter-custom-uid-mismatch', claims: { role: 'viewer' },
          projectId: 'other-flutter-project', nowMs,
        });

        const child = Bun.spawn(
          [flutterBinary, 'test', '--no-pub', '--machine', ...suiteFiles],
          { cwd: FLUTTER_CLIENT_DIR, env: childEnv, stdout: 'pipe', stderr: 'pipe' },
        );
        const killTimer = setTimeout(() => child.kill(), 180_000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
          ]);
          const combinedOutput = `${stdout}\n${stderr}`;
          expect(exitCode, combinedOutput).toBe(0);

          const summary = summarizeFlutterMachineOutput(stdout);
          expect(summary.failed, combinedOutput).toBe(0);
          expect(summary.skipped, combinedOutput).toBe(0);
          expect(summary.passed, combinedOutput).toBeGreaterThanOrEqual(suiteFiles.length + 2);
        } finally {
          clearTimeout(killTimer);
          child.kill();
        }

        verifier = await openAttachedSocket(host.wsUrl);
        const usersFrame = await verifier.sendOp({ method: 'auth.listUsers' });
        expect(usersFrame.ok).toBe(true);
        let usersList: Array<{ email?: string; uid?: string }> = [];
        if (Array.isArray(usersFrame.value)) {
          usersList = usersFrame.value as Array<{ email?: string; uid?: string }>;
        }
        const emails = usersList.map((entry) => entry.email);
        expect(emails).toContain('pilot@example.test');
        expect(emails).toContain('firestore-pilot@example.test');
      } finally {
        await verifier?.close();
        await host.close();
      }
    },
    180_000,
  );
});
