import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type WorkerResFrame, type WorkerOpPayload } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const completion of ['success', 'failure', 'timeout', 'disconnect']) {
  test(`bridge queued bytes are released after ${completion} without starving another consumer`, async ({ page }) => {
    test.setTimeout(60_000);
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const socketUrl = `${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`;
    const held: Array<() => void> = [];
    const heldBytes: number[] = [];
    const replies = new Map<string, WorkerResFrame>();
    let attached = false;
    let excessFrames = 0;
    let failsReplies = completion === 'failure';
    function connectConsumer(): WebSocket {
      const socket = new WebSocket(socketUrl);
      socket.on('message', raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isUnknownFrame = !isBridgeMessage(frame);
        if (isUnknownFrame) return;
        const isAttach = frame.type === 'attach-ack';
        if (isAttach) attached = true;
        const isReply = frame.type === 'worker-res';
        if (isReply) replies.set(frame.id, frame);
      });
      return socket;
    }
    function upload(path: string, index: number): WorkerOpPayload {
      const payload = { method: 'storage.putBytes', path, dataB64: '',
        metadata: { customMetadata: { label: 'é' } }, actAs: { mode: 'admin' } } satisfies WorkerOpPayload;
      const isLast = index === 2;
      const targetBytes = isLast ? 8 * 1024 * 1024 - 4096 : 8 * 1024 * 1024;
      const dataBytes = targetBytes - Buffer.byteLength(JSON.stringify(payload));
      payload.dataB64 = 'AAAA'.repeat(Math.floor(dataBytes / 4));
      payload.metadata.customMetadata.label += 'x'.repeat(dataBytes % 4);
      return payload;
    }
    let consumer = connectConsumer();
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(raw => server.send(raw));
      server.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isOperation = isBridgeMessage(frame) && frame.type === 'worker-op';
        if (isOperation) {
          const holdsUpload = frame.op.method === 'storage.putBytes' && frame.op.path.includes('/held-');
          if (holdsUpload) {
            heldBytes.push(Buffer.byteLength(raw.toString()));
            held.push(() => {
              if (failsReplies) {
                server.send(JSON.stringify({ type: 'worker-res', id: frame.id, ok: false, error: { code: 'permission-denied', message: 'Controlled refusal' } }));
                return;
              }
              route.send(raw);
            });
            return;
          }
          const isExcessWrite = frame.op.method === 'setDoc' && frame.op.path === 'limit/refused';
          if (isExcessWrite) excessFrames += 1;
        }
        route.send(raw);
      });
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      await expect.poll(() => consumer.readyState).toBe(WebSocket.OPEN);
      consumer.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'capacity-consumer' }));
      await expect.poll(() => attached).toBe(true);
      const healthy = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        for (const round of ['first', 'second']) {
          replies.clear();
          heldBytes.length = 0;
          const acceptedIds = [0, 1, 2].map(index => `${round}-${index}`);
          for (const index of [0, 1, 2]) {
            consumer.send(JSON.stringify({
              type: 'worker-op', id: `${round}-${index}`,
              op: upload(`${round}/held-${index}`, index),
            }));
          }
          await expect.poll(() => held.length).toBe(3);
          const queuedBytes = heldBytes.reduce((total, bytes) => total + bytes, 0);
          expect(queuedBytes).toBeGreaterThan(24 * 1024 * 1024 - 4096);
          expect(queuedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
          consumer.send(JSON.stringify({
            type: 'worker-op', id: 'excess', clientSessionId: 'forged-consumer',
            op: { method: 'setDoc', path: 'limit/refused', data: { message: 'é'.repeat(4096) }, actAs: { mode: 'admin' } },
          }));
          await expect.poll(() => replies.get('excess')).toMatchObject({ ok: false, error: { code: 'resource-exhausted' } });
          expect(excessFrames).toBe(0);
          await expect(healthy.channel.op({ method: 'getDoc', path: 'limit/refused', actAs: { mode: 'admin' } })).resolves.toMatchObject({ exists: false });
          await page.locator('#write').click();
          await expect(page.locator('#write-result')).toHaveText('Written');
          const isFirstRound = round === 'first';
          const timesOut = isFirstRound && completion === 'timeout';
          const disconnects = isFirstRound && completion === 'disconnect';
          if (disconnects) consumer.send(JSON.stringify({ type: 'worker-client-disconnect', clientSessionId: 'capacity-consumer' }));
          const waitsForCleanup = timesOut || disconnects;
          const completesThroughPeer = !waitsForCleanup;
          if (completesThroughPeer) {
            // Keep two reservations live while proving the first one's bytes
            // become available again, rather than only testing an empty owner.
            held.shift()?.();
            await expect.poll(() => replies.has(`${round}-0`)).toBe(true);
            const replacementId = `${round}-replacement`;
            acceptedIds.push(replacementId);
            consumer.send(JSON.stringify({ type: 'worker-op', id: replacementId,
              op: upload(`${round}/held-replacement`, 0) }));
            await expect.poll(() => held.length).toBe(3);
          }
          if (waitsForCleanup) {
            await expect.poll(() => replies.size, { timeout: 35_000 }).toBe(acceptedIds.length + 1);
            // Discard withheld wire requests after observing bridge settlement.
            held.splice(0);
          } else {
            for (const release of held.splice(0)) release();
            await expect.poll(() => replies.size).toBe(acceptedIds.length + 1);
          }
          let errorCode: string | undefined;
          if (failsReplies) errorCode = 'permission-denied';
          if (timesOut) errorCode = 'deadline-exceeded';
          if (disconnects) errorCode = 'unavailable';
          const expectsFailure = errorCode !== undefined;
          const expectedReply = expectsFailure ? { ok: false, error: { code: errorCode } } : { ok: true };
          for (const id of acceptedIds) {
            expect(replies.get(id)).toMatchObject(expectedReply);
          }
          failsReplies = false;
          if (disconnects) {
            consumer.send(JSON.stringify({ type: 'worker-client-disconnect', clientSessionId: 'capacity-consumer' }));
            consumer.close();
            await expect.poll(() => consumer.readyState).toBe(WebSocket.CLOSED);
            attached = false;
            consumer = connectConsumer();
            await expect.poll(() => consumer.readyState).toBe(WebSocket.OPEN);
            consumer.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'capacity-consumer' }));
            await expect.poll(() => attached).toBe(true);
          }
        }
      } finally {
        healthy.close();
      }
    } finally {
      consumer.close();
      await page.close().finally(() => fixture.stop());
    }
  });
}
