import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} refuses unsupported target discriminators across reads and subscriptions`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
    let attached = false;
    let response: unknown;
    socket.on('message', data => {
      const frame: unknown = JSON.parse(data.toString());
      const isKnownFrame = isBridgeMessage(frame);
      if (isKnownFrame) {
        const isAcknowledgment = frame.type === 'attach-ack';
        if (isAcknowledgment) attached = true;
        const isResponse = frame.type === 'worker-res' && frame.id === 'target-probe';
        const isSnapshot = frame.type === 'worker-snap' && frame.subId === 'target-probe';
        const isCorrelated = isResponse || isSnapshot;
        if (isCorrelated) response = frame;
      }
    });
    async function request(frame: unknown) {
      response = undefined;
      socket.send(JSON.stringify(frame));
      await expect.poll(() => response).toBeDefined();
      return response;
    }
    try {
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      await waitForPeer(fixture.info.url);
      await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
      socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
      await expect.poll(() => attached).toBe(true);
      const refusal = { code: 'invalid-argument', message: 'Unsupported Firestore target descriptor.' };
      for (const discriminator of ['unknown', undefined, null, 7, false, [], {}]) {
        const invalidTarget = {
          __ref: discriminator, source: { __ref: 'collection', path: 'shared' }, constraints: [],
        };
        const targets = [invalidTarget, { __ref: 'query', source: invalidTarget, constraints: [] }];
        for (const target of targets) {
          for (const method of ['getDocs', 'count', 'aggregate']) {
            const result = await request({
              type: 'worker-op', id: 'target-probe',
              op: { method, source: target, spec: { count: { kind: 'count' } }, actAs: { mode: 'admin' } },
            });
            expect(result).toMatchObject({ type: 'worker-res', id: 'target-probe', ok: false, error: refusal });
          }
          const result = await request({
            type: 'worker-sub', subId: 'target-probe', sub: { target, actAs: { mode: 'admin' } },
          });
          expect(result).toMatchObject({ type: 'worker-snap', subId: 'target-probe', value: { __error: refusal } });
          socket.send(JSON.stringify({ type: 'worker-unsub', subId: 'target-probe' }));
          expect(socket.readyState).toBe(WebSocket.OPEN);
        }
      }
      const validQuery = await request({
        type: 'worker-op', id: 'target-probe',
        op: {
          method: 'getDocs', actAs: { mode: 'admin' },
          source: { __ref: 'query', source: { __ref: 'collection', path: 'shared' }, constraints: [] },
        },
      });
      expect(validQuery).toMatchObject({ ok: true, value: { docs: [{ path: 'shared/greeting' }] } });
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Healthy after refusal' });
      });
      await expect(page.locator('#document')).toHaveText('Healthy after refusal');
    } finally {
      socket.close();
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
