import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { doc, getDoc, getAdminFirestore } from 'pyric/firestore';
import { withBridgePeer } from './bridge-peer-fixture.js';
import { startStandaloneBridge } from './standalone-bridge-fixture.js';

const invalidJson = ['', '{invalid JSON', '{"type":'];
const unknownEnvelopes = [null, true, 42, 'hello', [], {}, { type: null }, { type: 'unknown-frame' }];
const invalidFrames = [
  ...invalidJson.map(raw => ({ raw, reason: 'Invalid bridge message JSON.' })),
  ...unknownEnvelopes.map(value => ({ raw: JSON.stringify(value), reason: 'Unrecognized bridge message envelope.' })),
];

test('standalone CLI refuses invalid JSON and envelopes without admitting buffered work', async () => {
  const fixture = await startStandaloneBridge();
  const socketUrl = fixture.url.replace('http:', 'ws:') + '/sandbox';
  let exitCode: number | null;
  try {
    await withBridgePeer(socketUrl, fixture.url + '/mcp', async ({ client, sandbox }) => {
      for (const [index, frame] of invalidFrames.entries()) {
        await refusesFrame(socketUrl, frame.raw, frame.reason);
        const message = `Healthy after malformed frame ${index}`;
        const result = await client.callTool({ name: 'firestore_create_document', arguments: {
          path: 'shared/healthy', data: { message },
        } });
        expect(result.isError).not.toBe(true);
        expect((await getDoc(doc(getAdminFirestore(sandbox), 'shared/healthy'))).data()).toEqual({ message });
      }
    });
  } finally {
    exitCode = await fixture.stop();
    await test.info().attach('bridge-output', { body: fixture.output(), contentType: 'text/plain' });
  }
  expect(exitCode).toBe(0);
});

async function refusesFrame(url: string, raw: string, reason: string): Promise<void> {
  const socket = new WebSocket(url);
  const replies: string[] = [];
  let closeCode = 0;
  let closeReason = '';
  socket.on('close', (code, message) => { closeCode = code; closeReason = message.toString(); });
  socket.on('message', data => { replies.push(data.toString()); });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(raw);
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'buffered-peer', tools: [] }));
    await expect.poll(() => closeCode).toBe(1002);
    expect(closeReason).toBe(reason);
    expect(replies).toEqual([]);
  } finally {
    socket.close();
  }
}
