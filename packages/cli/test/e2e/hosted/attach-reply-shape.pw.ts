import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

test('remote attachment refuses malformed required fields and optional routing metadata', async () => {
  const valid = { type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture', peerConnected: true, clientSessionId: 'fixture' };
  const invalid = [{ peerConnected: 'yes' }, { bridgeVersion: 7 }, { clientSessionId: 7 },
    { capabilities: [7] }, { resumeToken: 7 }, { hostInstanceId: {} }, { projectKey: [] }];
  let fields: Record<string, unknown> = {};
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => socket.on('message', data => {
    const message: unknown = JSON.parse(data.toString());
    const isAttach = isBridgeMessage(message) && message.type === 'attach';
    if (isAttach) socket.send(JSON.stringify({ ...valid, ...fields }));
  }));
  try {
    await once(server, 'listening');
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Expected a listening wire fixture');
    const url = `http://127.0.0.1:${address.port}`;
    for (const fault of invalid) {
      fields = fault;
      const outcome = await connectRemoteSandbox({ url }).then(remote => { remote.close(); return 'accepted'; }, error => error.code);
      expect.soft(outcome, JSON.stringify(fault)).toBe('unavailable');
    }
    fields = {};
    const healthy = await connectRemoteSandbox({ url });
    healthy.close();
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
