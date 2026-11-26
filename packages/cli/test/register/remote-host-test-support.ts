import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createMemoryBackend, type PersistenceBackend } from 'pyric/sandbox';
import {
  WORKER_PORT_CAPABILITY,
  WORKER_RELAY_CAPABILITY,
} from '../../src/bridge/protocol.js';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import type { HostedPersistence } from '../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';

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

export interface InMemoryRemoteHostOptions {
  projectKey: string;
  projectId?: string;
  backend?: PersistenceBackend;
  writePointerInDir?: string;
}

export interface InMemoryRemoteHost {
  origin: string;
  instanceId: string;
  stop(): Promise<void>;
}

export async function startInMemoryRemoteHost(
  options: InMemoryRemoteHostOptions,
): Promise<InMemoryRemoteHost> {
  const projectId = options.projectId ?? 'demo-reg-remote';
  const backend = options.backend ?? createMemoryBackend();
  const bridge = createBridge({
    mode: 'sandbox',
    project: projectId,
    projectKey: options.projectKey,
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
        defaultInstance: `${projectId}-default-rtdb`,
        projectId,
        rules: {},
      },
      storageRules: null,
      storageRulesHash: null,
      bridgeUrl: null,
      seed: null,
      capture: false,
      hosted: true,
      projectKey: options.projectKey,
      permissive: true,
    },
    () => baseOrigin,
    (message) => {
      bridge.handleSandboxMessage(message);
    },
    options.projectKey,
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
          projectKey: options.projectKey,
          mode: 'sandbox',
        }),
      );
      return;
    }
    if (req.url === '/__pyric/init.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          hosted: true,
          projectKey: options.projectKey,
          bridgeUrl: `${baseOrigin.replace(/^http/, 'ws')}/__pyric/sandbox`,
          instanceId: runtime.instanceId,
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
  if (options.writePointerInDir !== undefined) {
    mkdirSync(join(options.writePointerInDir, '.pyric'), { recursive: true });
    writeFileSync(
      join(options.writePointerInDir, '.pyric/serve.json'),
      JSON.stringify({ port, url: baseOrigin, instanceId: runtime.instanceId }),
    );
  }

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
