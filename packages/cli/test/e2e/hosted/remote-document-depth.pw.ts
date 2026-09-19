import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { getAdminFirestore, onSnapshot } from 'pyric/sandbox/admin-firestore';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';

for (const observes of ['read', 'listener']) {
  test(`public remote ${observes} refuses an over-depth document and remains usable`, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const unsubscribed: string[] = [];
    const deepJson = '{"nested":'.repeat(65) + 'null' + '}'.repeat(65);
    server.on('connection', socket => {
      socket.on('message', data => {
        const message: unknown = JSON.parse(data.toString());
        const isKnown = isBridgeMessage(message);
        if (isKnown) {
          switch (message.type) {
            case 'attach':
              socket.send(JSON.stringify({ type: 'attach-ack', protocol: 1, bridgeVersion: 'fixture', peerConnected: true, clientSessionId: 'depth' }));
              return;
            case 'worker-op': {
              const operation = message.op;
              const hasPath = 'path' in operation;
              const path = hasPath ? operation.path : '';
              const isDeep = path === 'shared/deep';
              const value = { id: 'document', path, exists: true,
                data: { json: isDeep ? deepJson : '{"message":"Healthy"}', valueEncoding: 'pyric/firestore-values/1' } };
              socket.send(JSON.stringify({ type: 'worker-res', id: message.id, ok: true, value }));
              return;
            }
            case 'worker-sub':
              socket.send(JSON.stringify({ type: 'worker-snap', subId: message.subId, value: {
                id: 'deep', path: 'shared/deep', exists: true,
                data: { json: deepJson, valueEncoding: 'pyric/firestore-values/1' },
              } }));
              return;
            case 'worker-unsub':
              unsubscribed.push(message.subId);
              return;
          }
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
        const firestore = getAdminFirestore(remote);
        const isRead = observes === 'read';
        if (isRead) {
          await expect(firestore.doc('shared/deep').get()).rejects.toMatchObject({ code: 'invalid-argument' });
        } else {
          const errors: unknown[] = [];
          const values: unknown[] = [];
          const stop = onSnapshot(firestore.doc('shared/deep'), snapshot => values.push(snapshot), error => errors.push(error));
          try {
            await expect.poll(() => errors).toEqual([expect.objectContaining({ code: 'invalid-argument' })]);
            await expect.poll(() => unsubscribed).toHaveLength(1);
            expect(values).toEqual([]);
          } finally {
            stop();
            stop();
          }
        }
        expect((await firestore.doc('shared/healthy').get()).data()).toEqual({ message: 'Healthy' });
      } finally {
        remote.close();
      }
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
