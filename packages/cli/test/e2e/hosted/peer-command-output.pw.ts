import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type WorkerOpFrame, type WorkerResFrame, type WorkerSubFrame, type WorkerSnapFrame } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const kind of ['operation', 'subscription']) {
  test(`relay metadata refuses an oversized peer ${kind} without disconnecting consumers`, async ({ page }) => {
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
    let attached = false;
    let peerCloses = 0;
    const replies = new Map<string, WorkerResFrame | WorkerSnapFrame>();
    page.on('websocket', peer => peer.on('close', () => { peerCloses += 1; }));
    socket.on('message', raw => {
      const frame: unknown = JSON.parse(raw.toString());
      const isKnownFrame = isBridgeMessage(frame);
      if (isKnownFrame) {
        const isAttach = frame.type === 'attach-ack';
        if (isAttach) attached = true;
        const isReply = frame.type === 'worker-res';
        if (isReply) replies.set(frame.id, frame);
        const isSnapshot = frame.type === 'worker-snap';
        if (isSnapshot) replies.set(frame.subId, frame);
      }
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
      socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
      await expect.poll(() => attached).toBe(true);
      const isOperation = kind === 'operation';
      function request(value: string): WorkerOpFrame | WorkerSubFrame {
        if (isOperation) {
          return {
            type: 'worker-op', id: 'boundary',
            op: { method: 'setDoc', path: 'shared/refused', data: { message: value }, actAs: { mode: 'admin' } },
          };
        }
        return {
          type: 'worker-sub', subId: 'boundary', sub: {
            target: {
              __ref: 'query', source: { __ref: 'collection', path: 'shared' },
              constraints: [{ kind: 'where', field: 'message', op: '==', value }],
            },
            actAs: { mode: 'admin' },
          },
        };
      }
      const payloadBytes = 12 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(request('')));
      const value = 'é'.repeat(Math.floor(payloadBytes / 2)) + 'x'.repeat(payloadBytes % 2);
      const payload = JSON.stringify(request(value));
      expect(Buffer.byteLength(payload)).toBe(12 * 1024 * 1024);
      socket.send(payload);
      if (isOperation) {
        await expect.poll(() => replies.get('boundary')).toMatchObject({ ok: false, error: { code: 'resource-exhausted' } });
      } else {
        await expect.poll(() => replies.get('boundary')).toMatchObject({ value: { __error: { code: 'resource-exhausted' } } });
        socket.send(JSON.stringify({ type: 'worker-unsub', subId: 'boundary' }));
      }
      const exists = await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        return (await sdk.getDoc(sdk.doc(sdk.getFirestore(), 'shared/refused'))).exists();
      });
      expect(exists).toBe(false);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      socket.send(JSON.stringify({
        type: 'worker-op', id: 'healthy', op: { method: 'getDoc', path: 'shared/greeting', actAs: { mode: 'admin' } },
      }));
      await expect.poll(() => replies.get('healthy')).toMatchObject({ ok: true, value: { exists: true } });
      expect(peerCloses).toBe(0);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
      await page.close().finally(() => fixture.stop());
    }
  });
}
