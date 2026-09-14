import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type WorkerResFrame } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const completion of ['success', 'failure', 'timeout', 'disconnect']) {
  test(`bridge capacity is released after ${completion} without starving another consumer`, async ({ page }) => {
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
    let consumer = connectConsumer();
    await page.routeWebSocket('**/__pyric/sandbox', route => {
      const server = route.connectToServer();
      route.onMessage(raw => server.send(raw));
      server.onMessage(raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isOperation = isBridgeMessage(frame) && frame.type === 'worker-op';
        if (isOperation) {
          const holdsRead = frame.op.method === 'getDoc' && frame.op.path === 'shared/held';
          if (holdsRead) {
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
          for (const index of Array.from({ length: 256 }, (_, index) => index)) {
            consumer.send(JSON.stringify({
              type: 'worker-op', id: `${round}-${index}`,
              op: { method: 'getDoc', path: 'shared/held', actAs: { mode: 'admin' } },
            }));
          }
          await expect.poll(() => held.length).toBe(256);
          consumer.send(JSON.stringify({
            type: 'worker-op', id: 'excess', clientSessionId: 'forged-consumer',
            op: { method: 'setDoc', path: 'limit/refused', data: { message: 'Must not be written' }, actAs: { mode: 'admin' } },
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
          if (waitsForCleanup) {
            await expect.poll(() => replies.size, { timeout: 35_000 }).toBe(257);
            // Discard withheld wire requests after observing bridge settlement.
            held.splice(0);
          } else {
            for (const release of held.splice(0)) release();
            await expect.poll(() => replies.size).toBe(257);
          }
          let errorCode: string | undefined;
          if (failsReplies) errorCode = 'permission-denied';
          if (timesOut) errorCode = 'deadline-exceeded';
          if (disconnects) errorCode = 'unavailable';
          const expectsFailure = errorCode !== undefined;
          const expectedReply = expectsFailure ? { ok: false, error: { code: errorCode } } : { ok: true };
          for (const index of Array.from({ length: 256 }, (_, index) => index)) {
            expect(replies.get(`${round}-${index}`)).toMatchObject(expectedReply);
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
