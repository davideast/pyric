import { readFileSync } from 'node:fs';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { isBridgeMessage } from '../../../src/bridge/protocol.js';
import { health, startSoakServe, waitForPeer } from '../soak/harness.js';

const incompatibleVersions: unknown[] = [999, 0, undefined, null, '1', false, [], {}];

for (const protocol of incompatibleVersions) {
  test(`peer refuses protocol ${JSON.stringify(protocol)} while SharedWorker SDK access remains usable`, async ({ browser }) => {
    test.setTimeout(30_000);
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const context = await browser.newContext();
    const traffic: string[] = [];
    try {
      const broken = await context.newPage();
      broken.on('pageerror', error => traffic.push(`page error: ${error.message}`));
      await broken.clock.install();
      const closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
      let attempts = 0;
      await broken.routeWebSocket('**/__pyric/sandbox', route => {
        attempts += 1;
        traffic.push('connection');
        const server = route.connectToServer();
        route.onMessage(data => {
          server.send(data);
        });
        route.onClose((code, reason) => {
          traffic.push(`close: ${code}`);
          closes.push({ code, reason });
          const isFirstClose = closes.length === 1;
          if (isFirstClose) server.close();
        });
        server.onMessage(data => {
          const frame: unknown = JSON.parse(data.toString());
          const acknowledgesPeer = isBridgeMessage(frame) && frame.type === 'hello-ack';
          if (acknowledgesPeer) {
            traffic.push('replaced hello-ack protocol');
            route.send(JSON.stringify({ ...frame, protocol }));
            return;
          }
          route.send(data);
        });
      });
      await broken.goto(fixture.info.url);
      await expect(broken.locator('#document')).toHaveText('Empty');
      await expect.poll(() => closes[0]).toEqual({
        code: 1000, reason: 'Unsupported bridge protocol. Expected version 1.',
      });
      await expect.poll(() => health(fixture.info.url)).toMatchObject({ sandboxConnected: false });
      await expect.poll(() => broken.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
      await broken.getByRole('button', { name: 'Write shared document' }).click();
      await expect(broken.locator('#write-result')).toHaveText('Written');
      const healthy = await context.newPage();
      await healthy.goto(fixture.info.url);
      await expect(healthy.locator('#document')).toHaveText('Hello from the other browser');
      await waitForPeer(fixture.info.url);
      await broken.clock.fastForward(10_000);
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await control.channel.op({ method: 'setDoc', path: 'shared/greeting',
          data: { message: 'Valid peer remains connected' }, actAs: { mode: 'admin' } });
        for (const page of [broken, healthy]) {
          await expect(page.locator('#document')).toHaveText('Valid peer remains connected');
        }
      } finally {
        control.close();
      }
      expect(attempts).toBe(1);
    } finally {
      await test.info().attach('peer-traffic', { body: traffic.join('\n'), contentType: 'text/plain' });
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await context.close();
      await fixture.stop();
    }
  });
}
