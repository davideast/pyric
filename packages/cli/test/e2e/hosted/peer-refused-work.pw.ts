import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { health, startSoakServe } from '../soak/harness.js';

const peerAcknowledgments = [
  { name: 'compatible', protocol: 1, acceptsWork: true },
  { name: 'incompatible', protocol: 999, acceptsWork: false },
];

for (const acknowledgment of peerAcknowledgments) {
  test(`${acknowledgment.name} peer acknowledgment controls whether buffered commands can mutate`, async ({ page }) => {
    test.setTimeout(30_000);
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    let sentCommand = false;
    try {
      await page.routeWebSocket('**/__pyric/sandbox', route => {
        const server = route.connectToServer();
        server.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const acknowledgesPeer = isBridgeMessage(frame) && frame.type === 'hello-ack';
          if (acknowledgesPeer) {
            route.send(JSON.stringify({ ...frame, protocol: acknowledgment.protocol }));
            route.send(JSON.stringify({ type: 'worker-op', id: 'after-refusal', op: {
              method: 'setDoc', path: 'shared/refused', data: { message: 'Refused command ran' }, actAs: { mode: 'admin' },
            } }));
            sentCommand = true;
            return;
          }
          route.send(data);
        });
      });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect.poll(() => sentCommand).toBe(true);
      await expect.poll(() => health(fixture.info.url)).toMatchObject({ sandboxConnected: acknowledgment.acceptsWork });
      const exists = await page.evaluate(async () => {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        return (await getDoc(doc(getFirestore(), 'shared/refused'))).exists();
      });
      expect(exists).toBe(acknowledgment.acceptsWork);
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
      await page.getByRole('button', { name: 'Write shared document' }).click();
      await expect(page.locator('#write-result')).toHaveText('Written');
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
