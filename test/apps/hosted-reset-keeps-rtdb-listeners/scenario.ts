import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  await app.step('deploy permissive rtdb rules', async () => {
    await app.serverScript('./node_modules/.bin/pyric', ['rules', 'set', '--service', 'database', '--rules', JSON.stringify({ rules: { ".read": true, ".write": true } })], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
  });

  const page = await app.step('open the page and attach a live listener', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'counters' in window, undefined, { timeout: 30_000 });
    await page.evaluate(() => counters.write());
    await page.evaluate(() => counters.listen());
    return page;
  });

  await app.step('reset sandbox', async () => {
    await app.serverScript('./node_modules/.bin/pyric', ['sandbox', 'reset', '--confirm'], { env: { PYRIC_SANDBOX: `remote:${host.url}` } });
  });

  await app.step('listener should not have been cancelled with PERMISSION_DENIED', async () => {
    const cancels = await page.evaluate(() => counters.cancels());
    assert.deepEqual(cancels, []);
  });
});
