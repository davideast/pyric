/**
 * A live page's own host connection announces the reads the page answers
 * and answers the calls the host routes to it. The real web hosted client
 * runs against the real bridge consumer session over loopback `ws` sockets;
 * the page's reader is a stand-in on the page hub `@pyric/live` writes
 * (`Symbol.for('pyric.live.reads')`).
 */
import { afterEach, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';
import { createBridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { createSilentLogger } from '../../src/bridge/server/logger.js';
import { DEFAULT_SANDBOX_PATH, WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY } from '../../src/bridge/protocol.js';
import { getHostedFirestore, type HostedConnectionState } from '../../src/serve/worker/client/websocket-connection.js';
import { runHostedMethod, tabCallRoute } from '../../src/serve/hosted/live-reads.js';

interface ReadHub {
  reader?: {
    tools(): string[];
    call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }> | undefined;
  };
  listeners: Set<() => void>;
}

const HUB_KEY = Symbol.for('pyric.live.reads');
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete (globalThis as Record<symbol, unknown>)[HUB_KEY];
});

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A live host's bridge on a loopback socket, with the hosted runtime as its sandbox peer. */
async function liveHost() {
  const bridge = createBridge({ version: 'test', projectKey: 'orbit', logger: createSilentLogger(), tabRoute: tabCallRoute });
  bridge.registerSandboxPeer(() => {}, [], 'host', [WORKER_PORT_CAPABILITY, WORKER_RELAY_CAPABILITY]);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', path: DEFAULT_SANDBOX_PATH });
  server.on('connection', socket => attachPeer(bridge, socket));
  await new Promise(resolve => server.once('listening', resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  const port = typeof address === 'object' ? address.port : 0;
  return { bridge, url: `ws://127.0.0.1:${port}${DEFAULT_SANDBOX_PATH}` };
}

/** The page hub with a reader that answers `firestore_get_document` once the app opened Firestore. */
function pageReader() {
  const asked: Array<{ name: string; args: Record<string, unknown> }> = [];
  let opened = false;
  const hub: ReadHub = {
    listeners: new Set(),
    reader: {
      tools: () => (opened ? ['firestore_get_document'] : []),
      call(name, args) {
        asked.push({ name, args });
        return Promise.resolve({ ok: true, summary: `Got ${String(args.path)}`, data: { exists: true, data: { name: 'Lobby' } } });
      },
    },
  };
  (globalThis as Record<symbol, unknown>)[HUB_KEY] = hub;
  const open = () => {
    opened = true;
    for (const listener of hub.listeners) listener();
  };
  return { asked, open };
}

function method(key: string, args: Record<string, unknown>) {
  return { instanceId: 'i', projectDir: '/p', key, args, allowProduction: false };
}

const runLocal = async () => ({ ok: true, summary: 'answered from the sandbox' });

test('a tab that announces a read over its host connection gets the routed call and answers it', async () => {
  const host = await liveHost();
  const page = pageReader();
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({ url: host.url, projectKey: 'orbit', onConnection: state => states.push(state) });
  cleanups.push(() => db.port.close());
  await until(() => states.includes('attached'));

  const before = await runHostedMethod(host.bridge.tabTools, method('firestore_get_document', { path: 'rooms/a' }), runLocal);
  expect(before.data).toEqual({ code: 'PYRIC_LIVE_REFUSED' });

  // The announcement travels on the socket; until it lands, the read is refused without reaching the page.
  page.open();
  let answer = await runHostedMethod(host.bridge.tabTools, method('firestore_get_document', { path: 'rooms/a' }), runLocal);
  for (let tries = 0; answer.ok === false && tries < 50; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
    answer = await runHostedMethod(host.bridge.tabTools, method('firestore_get_document', { path: 'rooms/a' }), runLocal);
  }
  expect(answer).toEqual({ ok: true, summary: 'Got rooms/a', data: { exists: true, data: { name: 'Lobby' } } });
  expect(page.asked).toEqual([{ name: 'firestore_get_document', args: { path: 'rooms/a' } }]);

  const unannounced = await runHostedMethod(host.bridge.tabTools, method('auth_get_user', { uid: 'a' }), runLocal);
  expect(unannounced.data).toEqual({ code: 'PYRIC_LIVE_REFUSED' });
});

test('a closed page connection takes its reads with it', async () => {
  const host = await liveHost();
  const page = pageReader();
  page.open();
  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({ url: host.url, projectKey: 'orbit', onConnection: state => states.push(state) });
  await until(() => states.includes('attached'));
  await until(() => host.bridge.tabTools.call('firestore_get_document', { path: 'rooms/a' }) !== undefined);
  db.port.close();
  await until(() => host.bridge.tabTools.call('firestore_get_document', { path: 'rooms/a' }) === undefined);
});
