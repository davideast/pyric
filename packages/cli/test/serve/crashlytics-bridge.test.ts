import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { FirebaseApp } from 'pyric/app';
import { breadcrumbs, flush, log, recordError } from 'pyric/crashlytics';
import { createTransportCrashlytics } from 'pyric/crashlytics/internal';
import { createMemoryBackend } from 'pyric/sandbox';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
  type WorkerResFrame,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { getClientAliases } from '../../src/next/client-aliases.js';
import { mapFirebaseSpecifier } from '../../src/register/mapping.js';
import { defaultSdkEntries } from '../../src/serve/bundler.js';
import { swappedFirebaseEntries } from '../../src/serve/firebase-module-swap.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import { sdkImportMap } from '../../src/serve/html-injection.js';
import { wirePort } from '../../src/serve/worker/client/core.js';
import { createWorkerCrashlyticsTransport } from '../../src/serve/worker/client/crashlytics.js';
import type { ClientDb, ClientPort } from '../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../src/serve/worker/protocol.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const PROJECT_ID = 'demo-crashlytics-bridge';

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

async function startLiveCrashlyticsHost(options: { refuseOwnWrites?: boolean } = {}) {
  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const runtimeOptions: Parameters<typeof createHostedRuntime>[4] = {
    persistence: makeInMemoryHostedPersistence(),
    record: false,
  };
  if (options.refuseOwnWrites === true) {
    runtimeOptions.ownWriteRefusal = (write) =>
      Object.assign(new Error(`Refused live write: ${write.action}`), {
        code: 'PYRIC_LIVE_REFUSED',
      });
  }

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
    runtimeOptions,
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      hostedRuntime.receive(inbound);
    },
    [...hostedRuntime.toolNames],
    hostedRuntime.instanceId,
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
  const wsUrl = `ws://127.0.0.1:${port}/__pyric/sandbox`;

  return {
    wsUrl,
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

async function openAttachedSocket(wsUrl: string, sessionId: string) {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', () => resolveOpen());
    socket.once('error', rejectOpen);
  });
  const replies = new Map<string, (frame: WorkerResFrame) => void>();
  let resolveAck = (): void => {};
  const ackPromise = new Promise<void>((resolvePromise) => {
    resolveAck = resolvePromise;
  });

  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(msg: InboundMessage) {
      if (msg.t === 'op') {
        const { t: _t, id, ...rest } = msg;
        socket.send(
          JSON.stringify({
            type: 'worker-op',
            id,
            op: rest,
          } as BridgeMessage),
        );
      }
    },
    start() {},
    close() {},
  };

  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as BridgeMessage;
    if (frame.type === 'attach-ack') {
      resolveAck();
      return;
    }
    if (frame.type === 'worker-res') {
      const waiter = replies.get(frame.id);
      if (waiter !== undefined) {
        replies.delete(frame.id);
        waiter(frame);
      }
      let resMsg: OutboundMessage;
      if (frame.ok) {
        resMsg = { t: 'res', id: frame.id, ok: true, value: frame.value };
      } else {
        resMsg = {
          t: 'res',
          id: frame.id,
          ok: false,
          error: {
            code: frame.error?.code ?? 'internal',
            message: frame.error?.message ?? 'error',
          },
        };
      }
      clientPort.onmessage?.({ data: resMsg } as MessageEvent<OutboundMessage>);
    }
  });

  socket.send(
    JSON.stringify({
      type: 'attach',
      protocol: 1,
      clientSessionId: sessionId,
      clientInfo: { platform: 'web' },
    } satisfies BridgeMessage),
  );
  await ackPromise;
  wirePort(clientPort);

  let seq = 0;
  const sendOp = (op: Record<string, unknown>): Promise<WorkerResFrame> => {
    seq += 1;
    const id = `${sessionId}-op-${seq}`;
    return new Promise<WorkerResFrame>((resolveReply) => {
      replies.set(id, resolveReply);
      socket.send(JSON.stringify({ type: 'worker-op', id, op } as BridgeMessage));
    });
  };

  return {
    sendOp,
    clientDb: { __kind: 'client-db' as const, port: clientPort } as ClientDb,
    close() {
      socket.terminate();
    },
  };
}

