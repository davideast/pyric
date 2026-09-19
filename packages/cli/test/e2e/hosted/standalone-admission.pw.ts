import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { doc, getDoc, getAdminFirestore } from 'pyric/firestore';
import { withBridgePeer } from './bridge-peer-fixture.js';
import { startStandaloneBridge } from './standalone-bridge-fixture.js';

test('standalone CLI refuses an incompatible peer and its buffered handshake', async () => {
  const fixture = await startStandaloneBridge();
  try {
    await withBridgePeer(fixture.url.replace('http:', 'ws:') + '/sandbox', fixture.url + '/mcp', async ({ client, sandbox }) => {
      const incompatibleVersions: unknown[] = [999, 0, undefined, null, '1', false, [], {}];
      for (const protocol of incompatibleVersions) {
        await refusesPeer(fixture.url, protocol);
        const result = await client.callTool({ name: 'firestore_create_document', arguments: {
          path: 'shared/healthy', data: { message: 'Healthy peer still receives writes' },
        } });
        expect(result.isError).not.toBe(true);
        expect((await getDoc(doc(getAdminFirestore(sandbox), 'shared/healthy'))).data()).toEqual({ message: 'Healthy peer still receives writes' });
      }
    });
  } finally {
    const code = await fixture.stop();
    await test.info().attach('bridge-output', { body: fixture.output(), contentType: 'text/plain' });
    expect(code).toBe(0);
  }
});

async function refusesPeer(url: string, protocol: unknown): Promise<void> {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/sandbox');
  const replies: string[] = [];
  let closeCode = 0;
  let closeReason = '';
  socket.on('close', (code, reason) => { closeCode = code; closeReason = reason.toString(); });
  socket.on('message', raw => { replies.push(raw.toString()); });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'hello', protocol, sandboxId: 'incompatible-peer', tools: [] }));
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'buffered-peer', tools: [] }));
    await expect.poll(() => closeCode).toBe(1008);
    expect(closeReason).toBe('Unsupported bridge protocol. Expected version 1.');
    expect(replies).toEqual([]);
  } finally {
    socket.close();
  }
}
