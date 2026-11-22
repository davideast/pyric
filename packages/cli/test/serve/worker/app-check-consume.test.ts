import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createMemoryBackend,
  initializeSandbox,
  type PersistenceBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import {
  deleteApp as deleteAdminApp,
  getApps as getAdminApps,
  initializeApp as initializeAdminApp,
} from 'pyric-admin/app';
import { getAppCheck } from 'pyric-admin/app-check';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
} from '../../../src/bridge/protocol.js';
import { createBridge } from '../../../src/bridge/server/bridge.js';
import { attachPeer } from '../../../src/bridge/server/peer.js';
import { connectRemoteSandbox } from '../../../src/remote/index.js';
import type { HostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { allowWorkerServicesForTransportTests } from './permissive-services.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../../..');
const PROJECT_ID = 'demo-appcheck-consume';
const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';

function makeHostedPersistenceOverBackend(backend: PersistenceBackend): HostedPersistence {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: async () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend,
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

async function bootHostedServer(backend: PersistenceBackend) {
  const bridge = createBridge({
    mode: 'sandbox',
    project: PROJECT_ID,
    projectKey: REPO_ROOT,
    version: '0.0.0-test',
  });
  const sockets = new Set<Socket>();
  const wss = new WebSocketServer({ noServer: true });
  let baseOrigin = 'http://127.0.0.1:0';

  const runtime = await createHostedRuntime(
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
      persistence: makeHostedPersistenceOverBackend(backend),
      record: false,
    },
  );

  const unregisterPeer = bridge.registerSandboxPeer(
    (inbound) => {
      runtime.receive(inbound);
    },
    [...runtime.toolNames],
    runtime.instanceId,
    [WORKER_RELAY_CAPABILITY, WORKER_PORT_CAPABILITY],
  );

  const server = createServer((req, res) => {
    if (req.url === '/__pyric/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          instanceId: runtime.instanceId,
          projectKey: REPO_ROOT,
          mode: 'sandbox',
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/__pyric/sandbox') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      attachPeer(bridge, ws, false);
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  baseOrigin = `http://127.0.0.1:${port}`;

  return {
    origin: baseOrigin,
    instanceId: runtime.instanceId,
    async stop() {
      unregisterPeer();
      await runtime.close();
      await new Promise<void>((resolveWss) => wss.close(() => resolveWss()));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveHttp) => server.close(() => resolveHttp()));
    },
  };
}

async function makePersistentWorkerHostCtx(backend: PersistenceBackend): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  allowWorkerServicesForTransportTests(sandbox, 'worker-ac-consume-test');
  await sandbox.enablePersistence({
    key: 'worker-ac-consume',
    injectedBackend: backend,
  });
  return {
    db: getFirestore(sandbox),
    sandbox,
    subs: new Map(),
    sessionMode: 'LOCAL',
    sessionBackend: createMemoryBackend(),
  };
}

afterEach(async () => {
  await Promise.all(getAdminApps().map((app) => deleteAdminApp(app)));
});

