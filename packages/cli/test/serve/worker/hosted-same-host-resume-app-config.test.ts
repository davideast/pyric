import { afterEach, expect, test } from 'bun:test';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import {
  getHostedFirestore,
  type HostedConnectionState,
} from '../../../src/serve/worker/client/websocket-connection.js';
import type { InboundMessage } from '../../../src/serve/worker/protocol.js';

// #1222: when a socket closes right after `attach-ack`, before the host reads
// the `appConfig` frame flushed during initial attachment, the client resumes
// on the same `hostInstanceId` and `resumeToken`. That same-host resume must
// still deliver `appConfig` so the host session is not left unconfigured.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function until(
  condition: () => boolean,
  describeState: () => string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms: ${describeState()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('resuming on the same host after an early socket drop delivers appConfig without duplicating a newly held appConfig', async () => {
  const received: BridgeMessage[] = [];
  let connectionCount = 0;

  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data)) as BridgeMessage;
        if (message.type === 'attach') {
          connectionCount += 1;
          received.push(message);
          socket.send(
            JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: 'client-boot-1',
              projectKey: 'orbit',
              hostInstanceId: 'boot-1',
              resumeToken: 'token-boot-1',
              capabilities: ['worker-port'],
            } satisfies BridgeMessage),
          );
          if (connectionCount === 1) {
            // Close immediately after attach-ack, before reading any subsequent
            // worker-message frames sent on this first socket.
            socket.close(1012, 'early drop before appConfig read');
          }
          return;
        }
        // Ignore any trailing frame from socket #1 if buffered in loopback.
        if (connectionCount === 1) return;
        received.push(message);
        if (
          message.type === 'worker-message' &&
          message.message.t === 'op' &&
          message.message.method === 'sandbox.clock'
        ) {
          socket.send(
            JSON.stringify({
              type: 'worker-message-result',
              clientSessionId: 'client-boot-1',
              message: {
                t: 'res',
                id: message.message.id,
                ok: true,
                value: { now: 123 },
              },
            } satisfies BridgeMessage),
          );
        }
      },
    },
  });
  cleanups.push(() => {
    void server.stop(true);
  });

  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({
    url: `ws://127.0.0.1:${server.port}/__pyric/sandbox`,
    projectKey: 'orbit',
    initialHostInstanceId: 'boot-1',
    onConnection: next => states.push(next),
  });
  cleanups.push(() => db.port.close());

  db.port.postMessage({
    t: 'appConfig',
    options: {
      projectId: 'orbit',
      databaseURL: 'https://orbit-custom-rtdb.firebaseio.com',
    },
  } as InboundMessage);

  await until(
    () => connectionCount >= 2 && states.at(-1) === 'attached',
    () => JSON.stringify({ connectionCount, states, received }),
  );

  // Give the resumed attachment a tick to finish flushing its resume frames.
  await new Promise(resolve => setTimeout(resolve, 40));

  const attaches = received.filter(
    (m): m is Extract<BridgeMessage, { type: 'attach' }> => m.type === 'attach',
  );
  expect(attaches).toHaveLength(2);
  expect(attaches[1]?.resumeToken).toBe('token-boot-1');
  expect(attaches[1]?.hostInstanceId).toBe('boot-1');

  const appConfigs = received
    .filter(
      (m): m is Extract<BridgeMessage, { type: 'worker-message' }> => m.type === 'worker-message',
    )
    .map(m => m.message)
    .filter(m => m.t === 'appConfig');

  expect(appConfigs).toEqual([
    {
      t: 'appConfig',
      options: {
        projectId: 'orbit',
        databaseURL: 'https://orbit-custom-rtdb.firebaseio.com',
      },
    },
  ]);
});

test('does not duplicate appConfig on same-host resume when appConfig was posted while interrupted', async () => {
  const received: BridgeMessage[] = [];
  let connectionCount = 0;
  const activeSockets = new Set<{ close(code?: number, reason?: string): void }>();

  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(socket) {
        activeSockets.add(socket);
      },
      close(socket) {
        activeSockets.delete(socket);
      },
      message(socket, data) {
        const message = JSON.parse(String(data)) as BridgeMessage;
        received.push(message);
        if (message.type === 'attach') {
          connectionCount += 1;
          socket.send(
            JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: 'client-boot-1',
              projectKey: 'orbit',
              hostInstanceId: 'boot-1',
              resumeToken: 'token-boot-1',
              capabilities: ['worker-port'],
            } satisfies BridgeMessage),
          );
        }
      },
    },
  });
  cleanups.push(() => {
    void server.stop(true);
  });

  const states: HostedConnectionState[] = [];
  const db = getHostedFirestore({
    url: `ws://127.0.0.1:${server.port}/__pyric/sandbox`,
    projectKey: 'orbit',
    initialHostInstanceId: 'boot-1',
    onConnection: next => states.push(next),
  });
  cleanups.push(() => db.port.close());

  await until(
    () => states.at(-1) === 'attached',
    () => JSON.stringify({ states }),
  );
  for (const socket of [...activeSockets]) socket.close(1012, 'drop while unconfigured');
  await until(
    () => states.includes('interrupted'),
    () => JSON.stringify({ states }),
  );

  // Posted while detached -> held in `held` queue; must be sent once on resume.
  db.port.postMessage({
    t: 'appConfig',
    options: { projectId: 'orbit' },
  } as InboundMessage);

  await until(
    () => connectionCount >= 2 && states.at(-1) === 'attached',
    () => JSON.stringify({ connectionCount, states, received }),
  );
  await new Promise(resolve => setTimeout(resolve, 40));

  const appConfigs = received
    .filter(
      (m): m is Extract<BridgeMessage, { type: 'worker-message' }> => m.type === 'worker-message',
    )
    .map(m => m.message)
    .filter(m => m.t === 'appConfig');

  expect(appConfigs).toEqual([{ t: 'appConfig', options: { projectId: 'orbit' } }]);
});
