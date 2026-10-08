// A server script finds the running dev server without a hardcoded port.
// Bare PYRIC_SANDBOX=remote finds it through the project's .pyric/serve.json.
// A remote:<url> left in a .env file after the host moved ports is stale: the
// script warns once and uses this project's running host instead.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function readStatus(): Promise<unknown>;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const page = await app.step('open the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'readStatus' in window);
    return page;
  });

  await app.step('PYRIC_SANDBOX=remote finds the running host', async () => {
    await app.serverScript('server.mjs', ['found by discovery'], { env: { PYRIC_SANDBOX: 'remote' } });
    assert.equal(await page.evaluate(() => readStatus()), 'found by discovery');
  });

  await app.step('a stale PYRIC_SANDBOX=remote:<url> falls back to the running host', async () => {
    const stale = `http://127.0.0.1:${await app.freePort()}`;
    const result = await app.serverScript('server.mjs', ['found after a stale url'], { env: { PYRIC_SANDBOX: `remote:${stale}` } });
    assert.match(result.output, new RegExp(`PYRIC_SANDBOX=remote:${stale.replaceAll('.', '\\.')} is stale`));
    assert.equal(await page.evaluate(() => readStatus()), 'found after a stale url');
  });
});
