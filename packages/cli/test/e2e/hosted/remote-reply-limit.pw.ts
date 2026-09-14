import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type BridgeMessage } from '../../../src/bridge/protocol.js';

const frameLimit = 12 * 1024 * 1024;
for (const frameBytes of [frameLimit - 1, frameLimit, frameLimit + 1]) {
  test(`remote input enforces the ${frameBytes}-byte fragmented frame boundary without interrupting another client`, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const closedCodes: number[] = [];
    let sentBytes = 0;
    server.on('connection', socket => {
      socket.on('close', code => { closedCodes.push(code); });
      socket.on('error', () => {});
      socket.on('message', data => {
        const frame: unknown = JSON.parse(data.toString());
        const isUnknownFrame = !isBridgeMessage(frame);
        if (isUnknownFrame) throw new Error('Unexpected request envelope');
        const isAttach = frame.type === 'attach';
        if (isAttach) {
          const acknowledgment: BridgeMessage = {
            type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture', peerConnected: true, clientSessionId: 'reply-limit',
          };
          socket.send(JSON.stringify(acknowledgment));
        }
        const isOperation = frame.type === 'worker-op';
        if (isOperation) {
          const isLargeRead = frame.op.method === 'getDoc' && frame.op.path === 'large/reply';
          let value = 'Healthy';
          if (isLargeRead) {
            const empty: BridgeMessage = { type: 'worker-res', id: frame.id, ok: true, value: '' };
            const envelopeBytes = Buffer.byteLength(JSON.stringify(empty));
            const valueBytes = frameBytes - envelopeBytes;
            value = 'é'.repeat(Math.floor(valueBytes / 2)) + 'x'.repeat(valueBytes % 2);
          }
          const reply: BridgeMessage = { type: 'worker-res', id: frame.id, ok: true, value };
          const payload = JSON.stringify(reply);
          if (isLargeRead) {
            sentBytes = Buffer.byteLength(payload);
            socket.send(payload.slice(0, 1024), { fin: false });
            socket.send(payload.slice(1024), { fin: true });
          } else {
            socket.send(payload);
          }
        }
      });
    });
    try {
      await once(server, 'listening');
      const address = server.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('Expected a listening wire fixture');
      const url = `http://127.0.0.1:${address.port}`;
      const requesting = await connectRemoteSandbox({ url });
      const healthy = await connectRemoteSandbox({ url });
      try {
        const outcome = await requesting.channel.op({ method: 'getDoc', path: 'large/reply' }).then(
          () => 'accepted', () => 'refused',
        );
        expect(sentBytes).toBe(frameBytes);
        const exceedsLimit = frameBytes > frameLimit;
        if (exceedsLimit) {
          expect(outcome).toBe('refused');
          await expect.poll(() => closedCodes).toEqual([1009]);
          await expect(requesting.channel.op({ method: 'getDoc', path: 'shared/greeting' })).rejects.toMatchObject({ code: 'unavailable' });
        } else {
          expect(outcome).toBe('accepted');
          expect(closedCodes).toEqual([]);
          await expect(requesting.channel.op({ method: 'getDoc', path: 'shared/greeting' })).resolves.toBe('Healthy');
        }
        await expect(healthy.channel.op({ method: 'getDoc', path: 'shared/greeting' })).resolves.toBe('Healthy');
      } finally {
        requesting.close();
        healthy.close();
      }
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
