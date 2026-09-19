import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';
import { checkInboundFrame, inboundFrameCases } from './inbound-frame-fixture.js';

test('Vite applies the encoded frame boundary without interrupting its SharedWorker app', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-vite-frame-')));
  let server: ViteDevServer | undefined;
  try {
    for (const file of ['index.html', 'main.js']) {
      writeFileSync(join(root, file), readFileSync(new URL(`./fixture/${file}`, import.meta.url)));
    }
    writeFileSync(join(root, 'firestore.rules'), readFileSync(new URL('../soak/fixture/firestore.rules', import.meta.url)));
    server = await createServer({
      root, configFile: false, cacheDir: join(root, '.vite'), logLevel: 'silent',
      plugins: [pyric({ bridge: true, capture: false, ui: false })],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    const hasNoUrl = url === undefined;
    if (hasNoUrl) throw new Error('Vite did not expose a listening URL.');
    await page.goto(url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
    let expectedMessage = 'Empty';
    for (const size of inboundFrameCases) {
      const message = `${size.bytes} bytes; fragmented ${size.fragmented}`;
      await checkInboundFrame(url.replace(/\/$/, ''), size, message);
      const acceptsWrite = size.acceptsWrite;
      if (acceptsWrite) expectedMessage = message;
      await expect(page.locator('#document')).toHaveText(expectedMessage);
    }
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    try {
      await page.close();
    } finally {
      try {
        await server?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
