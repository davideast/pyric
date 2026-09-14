import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type WorkerOpPayload } from '../../../src/bridge/protocol.js';

for (const outcome of ['success', 'failure', 'timeout', 'close']) {
  test(`a remote client enforces the 24 MiB byte budget and releases reservations after ${outcome}`, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const held: Array<() => void> = [];
    const heldBytes: number[] = [];
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
          const holdsRead = frame.op.method === 'storage.putBytes' && frame.op.path.includes('/held-');
          if (holdsRead) {
            heldBytes.push(Buffer.byteLength(raw.toString()));
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
          const isRefusedRead = 'path' in frame.op && frame.op.path === 'excess';
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
            heldBytes.length = 0;
            const utf8 = new TextEncoder();
            function upload(path: string, bytes: number): WorkerOpPayload {
              const payload = { method: 'storage.putBytes', path, dataB64: '',
                metadata: { customMetadata: { label: 'é' } } } satisfies WorkerOpPayload;
              const payloadBytes = bytes - utf8.encode(JSON.stringify(payload)).byteLength;
              payload.dataB64 = 'AAAA'.repeat(Math.floor(payloadBytes / 4));
              payload.metadata.customMetadata.label += 'x'.repeat(payloadBytes % 4);
              return payload;
            }
            // This fits the aggregate allowance but exceeds the single-frame
            // limit. Its synchronous local refusal must release the reservation.
            await expect(remote.channel.op(upload('excess', 13 * 1024 * 1024)))
              .rejects.toMatchObject({ code: 'resource-exhausted' });
            expect(refusedFrames).toBe(0);
            const accepted = [1, 2, 3].map(index => {
              const isLast = index === 3;
              const payloadBytes = isLast ? 8 * 1024 * 1024 - 4096 : 8 * 1024 * 1024;
              return remote.channel.op(upload(`${round}/held-${index}`, payloadBytes)).catch((error: unknown) => {
                const hasCode = error instanceof Error && 'code' in error;
                if (hasCode) return error.code;
                return String(error);
              });
            });
            await expect.poll(() => held.length, round).toBe(3);
            const queuedWireBytes = heldBytes.reduce((total, bytes) => total + bytes, 0);
            expect(queuedWireBytes).toBeGreaterThan(24 * 1024 * 1024 - 4096);
            expect(queuedWireBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
            await expect(remote.channel.op(upload('excess', 8192))).rejects.toMatchObject({ code: 'resource-exhausted' });
            expect(refusedFrames).toBe(0);
            await expect(healthy.channel.op({ method: 'getDoc', path: 'healthy' })).resolves.toBe('completed');
            const closesClient = outcome === 'close';
            const timesOut = outcome === 'timeout';
            const failsReply = outcome === 'failure';
            if (closesClient) {
              remote.close();
              remote.close();
              expect(await Promise.all(accepted)).toEqual(Array(3).fill('unavailable'));
              await expect(remote.channel.op({ method: 'getDoc', path: 'after-close' })).rejects.toMatchObject({ code: 'unavailable' });
              await expect.poll(() => server.clients.size).toBe(1);
              await expect(healthy.channel.op({ method: 'getDoc', path: 'after-close' })).resolves.toBe('completed');
              break;
            }
            if (timesOut) {
              expect(await Promise.all(accepted)).toEqual(Array(3).fill('deadline-exceeded'));
              // Late replies cannot settle a later request or release its capacity.
              for (const release of held.splice(0)) release();
              continue;
            }
            for (const release of held.splice(0)) release();
            const expected = failsReply ? 'permission-denied' : 'completed';
            expect(await Promise.all(accepted)).toEqual(Array(3).fill(expected));
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
