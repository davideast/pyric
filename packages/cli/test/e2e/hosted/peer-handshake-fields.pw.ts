import { WebSocket } from 'ws';
import { withBridgePeer } from './bridge-peer-fixture.js';
import { expect, test } from '@playwright/test';
import { doc, getDoc, getAdminFirestore } from 'pyric/firestore';
import { startSoakServe } from '../soak/harness.js';
import { startStandaloneBridge } from './standalone-bridge-fixture.js';

const malformedLists: unknown[] = [undefined, null, 42, false, 'tools', {}, [42], ['tool', null]];
const malformedIdentities: unknown[] = [undefined, null, 42, false, [], {}];
const malformedCapabilities = malformedLists.filter(value => value !== undefined);
const malformedFields = [
  ...malformedLists.map(tools => ({ tools })),
  ...malformedIdentities.map(sandboxId => ({ sandboxId })),
  ...malformedCapabilities.map(capabilities => ({ capabilities })),
];

test('standalone bridge refuses malformed peer fields without losing its healthy peer', async () => {
  const fixture = await startStandaloneBridge();
  let exitCode: number | null;
  try {
    await checkPeerFields(fixture.url.replace('http:', 'ws:') + '/sandbox', fixture.url + '/mcp');
  } finally {
    exitCode = await fixture.stop();
    await test.info().attach('bridge-output', { body: fixture.output(), contentType: 'text/plain' });
  }
  expect(exitCode).toBe(0);
});

test('mounted bridge refuses malformed peer fields without losing its healthy peer', async () => {
  const fixture = await startSoakServe({ flags: ['--no-capture'] });
  try {
    await checkPeerFields(fixture.info.url.replace('http:', 'ws:') + '/__pyric/sandbox', fixture.info.url + '/__pyric/mcp');
  } finally {
    await fixture.stop();
    await test.info().attach('bridge-output', { body: fixture.stderr(), contentType: 'text/plain' });
  }
});

async function checkPeerFields(socketUrl: string, mcpUrl: string): Promise<void> {
  await withBridgePeer(socketUrl, mcpUrl, async ({ client, sandbox }) => {
    for (const [index, fields] of malformedFields.entries()) {
      await checkHello(socketUrl, fields, false);
      const message = `Healthy peer after malformed frame ${index}`;
      const result = await client.callTool({ name: 'firestore_create_document', arguments: {
        path: 'shared/healthy', data: { message },
      } });
      expect(result.isError).not.toBe(true);
      expect((await getDoc(doc(getAdminFirestore(sandbox), 'shared/healthy'))).data()).toEqual({ message });
    }
    await checkHello(socketUrl, {}, true);
    await checkHello(socketUrl, { sandboxId: '', tools: [], capabilities: [] }, true);
    await checkHello(socketUrl, { tools: ['future-tool'], capabilities: ['future-capability'] }, true);
  });
}

async function checkHello(url: string, fields: Record<string, unknown>, acceptsPeer: boolean): Promise<void> {
  const socket = new WebSocket(url);
  const replies: unknown[] = [];
  let closeCode = 0;
  let closeReason = '';
  socket.on('close', (code, reason) => { closeCode = code; closeReason = reason.toString(); });
  socket.on('message', raw => { replies.push(JSON.parse(raw.toString())); });
  try {
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'candidate', tools: [], ...fields }));
    if (acceptsPeer) {
      await expect.poll(() => replies[0]).toMatchObject({ type: 'hello-ack', protocol: 1 });
    } else {
      socket.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'buffered-peer', tools: [] }));
      await expect.poll(() => closeCode).toBe(1002);
      expect(closeReason).toBe('Invalid sandbox peer handshake.');
      expect(replies).toEqual([]);
    }
  } finally {
    socket.close();
  }
}
