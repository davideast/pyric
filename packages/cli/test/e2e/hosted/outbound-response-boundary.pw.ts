import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type WorkerResFrame, type WorkerSnapFrame } from '../../../src/bridge/protocol.js';
import { startHostedFixture } from './fixture.js';

test('legacy replies preserve the exact UTF-8 frame boundary and refuse only the oversized response', async ({ page }) => {
  const fixture = await startHostedFixture();
  const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
  let attached = false;
  let reply: { frame: WorkerResFrame; bytes: number } | { closed: number } | undefined;
  let snapshotReply: { frame: WorkerSnapFrame; bytes: number } | { closed: number } | undefined;
  socket.on('message', data => {
    const payload = data.toString();
    const frame: unknown = JSON.parse(payload);
    const isKnownFrame = isBridgeMessage(frame);
    if (isKnownFrame) {
      const isAcknowledgment = frame.type === 'attach-ack';
      if (isAcknowledgment) attached = true;
      const isResponse = frame.type === 'worker-res' && frame.id === 'sized-response';
      if (isResponse) reply = { frame, bytes: Buffer.byteLength(payload) };
      const isSnapshot = frame.type === 'worker-snap' && frame.subId === 'sized-snapshot';
      if (isSnapshot) snapshotReply = { frame, bytes: Buffer.byteLength(payload) };
    }
  });
  socket.on('close', code => { reply = { closed: code }; snapshotReply = { closed: code }; });
  const latestReply = () => reply;

  async function readCollection() {
    reply = undefined;
    socket.send(JSON.stringify({
      type: 'worker-op', id: 'sized-response',
      op: { method: 'getDocs', source: { __ref: 'collection', path: 'sized' }, actAs: { mode: 'admin' } },
    }));
    await expect.poll(latestReply).toBeDefined();
    const response = latestReply();
    const hasNoResponse = response === undefined;
    if (hasNoResponse) throw new Error('No correlated collection response');
    const connectionClosed = 'closed' in response;
    if (connectionClosed) throw new Error(`Connection closed with ${response.closed} instead of a correlated response`);
    return response;
  }

  async function fillDocuments(totalPayloadBytes: number) {
    await page.evaluate(async totalBytes => {
      const sdk = await import('firebase/firestore');
      const firstBytes = Math.floor(totalBytes / 2);
      const documents = [
        { id: 'first', bytes: firstBytes },
        { id: 'second', bytes: totalBytes - firstBytes },
      ];
      for (const document of documents) {
        const payload = 'é'.repeat(Math.floor(document.bytes / 2)) + 'x'.repeat(document.bytes % 2);
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'sized', document.id), { payload });
      }
    }, totalPayloadBytes);
  }

  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
    await expect.poll(() => attached).toBe(true);
    await fillDocuments(0);
    const empty = await readCollection();
    expect(empty.frame.ok).toBe(true);
    const frameLimit = 12 * 1024 * 1024;
    for (const expectedBytes of [frameLimit - 1, frameLimit, frameLimit + 1]) {
      await fillDocuments(expectedBytes - empty.bytes);
      const response = await readCollection();
      const exceedsLimit = expectedBytes > frameLimit;
      if (exceedsLimit) {
        expect(response.frame.ok).toBe(false);
        expect(response.frame.error).toEqual({
          code: 'resource-exhausted', message: 'Bridge response exceeds the 12 MiB encoded frame limit.',
        });
        expect(response.bytes).toBeLessThanOrEqual(frameLimit);
      } else {
        expect(response.frame.ok).toBe(true);
        expect(response.bytes).toBe(expectedBytes);
      }
      expect(socket.readyState).toBe(WebSocket.OPEN);
    }
    await fillDocuments(frameLimit + 1024 - empty.bytes);
    socket.send(JSON.stringify({
      type: 'worker-sub', subId: 'sized-snapshot',
      sub: { target: { __ref: 'collection', path: 'sized' }, actAs: { mode: 'admin' } },
    }));
    await expect.poll(() => snapshotReply).toMatchObject({
      frame: {
        type: 'worker-snap', subId: 'sized-snapshot',
        value: { __error: { code: 'resource-exhausted', message: 'Bridge response exceeds the 12 MiB encoded frame limit.' } },
      },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'worker-unsub', subId: 'sized-snapshot' }));
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    await fillDocuments(0);
    expect((await readCollection()).frame.ok).toBe(true);
  } finally {
    socket.close();
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await page.close();
    await fixture.stop();
  }
});
