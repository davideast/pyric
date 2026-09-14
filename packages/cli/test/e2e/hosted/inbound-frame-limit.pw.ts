import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { checkInboundFrame, inboundFrameCases } from './inbound-frame-fixture.js';
import { startSoakServe } from '../soak/harness.js';

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} applies the 12 MiB inbound limit to encoded and fragmented messages`, async ({ page }) => {
    test.setTimeout(30_000);
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
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      let expectedMessage = 'Empty';
      for (const size of inboundFrameCases) {
        const message = `${size.bytes} bytes; fragmented ${size.fragmented}`;
        await checkInboundFrame(fixture.info.url, size, message);
        const acceptsWrite = size.acceptsWrite;
        if (acceptsWrite) expectedMessage = message;
        const actual = await page.evaluate(async () => {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          return (await getDoc(doc(getFirestore(), 'shared/greeting'))).data()?.message;
        });
        expect(actual).toBe(expectedMessage);
        await expect(page.locator('#document')).toHaveText(expectedMessage);
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
}
