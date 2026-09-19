import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, test } from '@playwright/test';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';

test('a browser peer can close an oversized handshake without replacing the healthy peer', async ({ page }) => {
  const fixture = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8') + '<script type="module" src="/peer-close-probe.js"></script>',
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    },
    prepare(dir) {
      buildSync({
        entryPoints: [fileURLToPath(new URL('./peer-close-probe.ts', import.meta.url))],
        outfile: join(dir, 'peer-close-probe.js'), bundle: true, platform: 'browser', format: 'esm',
      });
    },
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await waitForPeer(fixture.info.url);
    await page.locator('#reject-peer').click();
    await expect(page.locator('#peer-state')).toHaveText('disconnected');
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' })).resolves.toMatchObject({
      ok: true, data: { exists: true },
    });
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});
