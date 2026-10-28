// With `functions: false`, the plugin still takes its Firebase project from
// PYRIC_PROJECT, here the .firebaserc alias "staging", without an edit to
// .firebaserc. The deploy target resolves at startup.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function tryWrite(path: string): Promise<string>;

export default scenario(async (app) => {
  const host = await app.step('start the dev server with PYRIC_PROJECT=staging', () =>
    app.devServer({ env: { PYRIC_PROJECT: 'staging' } }));

  await app.step('the deploy target resolves at startup', () => {
    assert.doesNotMatch(host.process.output, /is unresolved|not configured|no Firebase project/i);
  });

  await app.step("the target's rules apply to my-app-staging-main", async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'tryWrite' in window);
    assert.equal(await page.evaluate(() => tryWrite('public/a')), 'allowed');
    assert.match(await page.evaluate(() => tryWrite('private/a')), /^denied: PERMISSION_DENIED/);
  });
});
