import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const replacesExisting of [false, true]) {
  test(`presence capacity refuses a consumer without affecting healthy clients (replacement: ${replacesExisting})`, async ({ page }) => {
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const sockets: WebSocket[] = [];
    let peerCloses = 0;
    page.on('websocket', socket => socket.on('close', () => { peerCloses += 1; }));
    function connectConsumer(clientSessionId: string, deviceLabel: string) {
      const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
      sockets.push(socket);
      const state: { attached: boolean; closeCode: number; frames: BridgeMessage[] } = {
        attached: false, closeCode: 0, frames: [],
      };
      socket.on('open', () => socket.send(JSON.stringify({
        type: 'attach', protocol: 1, clientSessionId, clientInfo: { platform: 'node', deviceLabel },
      })));
      socket.on('close', code => { state.closeCode = code; });
      socket.on('message', raw => {
        const frame: unknown = JSON.parse(raw.toString());
        const isKnownFrame = isBridgeMessage(frame);
        if (isKnownFrame) {
          state.frames.push(frame);
          const isAcknowledgment = frame.type === 'attach-ack';
          if (isAcknowledgment) state.attached = true;
        }
      });
      return { socket, state };
    }
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      const labelCharacters = replacesExisting ? 1.5 * 1024 * 1024 : 3 * 1024 * 1024;
      const label = 'é'.repeat(labelCharacters);
      const first = connectConsumer('presence-first', label);
      await expect.poll(() => first.state.attached).toBe(true);
      if (replacesExisting) {
        const companion = connectConsumer('presence-companion', label);
        await expect.poll(() => companion.state.attached).toBe(true);
      }
      first.socket.send(JSON.stringify({ type: 'worker-sub', subId: 'keep-listening', sub: {
        target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' },
      } }));
      await expect.poll(() => first.state.frames.find(frame => frame.type === 'worker-snap')).toMatchObject({ value: { exists: false } });
      const refusedId = replacesExisting ? 'presence-first' : 'presence-refused';
      const refusedLabel = replacesExisting ? 'é'.repeat(5 * 1024 * 1024) : label;
      const refused = connectConsumer(refusedId, refusedLabel);
      await expect.poll(() => refused.state.closeCode).toBe(1008);
      expect(refused.state.attached).toBe(false);
      const small = connectConsumer('presence-small', 'Small healthy consumer');
      await expect.poll(() => small.state.attached).toBe(true);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      for (const client of [first, small]) {
        client.socket.send(JSON.stringify({
          type: 'worker-op', id: 'healthy', op: { method: 'getDoc', path: 'shared/greeting', actAs: { mode: 'admin' } },
        }));
        await expect.poll(() => client.state.frames.find(frame => frame.type === 'worker-res')).toMatchObject({
          id: 'healthy', ok: true, value: { exists: true },
        });
        expect(client.state.closeCode).toBe(0);
      }
      await expect.poll(() => first.state.frames.filter(frame => frame.type === 'worker-snap').at(-1)).toMatchObject({
        value: { exists: true, data: { json: '{"message":"Hello from the other browser"}', valueEncoding: 'pyric/firestore-values/1' } },
      });
      first.socket.send(JSON.stringify({ type: 'worker-unsub', subId: 'keep-listening' }));
      expect(peerCloses).toBe(0);
    } finally {
      for (const socket of sockets) socket.close();
      await page.close().finally(() => fixture.stop());
    }
  });
}
