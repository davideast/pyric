// An app's own vite-plugin-pwa injectManifest service worker, with no Pyric
// import, answers production Storage URLs from the sandbox in dev because the
// Pyric Vite plugin is given `serviceWorker: "src/sw.js"`. The page renders
// <img src> with a production download URL and gets the sandbox bytes; an
// unrelated cross-origin URL passes through. `vite build` emits a service
// worker with no Pyric code in it.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

declare function uploadAndBuildProductionUrl(): Promise<string>;
declare function renderImage(url: string): Promise<{ loaded: boolean; width: number }>;
declare function download(url: string): Promise<{ status: number; bytes: number }>;
declare function downloadText(url: string): Promise<{ status: number; text: string }>;

const UNRELATED_URL = 'https://unrelated.example/hello.txt';
const PNG_BYTES = 70;

const INSPECT_DIST = `
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const files = readdirSync('dist', { recursive: true }).filter((file) => /\\.(js|html)$/.test(file));
const pyricFiles = files.filter((file) => /pyric|sandboxStorageFetch/i.test(readFileSync('dist/' + file, 'utf8')));
console.log(JSON.stringify({ serviceWorker: existsSync('dist/sw.js'), pyricFiles }));
`;

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());

  const network = { production: 0, unrelated: 0 };
  await app.step('the network answers only the unrelated origin', async () => {
    const context = await app.browser();
    await context.route('https://firebasestorage.googleapis.com/**', (route) => {
      network.production += 1;
      return route.fulfill({ status: 599, body: 'production was reached' });
    });
    await context.route(`${UNRELATED_URL}*`, (route) => {
      network.unrelated += 1;
      return route.fulfill({ status: 200, body: 'from the network', headers: { 'access-control-allow-origin': '*' } });
    });
  });

  const page = await app.step('the page opens', async () => {
    const opened = await app.page(host.url);
    await opened.waitForFunction(() => 'uploadAndBuildProductionUrl' in window);
    return opened;
  });

  const productionUrl = await app.step('the service worker controls the page and the page uploads an image', () =>
    page.evaluate(() => uploadAndBuildProductionUrl()));

  await app.step('<img src> with the production download URL shows the sandbox bytes', async () => {
    assert.deepEqual(await page.evaluate((url) => renderImage(url), productionUrl), { loaded: true, width: 1 });
    assert.deepEqual(await page.evaluate((url) => download(url), productionUrl), { status: 200, bytes: PNG_BYTES });
    assert.equal(network.production, 0);
  });

  await app.step('an unrelated cross-origin URL reaches the network untouched', async () => {
    assert.deepEqual(await page.evaluate((url) => downloadText(url), UNRELATED_URL), { status: 200, text: 'from the network' });
    assert.equal(network.unrelated, 1);
  });

  await app.step('vite build emits the service worker with no Pyric code', async () => {
    const build = await app.command('node', ['node_modules/vite/bin/vite.js', 'build'], { timeoutMs: 120_000 });
    assert.equal(build.code, 0, build.output);
    const inspect = await app.command('node', ['-e', INSPECT_DIST]);
    assert.equal(inspect.code, 0, inspect.output);
    const report = JSON.parse(inspect.output.trim().split('\n').at(-1) ?? '{}') as { serviceWorker: boolean; pyricFiles: string[] };
    assert.deepEqual(report, { serviceWorker: true, pyricFiles: [] });
  });
});
