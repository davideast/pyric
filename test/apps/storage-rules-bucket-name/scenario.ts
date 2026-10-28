// Storage rules see the app's bucket name, not pyric's internal key
// `pyric-default` (#1345, ST-H2-4). The app's `storageBucket` is
// `demo-app.appspot.com`, and its `storage.rules` matches
// `/b/demo-app.appspot.com/o` and checks `request.resource.bucket` on write
// and `resource.bucket` on read. Production allows both. The page's upload
// under the hosted dev server, an upload from a server script under
// `node --import @pyric/cli/register`, and `pyric rules simulate` against the
// host each see the app's bucket name, and the metadata still reports it.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function uploadAndRead(path: string): Promise<string>;

const BUCKET = 'demo-app.appspot.com';

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  await app.step('the page uploads and reads back under the app bucket name', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'uploadAndRead' in window);
    assert.equal(await page.evaluate(() => uploadAndRead('page/a.txt')), BUCKET);
  });

  await app.step('a registered server script uploads and reads back under the app bucket name', async () => {
    const { output } = await app.serverScript('client.mjs', ['server/a.txt'], { env, timeoutMs: 30_000 });
    assert.match(output, new RegExp(`^bucket ${BUCKET.replaceAll('.', '\\.')}$`, 'm'), output);
  });

  await app.step('pyric rules simulate on the host binds the app bucket name', async () => {
    const result = await app.pyric(
      ['rules', 'simulate', '--service', 'storage', '--operation', 'get', '--path', 'page/a.txt'],
      { env },
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /get page\/a\.txt: ALLOW/, result.output);
  });
});
