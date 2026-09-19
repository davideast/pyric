import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

for (const outcome of ['success', 'failure', 'timeout', 'close']) {
  test(`a saturated remote client releases pending operations after ${outcome}`, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const held: Array<() => void> = [];
    let refusedFrames = 0;
    server.on('connection', socket => {
      socket.on('message', raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isUnknownFrame = !isBridgeMessage(frame);
        if (isUnknownFrame) throw new Error('Unexpected wire envelope');
        const isAttach = frame.type === 'attach';
        if (isAttach) {
          socket.send(JSON.stringify({
            type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture', peerConnected: true, clientSessionId: 'remote',
          }));
        }
        const isOperation = frame.type === 'worker-op';
        if (isOperation) {
          const reply = (): void => socket.send(JSON.stringify({ type: 'worker-res', id: frame.id, ok: true, value: 'completed' }));
          const holdsRead = frame.op.method === 'getDoc' && frame.op.path === 'held';
          if (holdsRead) {
            held.push(() => {
              const failsReply = outcome === 'failure';
              if (failsReply) {
                socket.send(JSON.stringify({ type: 'worker-res', id: frame.id, ok: false, error: { code: 'permission-denied', message: 'Fixture refusal' } }));
                return;
              }
              reply();
            });
            return;
          }
          const isRefusedRead = frame.op.method === 'getDoc' && frame.op.path === 'excess';
          if (isRefusedRead) refusedFrames += 1;
          reply();
        }
      });
    });
    try {
      await once(server, 'listening');
      const address = server.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The capacity fixture has no listening address.');
      const url = `http://127.0.0.1:${address.port}`;
      const remote = await connectRemoteSandbox({ url, opTimeoutMs: 2_000 });
      try {
        const healthy = await connectRemoteSandbox({ url });
        try {
          for (const round of ['first', 'second']) {
            const accepted = Array.from({ length: 256 }, () =>
              remote.channel.op({ method: 'getDoc', path: 'held' }).catch((error: unknown) => {
                const hasCode = error instanceof Error && 'code' in error;
                if (hasCode) return error.code;
                return String(error);
              }));
            await expect.poll(() => held.length, round).toBe(256);
            await expect(remote.channel.op({ method: 'getDoc', path: 'excess' })).rejects.toMatchObject({ code: 'resource-exhausted' });
            expect(refusedFrames).toBe(0);
            await expect(healthy.channel.op({ method: 'getDoc', path: 'healthy' })).resolves.toBe('completed');
            const closesClient = outcome === 'close';
            const timesOut = outcome === 'timeout';
            const failsReply = outcome === 'failure';
            if (closesClient) {
              remote.close();
              remote.close();
              expect(await Promise.all(accepted)).toEqual(Array(256).fill('unavailable'));
              await expect(remote.channel.op({ method: 'getDoc', path: 'after-close' })).rejects.toMatchObject({ code: 'unavailable' });
              await expect.poll(() => server.clients.size).toBe(1);
              await expect(healthy.channel.op({ method: 'getDoc', path: 'after-close' })).resolves.toBe('completed');
              break;
            }
            if (timesOut) {
              expect(await Promise.all(accepted)).toEqual(Array(256).fill('deadline-exceeded'));
              // Late replies cannot settle a later request or release its capacity.
              for (const release of held.splice(0)) release();
              continue;
            }
            for (const release of held.splice(0)) release();
            const expected = failsReply ? 'permission-denied' : 'completed';
            expect(await Promise.all(accepted)).toEqual(Array(256).fill(expected));
          }
        } finally {
          healthy.close();
        }
      } finally {
        remote.close();
      }
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
