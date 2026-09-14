import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

test('a busy relayed client does not consume another client’s capacity on the same worker port', async ({ page }) => {
  const fixture = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8') + '<script type="module" src="/pending-relay-probe.js"></script>',
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    },
    prepare(dir) {
      for (const entry of ['pending-relay-probe', 'pending-relay-worker']) {
        buildSync({
          entryPoints: [fileURLToPath(new URL(`./${entry}.ts`, import.meta.url))],
          outfile: join(dir, `${entry}.js`), bundle: true, platform: 'browser', format: 'iife',
        });
      }
    },
  });
  try {
    await page.goto(fixture.info.url);
    const result = page.locator('#relay-capacity-result');
    await expect(result).not.toBeEmpty();
    expect(JSON.parse(await result.innerText())).toEqual({
      excess: 'resource-exhausted', healthy: 'completed', completed: Array(256).fill('completed'), next: 'completed',
    });
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});
