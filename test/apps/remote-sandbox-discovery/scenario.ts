// A server script finds the running dev server without a hardcoded port.
// Bare PYRIC_SANDBOX=remote finds it through the project's .pyric/serve.json.
// A remote:<url> left in a .env file after the host moved ports is stale: the
// script warns once and uses this project's running host instead. With the
// host stopped and a pointer naming a port whose connects never complete, a
// script still exits promptly once discovery gives up (#1162).
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

  await app.step('a script exits promptly when the pointer names a port that never answers', async () => {
    await host.process.stop();
    const hole = await app.blackholedPort();
    app.writeFile('.pyric/serve.json', JSON.stringify({ port: hole, url: `http://localhost:${hole}`, instanceId: 'blackholed-host' }));
    const stale = `http://127.0.0.1:${await app.freePort()}`;
    const started = performance.now();
    const result = await app.serverScript('stale-exit.mjs', [], { env: { PYRIC_SANDBOX: `remote:${stale}` } });
    const exitMs = performance.now() - started;
    assert.match(result.output, /write refused: .*is stale/);
    assert.ok(exitMs < 5_000, `stale-exit.mjs took ${Math.round(exitMs)} ms to exit:\n${result.output}`);
  });
});
