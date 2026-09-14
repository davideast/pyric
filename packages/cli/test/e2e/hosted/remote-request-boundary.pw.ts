import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type BridgeMessage } from '../../../src/bridge/protocol.js';

test('remote request admission measures the complete UTF-8 frame at its exact boundary', async () => {
  // Accept oversized traffic here so server-side limits cannot hide a client admission failure.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 24 * 1024 * 1024 });
  const receivedBytes: number[] = [];
  server.on('connection', socket => {
    socket.on('message', data => {
      const frame: unknown = JSON.parse(data.toString());
      const isUnknownFrame = !isBridgeMessage(frame);
      if (isUnknownFrame) throw new Error('Unexpected request envelope');
      const isAttach = frame.type === 'attach';
      if (isAttach) {
        const acknowledgment: BridgeMessage = {
          type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture', peerConnected: true, clientSessionId: 'boundary',
        };
        socket.send(JSON.stringify(acknowledgment));
      }
      const isOperation = frame.type === 'worker-op';
      if (isOperation) {
        const bytes = Buffer.byteLength(data.toString());
        receivedBytes.push(bytes);
        const reply: BridgeMessage = { type: 'worker-res', id: frame.id, ok: true, value: bytes };
        socket.send(JSON.stringify(reply));
      }
    });
  });
  try {
    await once(server, 'listening');
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Expected a listening wire fixture');
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${address.port}` });
    try {
      const send = (message: string) => remote.channel.op({ method: 'setDoc', path: 'shared/sized', data: { message } });
      const envelopeBytes = await send('');
      const hasInvalidMeasurement = typeof envelopeBytes !== 'number';
      if (hasInvalidMeasurement) throw new Error('Expected measured wire bytes');
      const limit = 12 * 1024 * 1024;
      for (const bytes of [limit - 1, limit, limit + 1]) {
        const payloadBytes = bytes - envelopeBytes;
        const message = 'é'.repeat(Math.floor(payloadBytes / 2)) + 'x'.repeat(payloadBytes % 2);
        const exceedsLimit = bytes > limit;
        if (exceedsLimit) await expect(send(message)).rejects.toMatchObject({ code: 'resource-exhausted' });
        else await expect(send(message)).resolves.toBe(bytes);
      }
      // A subsequent reply is a wire-order barrier: no refused frame may have reached the server.
      await expect(send('')).resolves.toBe(envelopeBytes);
      expect(receivedBytes).toEqual([envelopeBytes, limit - 1, limit, envelopeBytes]);
    } finally {
      remote.close();
    }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
