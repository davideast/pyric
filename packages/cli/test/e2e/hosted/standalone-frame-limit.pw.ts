import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getAdminFirestore } from 'pyric/firestore';
import { connectBridge } from '../../../src/bridge/client/bridge.js';
import { startStandaloneBridge } from './standalone-bridge-fixture.js';

const frameLimit = 12 * 1024 * 1024;

for (const fragmented of [false, true]) {
  test(`standalone CLI refuses an oversized peer message (fragmented: ${fragmented}) and retains the healthy peer`, async () => {
    const fixture = await startStandaloneBridge();
    const sandbox = initializeSandbox();
    let connected = false;
    const peer = connectBridge(sandbox, {
      url: fixture.url.replace('http:', 'ws:') + '/sandbox', noReconnect: true,
      onStateChange: state => { connected = state.kind === 'connected'; },
    });
    const socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/sandbox');
    let closeCode = 0;
    socket.on('close', code => { closeCode = code; });
    const client = new Client({ name: 'frame-limit', version: '1' });
    try {
      await expect.poll(() => connected).toBe(true);
      await client.connect(new StreamableHTTPClientTransport(new URL(fixture.url + '/mcp')));
      await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
      sendHello(socket, frameLimit + 1, fragmented);
      await expect.poll(() => closeCode).toBe(1009);
      const result = await client.callTool({ name: 'firestore_create_document', arguments: {
        path: 'shared/healthy', data: { message: 'Healthy peer still receives writes' },
      } });
      expect(result.isError).not.toBe(true);
      expect((await getDoc(doc(getAdminFirestore(sandbox), 'shared/healthy'))).data()).toEqual({ message: 'Healthy peer still receives writes' });
    } finally {
      socket.close();
      peer.disconnect();
      try {
        await client.close();
      } finally {
        const code = await fixture.stop();
        await test.info().attach('bridge-output', { body: fixture.output(), contentType: 'text/plain' });
        expect(code).toBe(0);
      }
    }
  });
}

const acceptedFrames = [
  { bytes: frameLimit - 1, fragmented: false },
  { bytes: frameLimit, fragmented: false },
  { bytes: frameLimit, fragmented: true },
];

for (const { bytes, fragmented } of acceptedFrames) {
  test(`standalone CLI accepts ${bytes} encoded bytes (fragmented: ${fragmented})`, async () => {
    const fixture = await startStandaloneBridge();
    const socket = new WebSocket(fixture.url.replace('http:', 'ws:') + '/sandbox');
    let acknowledgment: unknown;
    socket.on('message', raw => { acknowledgment = JSON.parse(raw.toString()); });
    try {
      await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
      sendHello(socket, bytes, fragmented);
      await expect.poll(() => acknowledgment).toMatchObject({ type: 'hello-ack', protocol: 1 });
    } finally {
      socket.close();
      const code = await fixture.stop();
      await test.info().attach('bridge-output', { body: fixture.output(), contentType: 'text/plain' });
      expect(code).toBe(0);
    }
  });
}

function sendHello(socket: WebSocket, bytes: number, fragmented: boolean): void {
  const request = { type: 'hello', protocol: 1, sandboxId: 'sized-peer', tools: [], padding: '' };
  const paddingBytes = bytes - Buffer.byteLength(JSON.stringify(request));
  request.padding = 'é'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
  const payload = JSON.stringify(request);
  expect(Buffer.byteLength(payload)).toBe(bytes);
  if (fragmented) {
    const midpoint = Math.floor(payload.length / 2);
    socket.send(payload.slice(0, midpoint), { fin: false });
    socket.send(payload.slice(midpoint), { fin: true });
  } else {
    socket.send(payload);
  }
}
