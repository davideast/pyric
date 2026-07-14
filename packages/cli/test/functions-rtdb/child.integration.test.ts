import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import {
  spawnFunctionsRtdbChild,
  type FunctionsRtdbChildEvent,
  type FunctionsRtdbChildHandle,
} from '../../src/functions-rtdb/child.js';
import {
  buildChildEnv,
  registerModuleUrl,
} from '../../src/cli/dev-runner.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import {
  isBridgeMessage,
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import { silentServeLogger } from '../../src/serve/server.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../src/serve/worker/protocol.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const childModule = join(cliRoot, 'dist/functions-rtdb/child.js');

let fixtureDir: string;
let runtime: ServeRuntime;
let peer: { close(): Promise<void> };
let observer: RemoteSandbox;
let child: FunctionsRtdbChildHandle | undefined;

async function makeWorkerCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  await sandbox.enablePersistence({
    key: `functions-child-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'functions-child-test',
    subs: new Map(),
  };
}

async function connectWorkerPeer(
  url: string,
  ctx: HostCtx,
): Promise<{ close(): Promise<void> }> {
  const ws = new WebSocket(url);
  const port: PortLike = {
    postMessage(raw: unknown) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const message = raw as OutboundMessage;
      if (message.t === 'res') {
        const response: BridgeMessage = message.ok
          ? { type: 'worker-res', id: message.id, ok: true, value: message.value }
          : { type: 'worker-res', id: message.id, ok: false, error: message.error };
        ws.send(JSON.stringify(response));
      } else if (message.t === 'snap') {
        ws.send(JSON.stringify({
          type: 'worker-snap',
          subId: message.subId,
          value: message.value,
        } satisfies BridgeMessage));
      }
    },
  };

  await new Promise<void>((resolveConnected, rejectConnected) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        protocol: 1,
        tools: [],
        sandboxId: 'functions-child-peer',
        capabilities: [WORKER_RELAY_CAPABILITY],
      } satisfies BridgeMessage));
    });
    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isBridgeMessage(message)) return;
      if (message.type === 'hello-ack') {
        resolveConnected();
      } else if (message.type === 'worker-op') {
        void handleMessage(ctx, port, {
          ...message.op,
          t: 'op',
          id: message.id,
        } as InboundMessage);
      } else if (message.type === 'worker-sub') {
        void handleMessage(ctx, port, {
          ...message.sub,
          t: 'sub',
          subId: message.subId,
        } as InboundMessage);
      } else if (message.type === 'worker-unsub') {
        void handleMessage(ctx, port, {
          t: 'unsub',
          subId: message.subId,
        } satisfies InboundMessage);
      }
    });
    ws.once('error', rejectConnected);
    ws.once('close', () => rejectConnected(new Error('worker peer closed before ready')));
  });

  return {
    close: () => new Promise<void>((resolveClosed) => {
      if (ws.readyState === WebSocket.CLOSED) return resolveClosed();
      ws.once('close', () => resolveClosed());
      ws.close();
    }),
  };
}

async function waitForValue(path: string, expected: unknown): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await observer.rtdb.get(path)) === expected) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
  }
  throw new Error(`timed out waiting for ${path}=${JSON.stringify(expected)}`);
}

beforeAll(async () => {
  if (!existsSync(childModule)) {
    throw new Error(`Functions child is not built — run bun run --cwd packages/cli build (${childModule})`);
  }
  fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-functions-child-'));
  mkdirSync(join(fixtureDir, 'public'));
  mkdirSync(join(fixtureDir, 'functions/node_modules'), { recursive: true });
  writeFileSync(join(fixtureDir, 'public/index.html'), '<!doctype html><body>fixture</body>');
  writeFileSync(
    join(fixtureDir, 'firebase.json'),
    JSON.stringify({ hosting: { public: 'public' } }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/package.json'),
    JSON.stringify({ name: 'unchanged-functions', private: true, type: 'commonjs' }),
  );
  writeFileSync(
    join(fixtureDir, 'functions/index.cjs'),
    `const { onValueCreated, onValueUpdated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('uppercase').set(event.data.val().toUpperCase()),
);
exports.markProcessed = onValueCreated(
  '/messages/{pushId}/uppercase',
  event => event.data.ref.parent.child('processed').set(
    event.params.pushId + ':' + event.data.val()
  ),
);
exports.unsupportedUpdate = onValueUpdated(
  '/messages/{pushId}/original',
  () => undefined,
);
`,
  );
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(fixtureDir, 'functions/node_modules/firebase-functions'),
  );

  runtime = await startServe({
    cwd: fixtureDir,
    port: 0,
    cacheRoot: join(fixtureDir, '.cache'),
    logger: silentServeLogger(),
    bridge: true,
    disableAuditLog: true,
  });
  peer = await connectWorkerPeer(
    `ws://127.0.0.1:${runtime.handle.port}/__pyric/sandbox`,
    await makeWorkerCtx(),
  );
  observer = await connectRemoteSandbox({ url: runtime.handle.url });
});

afterAll(async () => {
  if (child) await child.stop();
  observer?.close();
  if (peer) await peer.close();
  if (runtime) await runtime.handle.stop();
});

describe('isolated Functions RTDB child', () => {
  test('loads unchanged CommonJS source and writes back into the same remote sandbox', async () => {
    const events: FunctionsRtdbChildEvent[] = [];
    child = spawnFunctionsRtdbChild({
      cwd: join(fixtureDir, 'functions'),
      entry: join(fixtureDir, 'functions/index.cjs'),
      childModuleUrl: pathToFileURL(childModule),
      env: buildChildEnv(process.env, {
        serveUrl: runtime.handle.url,
        registerUrl: registerModuleUrl(),
      }),
      projectId: 'demo-project',
      instance: 'demo-project-default-rtdb',
      location: 'us-central1',
      onEvent: (event) => events.push(event),
    });

    expect(await child.ready).toEqual({
      triggerCount: 2,
      unsupportedTriggers: [{
        exportName: 'unsupportedUpdate',
        eventType: 'google.firebase.database.ref.v1.updated',
      }],
    });
    await observer.rtdb.set('messages/id/original', 'hello');
    await waitForValue('messages/id/uppercase', 'HELLO');
    await waitForValue('messages/id/processed', 'id:HELLO');

    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'makeUppercase',
      ref: 'messages/id/original',
      params: { pushId: 'id' },
      status: 'fulfilled',
    });
    expect(events).toContainEqual({
      type: 'execution',
      exportName: 'markProcessed',
      ref: 'messages/id/uppercase',
      params: { pushId: 'id' },
      status: 'fulfilled',
    });
    expect(await child.stop()).toBe(0);
  }, 15_000);
});
