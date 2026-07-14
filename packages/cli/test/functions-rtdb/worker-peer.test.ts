import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from './worker-peer.js';

let server: WebSocketServer | undefined;

afterEach(() => {
  if (!server) return;
  for (const client of server.clients) client.terminate();
  server.close();
  server = undefined;
});

describe('Functions worker peer test support', () => {
  test('rejects immediately when the socket closes before hello-ack', async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    server.once('connection', (socket) => socket.close());
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('expected TCP address');
    const ctx = await createFunctionsWorkerHostCtx({
      persistenceKeyPrefix: 'worker-peer-test',
      instanceId: 'worker-peer-test',
    });

    await expect(connectFunctionsWorkerPeer({
      url: `ws://127.0.0.1:${address.port}`,
      ctx,
      sandboxId: 'worker-peer-test',
    })).rejects.toThrow('worker peer closed before ready');
  });
});
