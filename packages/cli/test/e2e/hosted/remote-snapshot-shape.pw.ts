import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

test('public remote refuses malformed snapshots and releases their subscriptions', async () => {
  const malformed = [{}, ...[null, false, {}, 'Denied', { code: 7, message: 'Denied' },
    { code: 'denied', message: null }].map(error => ({ value: { __error: error } }))];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const unsubscribed: string[] = [];
  let faultIndex = 0;
  server.on('connection', socket => socket.on('message', data => {
    const message: unknown = JSON.parse(data.toString());
    const isKnown = isBridgeMessage(message);
    if (isKnown) {
      switch (message.type) {
        case 'attach':
          socket.send(JSON.stringify({ type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture',
            peerConnected: true, clientSessionId: 'remote-snapshot' }));
          return;
        case 'worker-sub': {
          const fields = malformed[faultIndex++];
          socket.send(JSON.stringify({ type: 'worker-snap', subId: message.subId, ...fields }));
          return;
        }
        case 'worker-unsub':
          unsubscribed.push(message.subId);
          socket.send(JSON.stringify({ type: 'worker-snap', subId: message.subId, value: 'late' }));
          return;
        case 'worker-op':
          socket.send(JSON.stringify({ type: 'worker-res', id: message.id, ok: true, value: 'Healthy' }));
      }
    }
  }));
  try {
    await once(server, 'listening');
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Expected a listening wire fixture');
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${address.port}` });
    try {
      const deliveries: unknown[] = [];
      for (const [index, frame] of malformed.entries()) {
        const errors: unknown[] = [];
        const stop = remote.channel.subscribe({ target: { __ref: 'doc', path: 'shared/greeting' } },
          value => deliveries.push(value), error => errors.push(error));
        try {
          await expect.soft.poll(() => errors, { timeout: 1_000, message: JSON.stringify(frame) })
            .toEqual([expect.objectContaining({ code: 'unavailable' })]);
          await expect.soft.poll(() => unsubscribed.length, { timeout: 1_000 }).toBe(index + 1);
          await expect(remote.channel.op({ method: 'getVersion' })).resolves.toBe('Healthy');
          expect.soft(deliveries).toEqual([]);
        } finally { stop(); }
      }
    } finally { remote.close(); }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
