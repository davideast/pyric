import assert from 'node:assert/strict';
import { scenario, type ExpectedCrash } from '../driver.ts';

export const expectedCrashes: ExpectedCrash[] = [
  {
    message: /^Error: WebSocket closed without opened\.$/,
    source: /^page http:\/\/127\.0\.0\.1:\d+\/ \(at http:\/\/127\.0\.0\.1:\d+\/@vite\/client:\d+\)$/,
    reason: "vite.config.js points Vite's HMR client at port 1 so it never reloads the page, and the client rejects when that socket fails",
  },
];

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
