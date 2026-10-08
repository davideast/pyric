// firebase.json names its RTDB rules by deploy target, and nothing selects a
// project: .firebaserc has two aliases and no default, and `firebase use` was
// never run. The dev server starts, says the target is unresolved, and applies
// the target's rules once the page's app config names a project.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function tryWrite(path: string): Promise<string>;

export default scenario(async (app) => {
  const host = await app.step('start the dev server with no Firebase project set', () => app.devServer());

  await app.step('the dev server reports the unresolved deploy target', async () => {
    await host.process.waitForLog(/RTDB deploy target "main".*is unresolved/, { timeoutMs: 10_000 });
  });

  await app.step("the target's rules apply to the instance the page's project maps it to", async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'tryWrite' in window);
    assert.equal(await page.evaluate(() => tryWrite('public/a')), 'allowed');
    assert.match(await page.evaluate(() => tryWrite('private/a')), /^denied: PERMISSION_DENIED/);
  });
});
