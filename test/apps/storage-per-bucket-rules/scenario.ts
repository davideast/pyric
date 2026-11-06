// Each Storage bucket enforces the rules firebase.json deploys to it (#1313,
// ST-H2-2). This project's firebase.json deploys media.rules, which allows
// everything, to media-bucket, and storage.rules, which requires sign-in, to
// the app's default bucket demo-app.appspot.com. Production keeps one release
// per bucket, so an anonymous upload to the default bucket is denied, one to
// media-bucket is allowed, and one to a bucket nothing deploys to is denied,
// as production locks a new bucket. Every plane gets the same three answers:
// the page on the Node host, on the SharedWorker and in-page, a server script
// attached to the Node host, and a PYRIC_SANDBOX=local server script.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, type App, type DevServer } from '../driver.ts';

declare function uploadToEachBucket(path: string): Promise<string[]>;

const EXPECTED = ['default storage/unauthorized', 'media ok', 'undeployed storage/unauthorized'];

async function pageUploads(app: App, host: DevServer, path: string): Promise<string[]> {
  const page: Page = await app.page(host.url);
  await page.waitForFunction(() => 'uploadToEachBucket' in window);
  return page.evaluate((objectPath) => uploadToEachBucket(objectPath), path);
}

function assertServerOutput(output: string): void {
  for (const line of EXPECTED) assert.match(output, new RegExp(`^${line}$`, 'm'), output);
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  await app.step('the page on the Node host gets each bucket its own rules', async () => {
    assert.deepEqual(await pageUploads(app, host, 'hosted/a.txt'), EXPECTED);
  });

  await app.step('a server script attached to the Node host gets each bucket its own rules', async () => {
    const { output } = await app.serverScript('upload.mjs', [], { env: { PYRIC_SANDBOX: `remote:${host.url}` }, timeoutMs: 60_000 });
    assertServerOutput(output);
  });

  const workerHost = await app.step('start a SharedWorker dev server', () =>
    app.devServer({ name: 'shared-worker-dev-server', env: { STORAGE_PER_BUCKET_PLANE: 'shared-worker' } }));

  await app.step('the page on the SharedWorker gets each bucket its own rules', async () => {
    assert.deepEqual(await pageUploads(app, workerHost, 'worker/a.txt'), EXPECTED);
  });

  await app.step('the in-page sandbox gets each bucket its own rules', async () => {
    const context = await app.browser();
    await context.addInitScript(() => {
      (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true;
    });
    assert.deepEqual(await pageUploads(app, workerHost, 'in-page/a.txt'), EXPECTED);
  });

  await app.step('a PYRIC_SANDBOX=local server script gets each bucket its own rules', async () => {
    const { output } = await app.serverScript('upload.mjs', [], { env: { PYRIC_SANDBOX: 'local' }, timeoutMs: 60_000 });
    assertServerOutput(output);
  });
});
