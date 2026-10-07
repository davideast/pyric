import { afterEach, expect, test } from 'bun:test';
import { getHostedFirestore, type HostedConnectionState } from '../../../src/serve/worker/client/websocket-connection.js';
import { rawRpc, nextId } from '../../../src/serve/worker/client/core.js';
import type { ClientDb } from '../../../src/serve/worker/client/handles.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

// The client runs against a real WebSocket server on a loopback port. The port is
// reserved, released, and bound again later to model a host that is unreachable
// at page load and reachable afterwards.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function reservePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('probe') });
  const port = probe.port as number;
  void probe.stop(true);
  return port;
}

function startHost(port: number, received: BridgeMessage[]) {
  const server = Bun.serve({
    port,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as BridgeMessage;
        received.push(message);
        if (message.type === 'attach') {
          socket.send(JSON.stringify({
            type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true,
            clientSessionId: 'client', projectKey: 'orbit', hostInstanceId: 'host-1',
            capabilities: ['worker-port'],
          } satisfies BridgeMessage));
        }
        if (message.type === 'worker-message' && message.message.t === 'op') {
          socket.send(JSON.stringify({
            type: 'worker-message-result',
            message: { t: 'res', id: message.message.id, ok: true, value: 'done' },
          } satisfies BridgeMessage));
        }
      },
    },
  });
  cleanups.push(() => { void server.stop(true); });
  return server;
}

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function open(port: number, options: { retryInitialConnection?: boolean }): { db: ClientDb; states: HostedConnectionState[]; errors: string[] } {
  const states: HostedConnectionState[] = [];
  const errors: string[] = [];
  const db = getHostedFirestore({
    url: `ws://127.0.0.1:${port}/__pyric/sandbox`,
    projectKey: 'orbit',
    onConnection: state => states.push(state),
    onError: error => errors.push(error.code),
    ...options,
  });
  cleanups.push(() => db.port.close());
  return { db, states, errors };
}

test('a first connection that fails is retried until the host is reachable', async () => {
  const port = reservePort();
  const received: BridgeMessage[] = [];
  const { db, states, errors } = open(port, { retryInitialConnection: true });
  await until(() => states.includes('interrupted'));
  expect(errors).toEqual([]);
  startHost(port, received);
  await until(() => states.includes('attached'));
  expect(received.some(message => message.type === 'attach')).toBe(true);
  expect(states).not.toContain('closed');
  const reply = await rawRpc(db.port, { t: 'op', id: nextId(), method: 'ping' } as unknown as InboundMessage);
  expect(reply).toBe('done');
});

test('operations issued before the first attach fail once and are not replayed, while subscriptions resume', async () => {
  const port = reservePort();
  const received: BridgeMessage[] = [];
  const { db, states } = open(port, { retryInitialConnection: true });
  const opId = nextId();
  const failed = rawRpc(db.port, { t: 'op', id: opId, method: 'ping' } as unknown as InboundMessage)
    .then(() => 'resolved', (error: { code?: string }) => error.code);
  db.port.postMessage({ t: 'sub', subId: 'sub-first', target: 'authState' } as unknown as InboundMessage);
  expect(await failed).toBe('unavailable');
  startHost(port, received);
  await until(() => states.includes('attached'));
  const workerMessages = received
    .filter(message => message.type === 'worker-message')
    .map(message => (message as { message: { t: string; id?: string; subId?: string } }).message);
  expect(workerMessages.some(message => message.id === opId)).toBe(false);
  expect(workerMessages.some(message => message.t === 'sub' && message.subId === 'sub-first')).toBe(true);
});

test('without retryInitialConnection the first failure closes the port', async () => {
  const port = reservePort();
  const { states, errors } = open(port, {});
  await until(() => states.includes('closed'));
  expect(errors).toEqual(['unavailable']);
});