describe('Crashlytics module swap and live HostedRuntime WebSocket bridge', () => {
  test('maps firebase/crashlytics and all four framework subpaths across register, Next.js aliases, import map, and SDK bundler entries', () => {
    const cases: ReadonlyArray<readonly [specifier: string, pyricSubpath: string, entryKey: string]> = [
      ['firebase/crashlytics', 'pyric/crashlytics', 'crashlytics'],
      ['firebase/crashlytics/angular', 'pyric/crashlytics/angular', 'crashlytics-angular'],
      ['firebase/crashlytics/next-navigation', 'pyric/crashlytics/next-navigation', 'crashlytics-next-navigation'],
      ['firebase/crashlytics/react', 'pyric/crashlytics/react', 'crashlytics-react'],
      ['firebase/crashlytics/react-router', 'pyric/crashlytics/react-router', 'crashlytics-react-router'],
    ];
    const entries = defaultSdkEntries();
    for (const [specifier, pyricSubpath, entryKey] of cases) {
      expect(mapFirebaseSpecifier(specifier)).toBe(pyricSubpath);
      expect(swappedFirebaseEntries('sandbox').get(specifier as never)).toBe(entryKey);
      expect(swappedFirebaseEntries('production').get(specifier as never)).toBe(entryKey);
      expect(sdkImportMap('sandbox')[specifier]).toBe(`/__pyric/sdk/${entryKey}.js`);
      expect(getClientAliases('sandbox')[specifier]).toBe(
        `@pyric/cli/next/internal/${entryKey}`,
      );
      expect(entries[entryKey]).toBeDefined();
    }
  });

  test('streams Web getCrashlytics -> log -> recordError -> flush and native 10-op wire lifecycle over HostedRuntime', async () => {
    const host = await startLiveCrashlyticsHost();
    let webPeer: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;
    let nativePeer: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;

    try {
      webPeer = await openAttachedSocket(host.wsUrl, 'crashlytics-web-peer');
      nativePeer = await openAttachedSocket(host.wsUrl, 'crashlytics-android-peer');
      const appId = '1:555:web:crashlyticsbridge';
      const fakeApp: FirebaseApp = {
        name: '[DEFAULT]',
        options: { projectId: PROJECT_ID, appId },
        automaticDataCollectionEnabled: true,
      };
      const transport = createWorkerCrashlyticsTransport(webPeer.clientDb, appId);
      const crashlytics = createTransportCrashlytics(fakeApp, transport, {
        appVersion: '3.1.0',
        region: 'europe-west1',
        customAttributes: { surface: 'web-checkout' },
        features: [breadcrumbs()],
      });

      log(crashlytics, 'opened-cart', { items: 2 });
      recordError(crashlytics, new RangeError('quantity-out-of-bounds'), {
        sku: 'sku-99',
      });
      await flush(crashlytics);

      const webStateRes = await webPeer.sendOp({
        method: 'crashlytics.getState',
        appId,
      });
      expect(webStateRes.ok).toBe(true);
      const webState = webStateRes.value as {
        appVersion: string | null;
        region: string | null;
        logs: Array<{ message: string }>;
        reports: Array<{
          name: string;
          message: string;
          flushed: boolean;
          sdkPlatform: string;
          attributes: Record<string, unknown>;
          breadcrumbs: Array<{ message: string }>;
        }>;
      };
      expect(webState.appVersion).toBe('3.1.0');
      expect(webState.region).toBe('europe-west1');
      expect(webState.logs.map((entry) => entry.message)).toEqual(['opened-cart']);
      expect(webState.reports).toHaveLength(1);
      expect(webState.reports[0]?.name).toBe('RangeError');
      expect(webState.reports[0]?.message).toBe('quantity-out-of-bounds');
      expect(webState.reports[0]?.flushed).toBe(true);
      expect(webState.reports[0]?.sdkPlatform).toBe('web');
      expect(webState.reports[0]?.attributes).toEqual({
        surface: 'web-checkout',
        sku: 'sku-99',
      });
      expect(webState.reports[0]?.breadcrumbs.map((b) => b.message)).toEqual(['opened-cart']);

      const androidAppId = '1:555:android:crashlyticsnative';
      expect(
        (await nativePeer.sendOp({
          method: 'crashlytics.setUserId',
          appId: androidAppId,
          userId: 'android-uid-01',
        })).ok,
      ).toBe(true);
      expect(
        (await nativePeer.sendOp({
          method: 'crashlytics.setCustomKeys',
          appId: androidAppId,
          keys: { level: 9, pro: true },
        })).ok,
      ).toBe(true);

      const disableRes = await nativePeer.sendOp({
        method: 'crashlytics.setCollectionEnabled',
        appId: androidAppId,
        enabled: false,
      });
      expect(disableRes.ok).toBe(true);
      expect(disableRes.value).toEqual({ enabled: false });

      const deferredRes = await nativePeer.sendOp({
        method: 'crashlytics.recordError',
        appId: androidAppId,
        name: 'java.io.IOException',
        message: 'socket-reset',
        sdkPlatform: 'android',
      });
      expect(deferredRes.ok).toBe(true);
      expect((deferredRes.value as { queued: boolean; flushed: boolean }).flushed).toBe(false);

      const checkUnsent = await nativePeer.sendOp({
        method: 'crashlytics.checkForUnsentReports',
        appId: androidAppId,
      });
      expect(checkUnsent.value).toEqual({ hasUnsentReports: true, count: 1 });

      const sentRes = await nativePeer.sendOp({
        method: 'crashlytics.sendUnsentReports',
        appId: androidAppId,
      });
      expect(sentRes.value).toEqual({ sentCount: 1 });

      await nativePeer.sendOp({
        method: 'crashlytics.recordError',
        appId: androidAppId,
        message: 'drop-me',
        deferred: true,
      });
      const delRes = await nativePeer.sendOp({
        method: 'crashlytics.deleteUnsentReports',
        appId: androidAppId,
      });
      expect(delRes.value).toEqual({ deletedCount: 1 });

      const badShape = await nativePeer.sendOp({
        method: 'crashlytics.setUserId',
        appId: androidAppId,
        userId: 12345,
      });
      expect(badShape.ok).toBe(false);
      expect(badShape.error?.code).toBe('invalid-argument');
    } finally {
      webPeer?.close();
      nativePeer?.close();
      await host.close();
    }
  });

  test('refuses mutating crashlytics ops on a live-mode host while allowing read-only state inspection', async () => {
    const liveHost = await startLiveCrashlyticsHost({ refuseOwnWrites: true });
    let peer: Awaited<ReturnType<typeof openAttachedSocket>> | undefined;
    try {
      peer = await openAttachedSocket(liveHost.wsUrl, 'crashlytics-live-refusal');
      const readRes = await peer.sendOp({
        method: 'crashlytics.checkForUnsentReports',
      });
      expect(readRes.ok).toBe(true);

      const writeRes = await peer.sendOp({
        method: 'crashlytics.recordError',
        message: 'blocked-in-live-mode',
      });
      expect(writeRes.ok).toBe(false);
      expect(writeRes.error?.code).toBe('PYRIC_LIVE_REFUSED');
    } finally {
      peer?.close();
      await liveHost.close();
    }
  });
});
