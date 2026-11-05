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
 * The app's server process, `web/server.mjs`, runs from `web/`, below the
 * project folder that holds `.firebaserc` and `firebase.json`, under the
 * register from `rules/`. The register walks up from `web/` to that folder
 * for its project (#2134): `node --import` with the file
 * `rules/node_modules/@pyric/live/register` resolves to (#2116). Its `firebase/firestore` is the live row, and its
 * `firebase/database` is the app's installed SDK, passed through because the
 * dev server's `pyricLive({ passThrough })` lists it and the process reads
 * that list from the dev server's health report (#2122).
 *
 * Neither the page nor the server makes a call, so nothing goes to production. Like every app
 * scenario this runs offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scenario, sleep } from '../driver.ts';

const PROJECT = 'demo-live-sibling';
const PASSED = 'firebase/database passes through to production: its calls are not observed and still bill.';

function resultOf(output: string): { firestore: string; database: string; resolved: Record<string, string> } {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length));
}

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

  await app.step('the health report lists firebase/database as passed through', async () => {
    const health = await (await fetch(`${host.url}/__pyric/health`)).json() as { live?: { passThrough?: string[] } };
    assert.deepEqual(health.live?.passThrough, ['firebase/database']);
  });

  await app.step('a server started from web/ under the register from rules/ loads its live rows and passes firebase/database through', async () => {
    const register = pathToFileURL(createRequire(join(app.dir, 'rules', 'package.json')).resolve('@pyric/live/register')).href;
    assert.ok(register.startsWith(pathToFileURL(`${liveDir}/`).href), `the register entry is the one in rules/: ${register}`);
    // From web/, below the folder that holds firebase.json and .firebaserc: the register walks up to it (#2134).
    const run = await app.command('node', ['--import', register, 'server.mjs'], { cwd: 'web', timeoutMs: 60_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.ok(run.output.includes(`@pyric/live/register: ${PASSED}`), run.output);
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    const result = resultOf(run.output);
    assert.equal(result.firestore, 'rooms/lobby');
    assert.equal(result.database, 'https://demo-live-sibling-default-rtdb.firebaseio.com/rooms/lobby');
    assert.match(result.resolved['firebase/firestore']!, /\/live-rows\/firebase\/firestore\.js$/, 'firebase/firestore is the live row');
    const installedSdk = pathToFileURL(`${realpathSync(join(app.dir, 'node_modules', 'firebase'))}/`).href;
    assert.ok(result.resolved['firebase/database']!.startsWith(installedSdk), `firebase/database is the app's installed SDK: ${result.resolved['firebase/database']}`);
  });

  await app.step('nothing reached any host but loopback', () => {
    assert.deepEqual(app.browserLog.filter((line) => line.includes('[blocked external')), []);
  });
});
