import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

test('an uncorrelatable remote frame terminates active listeners with an error', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => socket.on('message', data => {
    const frame: unknown = JSON.parse(data.toString());
    const isKnown = isBridgeMessage(frame);
    if (isKnown) {
      switch (frame.type) {
        case 'attach':
          socket.send(JSON.stringify({ type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture',
            peerConnected: true, clientSessionId: 'active' }));
          return;
        case 'worker-sub':
          socket.send(JSON.stringify({ type: 'worker-snap', subId: frame.subId, value: 'Initial' }));
          return;
        case 'worker-op':
          socket.send('null');
      }
    }
  }));
  try {
    await once(server, 'listening');
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Expected a listening wire fixture');
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${address.port}` });
    const values: unknown[] = [];
    const errors: unknown[] = [];
    const stop = remote.channel.subscribe({ target: { __ref: 'doc', path: 'shared/greeting' } },
      value => values.push(value), error => errors.push(error));
    try {
      await expect.poll(() => values).toEqual(['Initial']);
      await expect(remote.channel.op({ method: 'getVersion' })).rejects.toMatchObject({ code: 'unavailable' });
      expect(errors).toEqual([expect.objectContaining({ code: 'unavailable' })]);
      expect(values).toEqual(['Initial']);
    } finally { stop(); remote.close(); }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
