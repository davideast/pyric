// Each Storage bucket enforces the rules firebase.json deploys to it (#1313,
// ST-H2-2). This project's firebase.json deploys media.rules, which allows
// everything, to media-bucket, and storage.rules, which requires sign-in, to
// the app's default bucket demo-app.appspot.com. Production keeps one release
// per bucket, so an anonymous upload to the default bucket is denied, one to
// media-bucket is allowed, and one to a bucket nothing deploys to is denied,
// as production locks a new bucket. Every plane gets the same three answers:
// the page on the Node host, on the SharedWorker and in-page, a server script
// attached to the Node host, and a PYRIC_SANDBOX=local server script. On the
// Node host, `pyric rules set --service storage` is refused until a page has
// told the host the default bucket's name; after that it replaces the rules
// the default bucket enforces, and the page's next upload obeys them. Under
// `pyric sandbox --hosted --permissive`, a bucket nothing deploys to is open,
// as an RTDB instance without rules is, and deployed rules still decide.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, sleep, type App, type DevServer } from '../driver.ts';

declare function uploadToEachBucket(path: string): Promise<string[]>;

const EXPECTED = ['default storage/unauthorized', 'media ok', 'undeployed storage/unauthorized'];
const AFTER_RULES_SET = ['default ok', 'media ok', 'undeployed storage/unauthorized'];
// Permissive mode opens only a bucket nothing deploys rules to; the default
// bucket's storage.rules still deny an anonymous upload.
const PERMISSIVE = ['default storage/unauthorized', 'media ok', 'undeployed ok'];

/** True once `url` answers with a 2xx status. */
async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

type Plane = 'hosted' | 'shared-worker' | 'in-page';

/** The runtime status the served page publishes on `globalThis`. */
type RuntimeGlobal = { __pyricRuntime?: { getSnapshot(): { mode: string } } };

/** The plane the page's runtime reports it runs on, once it has started. */
async function runtimeMode(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const current = (globalThis as RuntimeGlobal).__pyricRuntime?.getSnapshot().mode;
    return current !== undefined && current !== 'starting';
  });
  return page.evaluate(() => (globalThis as RuntimeGlobal).__pyricRuntime?.getSnapshot().mode ?? 'none');
}

/** Upload from a new page, after checking it runs on `plane`. */
async function pageUploads(app: App, host: DevServer, plane: Plane, path: string): Promise<string[]> {
  const page: Page = await app.page(host.url);
  await page.waitForFunction(() => 'uploadToEachBucket' in window);
  assert.equal(await runtimeMode(page), plane);
  return page.evaluate((objectPath) => uploadToEachBucket(objectPath), path);
}

function assertServerOutput(output: string): void {
  for (const line of EXPECTED) assert.match(output, new RegExp(`^${line}$`, 'm'), output);
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const attached = { PYRIC_SANDBOX: `remote:${host.url}` };

  await app.step('pyric rules set for Storage is refused before a page names the default bucket', async () => {
    const result = await app.pyric(['rules', 'set', '--service', 'storage', '--rules-file', 'media.rules'], { env: attached });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /"code": "default-bucket-name-unknown"/, result.output);
  });

  await app.step('the page on the Node host gets each bucket its own rules', async () => {
    assert.deepEqual(await pageUploads(app, host, 'hosted', 'hosted/a.txt'), EXPECTED);
  });

  await app.step('a server script attached to the Node host gets each bucket its own rules', async () => {
    const { output } = await app.serverScript('upload.mjs', [], { env: attached, timeoutMs: 60_000 });
    assertServerOutput(output);
  });

  await app.step('pyric rules set replaces the default bucket\'s rules on the Node host, and an upload obeys them', async () => {
    // media.rules allows everything; it now governs the default bucket too.
    const result = await app.pyric(['rules', 'set', '--service', 'storage', '--rules-file', 'media.rules'], { env: attached });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await pageUploads(app, host, 'hosted', 'hosted/b.txt'), AFTER_RULES_SET);
  });

  const workerHost = await app.step('start a SharedWorker dev server', () =>
    app.devServer({ name: 'shared-worker-dev-server', env: { STORAGE_PER_BUCKET_PLANE: 'shared-worker' } }));

  await app.step('the page on the SharedWorker gets each bucket its own rules', async () => {
    assert.deepEqual(await pageUploads(app, workerHost, 'shared-worker', 'worker/a.txt'), EXPECTED);
  });

  await app.step('the in-page sandbox gets each bucket its own rules', async () => {
    const context = await app.browser();
    await context.addInitScript(() => {
      (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ = true;
    });
    assert.deepEqual(await pageUploads(app, workerHost, 'in-page', 'in-page/a.txt'), EXPECTED);
  });

  await app.step('a PYRIC_SANDBOX=local server script gets each bucket its own rules', async () => {
    const { output } = await app.serverScript('upload.mjs', [], { env: { PYRIC_SANDBOX: 'local' }, timeoutMs: 60_000 });
    assertServerOutput(output);
  });

  const permissiveHost = await app.step('start pyric sandbox --hosted --permissive', async () => {
    // One hosted sandbox owns a project's hosted state at a time.
    await host.process.stop();
    const port = await app.freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = app.pyricProcess(['sandbox', '--hosted', '--permissive', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    const deadline = Date.now() + 90_000;
    while (!(await answers(`${url}/__pyric/init.json`))) {
      if (!child.running) throw new Error(`pyric sandbox exited (code ${await child.exited}):\n${child.output}`);
      if (Date.now() > deadline) throw new Error(`pyric sandbox did not serve ${url}/__pyric/init.json within 90s`);
      await sleep(250);
    }
    return { url, port, process: child };
  });

  await app.step('in permissive mode a bucket with no rules deployed is open and deployed rules still decide', async () => {
    assert.deepEqual(await pageUploads(app, permissiveHost, 'hosted', 'permissive/a.txt'), PERMISSIVE);
  });
});
