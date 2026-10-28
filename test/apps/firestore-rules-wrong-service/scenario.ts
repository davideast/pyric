// A Storage ruleset is not Firestore rules (#1328, FS2-ENF-2). Production
// won't deploy a `service firebase.storage` ruleset to Firestore, so no
// pyric plane loads one either. The page's in-page sandbox, given a Storage
// allow-all ruleset through `setRules`, denies its read and write of c/1 and
// names the service in its rules status. A project whose `firestore.rules`
// is a Storage ruleset makes `pyric sandbox` refuse it at load, with the
// same reason, before it runs the app's command.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { scenario } from '../driver.ts';

declare const wrongService: { run(): Promise<{ read: string; write: string; status: string[] }> };

const REASON = "Firestore rules did not compile: Expected 'service cloud.firestore', got 'service firebase.storage'.";

export default scenario(async (app) => {
  const host = await app.step('start the dev server', () => app.devServer());

  await app.step('the in-page sandbox denies c/1 under a Storage ruleset and names the service', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'wrongService' in window, undefined, { timeout: 30_000 });
    const result = await page.evaluate(() => wrongService.run());
    // Refused as an unloadable ruleset is: the request fails with the reason.
    for (const outcome of [result.read, result.write]) {
      assert.notEqual(outcome, 'ok');
      assert.ok(outcome.includes(REASON), outcome);
    }
    assert.deepEqual(result.status, [REASON]);
  });

  await app.step('pyric sandbox refuses a project whose firestore.rules is a Storage ruleset', async () => {
    const port = await app.freePort();
    const cli = join('..', 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');
    const result = await app.command(
      'node',
      [cli, 'sandbox', '--no-open', '--port', String(port), '--', 'node', '-e', 'console.log("app command ran")'],
      { cwd: 'wrong-service', timeoutMs: 90_000 },
    );
    assert.notEqual(result.code, 0, result.output);
    assert.ok(result.output.includes(REASON), result.output);
    assert.doesNotMatch(result.output, /app command ran/);
  });
});