describe('appCheck.consumeToken across SharedWorker and HostedRuntime (#1297)', () => {
  it('shares consumed tokens across SharedWorker client sessions, persists across worker restarts, and validates tokenId', async () => {
    const sharedBackend = createMemoryBackend();
    const ctx1 = await makePersistentWorkerHostCtx(sharedBackend);

    const sendOp = async (
      ctx: HostCtx,
      msg: Record<string, unknown>,
    ): Promise<OutboundMessage> => {
      let captured: OutboundMessage | undefined;
      const port: PortLike = {
        postMessage(reply: OutboundMessage) {
          captured = reply;
        },
      };
      await handleMessage(ctx, port, msg as unknown as InboundMessage);
      if (captured === undefined) {
        throw new Error('worker produced no reply');
      }
      return captured;
    };

    try {
      const firstReply = await sendOp(ctx1, {
        t: 'op',
        id: 'c-1',
        clientSessionId: 'node-proc-a',
        method: 'appCheck.consumeToken',
        tokenId: 'jti-shared-worker-1',
      });
      expect(firstReply).toEqual({
        t: 'res',
        id: 'c-1',
        clientSessionId: 'node-proc-a',
        ok: true,
        value: { alreadyConsumed: false },
      });

      const secondReply = await sendOp(ctx1, {
        t: 'op',
        id: 'c-2',
        clientSessionId: 'node-proc-b',
        method: 'appCheck.consumeToken',
        tokenId: 'jti-shared-worker-1',
      });
      expect(secondReply).toEqual({
        t: 'res',
        id: 'c-2',
        clientSessionId: 'node-proc-b',
        ok: true,
        value: { alreadyConsumed: true },
      });

      // Invalid tokenId shapes are rejected at inbound validation.
      const emptyTokenReply = await sendOp(ctx1, {
        t: 'op',
        id: 'c-empty',
        method: 'appCheck.consumeToken',
        tokenId: '',
      });
      expect(emptyTokenReply.t).toBe('res');
      expect((emptyTokenReply as { ok: boolean }).ok).toBe(false);

      const nonStringReply = await sendOp(ctx1, {
        t: 'op',
        id: 'c-num',
        method: 'appCheck.consumeToken',
        tokenId: 123,
      });
      expect((nonStringReply as { ok: boolean }).ok).toBe(false);

      await ctx1.sandbox.flush();
    } finally {
      ctx1.sandbox.dispose();
    }

    // Boot a brand-new SharedWorker HostCtx against the same persisted backend.
    const ctx2 = await makePersistentWorkerHostCtx(sharedBackend);
    try {
      const postRestartReply = await sendOp(ctx2, {
        t: 'op',
        id: 'c-after-restart',
        clientSessionId: 'node-proc-c',
        method: 'appCheck.consumeToken',
        tokenId: 'jti-shared-worker-1',
      });
      expect(postRestartReply).toEqual({
        t: 'res',
        id: 'c-after-restart',
        clientSessionId: 'node-proc-c',
        ok: true,
        value: { alreadyConsumed: true },
      });
    } finally {
      ctx2.sandbox.dispose();
    }
  });

  it('shares consumed tokens across two remote pyric-admin clients on one HostedRuntime and survives host restart', async () => {
    const durableBackend = createMemoryBackend();
    const host1 = await bootHostedServer(durableBackend);
    let token = '';

    try {
      const remoteA = await connectRemoteSandbox({ url: host1.origin });
      const remoteB = await connectRemoteSandbox({ url: host1.origin });
      try {
        const adminA = initializeAdminApp(
          { sandbox: remoteA, projectId: PROJECT_ID },
          'hosted-admin-a',
        );
        const adminB = initializeAdminApp(
          { sandbox: remoteB, projectId: PROJECT_ID },
          'hosted-admin-b',
        );

        const minted = await getAppCheck(adminA).createToken(APP_ID);
        token = minted.token;

        const v1 = await getAppCheck(adminA).verifyToken(token, { consume: true });
        expect(v1.alreadyConsumed).toBe(false);

        const v2 = await getAppCheck(adminB).verifyToken(token, { consume: true });
        expect(v2.alreadyConsumed).toBe(true);

        const plain = await getAppCheck(adminB).verifyToken(token);
        expect('alreadyConsumed' in plain).toBe(false);
      } finally {
        remoteA.close();
        remoteB.close();
      }
    } finally {
      await host1.stop();
    }

    // Restart HostedRuntime over the same durable backend and verify token stays consumed.
    const host2 = await bootHostedServer(durableBackend);
    try {
      const remoteC = await connectRemoteSandbox({ url: host2.origin });
      try {
        const adminC = initializeAdminApp(
          { sandbox: remoteC, projectId: PROJECT_ID },
          'hosted-admin-c',
        );
        const afterRestart = await getAppCheck(adminC).verifyToken(token, { consume: true });
        expect(afterRestart.alreadyConsumed).toBe(true);
      } finally {
        remoteC.close();
      }
    } finally {
      await host2.stop();
    }
  });
});
