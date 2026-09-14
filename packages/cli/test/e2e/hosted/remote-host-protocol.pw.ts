import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startHostProtocolProxy } from './host-protocol-proxy.js';

test('a remote consumer refuses an incompatible host acknowledgment', async ({ page }) => {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    for (const protocol of [999, 0, null, undefined, '1', false, [], {}]) {
      const proxy = await startHostProtocolProxy(fixture.info.url, protocol);
      try {
        const outcome = await connectRemoteSandbox({ url: proxy.url }).then(
          remote => { remote.close(); return 'connected'; },
          error => ({ code: error.code, message: error.message }),
        );
        expect(outcome, JSON.stringify(protocol)).toEqual({
          code: 'unavailable', message: 'The remote sandbox uses an unsupported bridge protocol. Expected version 1.',
        });
        await expect(page.locator('#document')).toHaveText('Empty');
      } finally {
        await proxy.stop();
      }
    }
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await page.close();
    await fixture.stop();
  }
});
