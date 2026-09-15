import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

const outcomes = [{}, { ok: null }, { ok: 'true' }, { ok: 0 },
  { ok: false }, { ok: false, error: {} },
  { ok: false, error: { code: 403, message: 'Denied' } },
  { ok: false, error: { code: 'denied', message: null } }];

test('published remote rejects malformed reply outcomes without losing subsequent work', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let faultIndex = 0;
  server.on('connection', socket => {
    socket.on('message', data => {
      const message: unknown = JSON.parse(data.toString());
      const isKnown = isBridgeMessage(message);
      if (isKnown) {
        switch (message.type) {
          case 'attach':
            socket.send(JSON.stringify({ type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture',
              peerConnected: true, clientSessionId: 'remote-shape' }));
            return;
          case 'worker-op': {
            const outcome = outcomes[faultIndex++];
            const hasFault = outcome !== undefined;
            const fields = hasFault ? outcome : { ok: true, value: 'Healthy' };
            socket.send(JSON.stringify({ type: 'worker-res', id: message.id, ...fields }));
          }
        }
      }
    });
  });
  try {
    await once(server, 'listening');
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Expected a wire fixture address');
    const remote = await connectRemoteSandbox({ url: `http://127.0.0.1:${address.port}`, opTimeoutMs: 1_000 });
    try {
      for (const fields of outcomes) {
        const outcome = await remote.channel.op({ method: 'getVersion' }).then(
          () => 'accepted', error => error.code,
        );
        expect.soft(outcome, JSON.stringify(fields)).toBe('unavailable');
      }
      await expect(remote.channel.op({ method: 'getVersion' })).resolves.toBe('Healthy');
    } finally {
      remote.close();
    }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('published remote terminates uncorrelatable replies without stranding another connection', async () => {
  const malformed = ['{', 'null', '[]', '{}', '{"type":"unknown"}',
    '{"type":"worker-res","ok":true}', '{"type":"worker-res","id":7,"ok":true}'];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let currentFault = malformed[0];
  server.on('connection', socket => {
    socket.on('message', data => {
      const message: unknown = JSON.parse(data.toString());
      const isKnown = isBridgeMessage(message);
      if (isKnown) {
        switch (message.type) {
          case 'attach':
            socket.send(JSON.stringify({ type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture',
              peerConnected: true, clientSessionId: 'remote-envelope' }));
            return;
          case 'worker-op': {
            const injectsFault = message.op.method === 'getDoc';
            if (injectsFault) socket.send(currentFault);
            else socket.send(JSON.stringify({ type: 'worker-res', id: message.id, ok: true, value: 'Healthy' }));
          }
        }
      }
    });
  });
  try {
    await once(server, 'listening');
    const address = server.address();
    const hasNoAddress = address === null || typeof address === 'string';
    if (hasNoAddress) throw new Error('Expected a wire fixture address');
    const url = `http://127.0.0.1:${address.port}`;
    const healthy = await connectRemoteSandbox({ url });
    try {
      for (const frame of malformed) {
        currentFault = frame;
        const remote = await connectRemoteSandbox({ url, opTimeoutMs: 1_000 });
        try {
          const outcome = await remote.channel.op({ method: 'getDoc', path: 'shared/greeting' }).then(
            () => 'accepted', error => error.code,
          );
          expect.soft(outcome, frame).toBe('unavailable');
          await expect(healthy.channel.op({ method: 'getVersion' })).resolves.toBe('Healthy');
        } finally {
          remote.close();
        }
      }
    } finally {
      healthy.close();
    }
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
