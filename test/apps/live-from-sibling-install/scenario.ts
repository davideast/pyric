/**
 * Live mode with pyric installed in a package beside the app (#2113). The
 * web app in `web/` gets `vite` and `firebase` from the repository root's
 * install, as an npm workspace's hoisted install gives them; `pyric`,
 * `@pyric/cli` and `@pyric/live` are in `rules/`, beside `web/`, which the
 * app's own resolution never reaches. The app's Vite config loads
 * `pyricLive()` from `rules/` with createRequire. The dev server starts in
 * live mode, and the page's `firebase/app`, `firebase/auth` and
 * `firebase/firestore` load through the live rows, whose files the page
 * loads by `/@fs` from the `@pyric/live` in `rules/`, outside the Vite root.
 *
 * The page makes no call, so nothing goes to production. Like every app
 * scenario this runs offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, sleep } from '../driver.ts';

const PROJECT = 'demo-live-sibling';

/** The path of a page request, decoded, for one Vite serves by `/@fs`. */
function fsPathOf(url: string): string | null {
  const { pathname } = new URL(url);
  return pathname.startsWith('/@fs/') ? decodeURIComponent(pathname.slice('/@fs'.length)) : null;
}

/** Waits until the dev server answers `/__pyric/init.json`. */
async function servesInit(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ok = await fetch(`${url}/__pyric/init.json`).then((response) => response.ok, () => false);
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`${url}/__pyric/init.json did not answer within 60s`);
    await sleep(250);
  }
}

export default scenario(async (app) => {
  const liveDir = await app.step('install pyric, @pyric/cli and @pyric/live in rules/, beside the app', async () => {
    await app.installProject('rules');
    assert.equal(existsSync(join(app.dir, 'node_modules', '@pyric', 'live')), false, 'the repository root has no @pyric/live');
    assert.equal(existsSync(join(app.dir, 'web', 'node_modules')), false, 'the web app has no install of its own');
    return realpathSync(join(app.dir, 'rules', 'node_modules', '@pyric', 'live'));
  });

  const host = await app.step('vite dev on web/ starts with pyricLive() loaded from rules/', async () => {
    const port = await app.freePort();
    const url = `http://127.0.0.1:${port}`;
    const vite = app.commandProcess('node', ['node_modules/vite/bin/vite.js', 'web', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
    await vite.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    await servesInit(url);
    return { url };
  });

  await app.step('the page loads firebase/app, firebase/auth and firebase/firestore through the live rows from rules/', async () => {
    const requested: string[] = [];
    (await app.browser()).on('request', (request) => requested.push(request.url()));
    const page = await app.page(`${host.url}/`);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready', undefined, { timeout: 30_000 });
    const fromLive = requested.map(fsPathOf).filter((path): path is string => path !== null && path.startsWith(`${liveDir}/`));
    assert.ok(fromLive.some((path) => path.endsWith('/rows.js')), `the page loaded no live row file from ${liveDir}:\n${requested.join('\n')}`);
    const chip = page.locator('[data-pyric-runtime-chip-host]');
    await chip.waitFor({ state: 'attached', timeout: 30_000 });
    const header = chip.locator('.panel-header [data-chip-live]');
    if (await header.count() === 0) await chip.locator('[data-expand]').click();
    assert.equal(await header.textContent(), `Live: ${PROJECT}`);
    await page.close();
  });

  await app.step('nothing reached any host but loopback', () => {
    assert.deepEqual(app.browserLog.filter((line) => line.includes('[blocked external')), []);
  });
});
