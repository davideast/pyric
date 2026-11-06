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
 * `firebase/database` and `firebase/functions` are the app's installed SDK,
 * passed through because the dev server's `pyricLive({ passThrough })` lists
 * them and the process reads that list from the dev server's health report
 * (#2122). The page gets both on its app too, and the dev server's start
 * line, its health report and the chip name each one as passed through.
 *
 * Then `pyric-live`, the command from `rules/`, starts from `web/` too. It
 * walks up to the same project folder (#2148) and opens with its own
 * `@pyric/live`, which `web/` and the project folder never resolve.
 *
 * Then `firebase` moves from the repository root's install into
 * `web/node_modules`, as a workspace that installs it only for the app lays
 * it out (#2161). The project folder's own resolution no longer reaches
 * `firebase`, so the start checks and the live rows read it from the folder
 * the app runs in first: `pyric-live` and the server each start from `web/`
 * again, the server against a dev server started again for its
 * pass-through list. Then the server starts from the repository root as
 * `web/server.mjs`, whose own folder resolves `firebase` while the working
 * directory does not: the register reads it from the entry script's folder,
 * as Node loads it for the app (#2166).
 *
 * Neither the page nor the server makes a call, so nothing goes to production. Like every app
 * scenario this runs offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scenario, sleep, type App } from '../driver.ts';

const PROJECT = 'demo-live-sibling';
const PASSED = ['firebase/database', 'firebase/functions'];

function passThroughLine(specifier: string): string {
  return `${specifier} passes through to production: its calls are not observed and still bill.`;
}

interface ServerResult {
  firestore: string;
  database: string;
  functionsSharesApp: boolean;
  resolved: Record<string, string>;
}

function resultOf(output: string): ServerResult {
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

/** Starts `vite dev` on web/ with `pyricLive()` from rules/, and waits until it serves. */
async function startViteDev(app: App) {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const vite = app.commandProcess('node', ['node_modules/vite/bin/vite.js', 'web', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
  await vite.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
  await servesInit(url);
  for (const specifier of PASSED) {
    assert.ok(vite.output.includes(`@pyric/live/vite: ${passThroughLine(specifier)}`), vite.output);
  }
  return { url, vite };
}

/** Starts `pyric-live` from web/ with the command from rules/, checks its start line and health report, and stops it. */
async function pyricLiveStartsFromWeb(app: App): Promise<void> {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const live = app.commandProcess('node', ['../rules/node_modules/.bin/pyric-live', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: 'web' });
  await live.waitForLog(new RegExp(`pyric-live: live mode for the Firebase project ${PROJECT}\\.`));
  await servesInit(url);
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { live?: { configProjectId?: string; configSource?: string } };
  assert.equal(health.live?.configProjectId, PROJECT);
  assert.equal(health.live?.configSource, '.firebaserc');
  await live.stop();
}

/** Checks the server's start lines and result: Firestore is the live row, and each passed-through import is the SDK in `sdkDir`. */
function serverPassesThrough(output: string, sdkDir: string): void {
  for (const specifier of PASSED) {
    assert.ok(output.includes(`@pyric/live/register: ${passThroughLine(specifier)}`), output);
  }
  const result = resultOf(output);
  assert.equal(result.firestore, 'rooms/lobby');
  assert.equal(result.database, 'https://demo-live-sibling-default-rtdb.firebaseio.com/rooms/lobby');
  assert.equal(result.functionsSharesApp, true);
  assert.match(result.resolved['firebase/firestore']!, /\/live-rows\/firebase\/firestore\.js$/, 'firebase/firestore is the live row');
  const sdk = pathToFileURL(`${realpathSync(sdkDir)}/`).href;
  for (const specifier of PASSED) {
    assert.ok(result.resolved[specifier]!.startsWith(sdk), `${specifier} is the SDK in ${sdkDir}: ${result.resolved[specifier]}`);
  }
}

/**
 * Runs `web/server.mjs` under the register from rules/, from `cwd` with the
 * entry `entry`, with firebase installed only in web/, and checks its start
 * lines and that its firebase imports load from web/node_modules.
 */
async function serverLoadsFromWeb(app: App, devUrl: string, cwd: string | undefined, entry: string): Promise<void> {
  const register = pathToFileURL(createRequire(join(app.dir, 'rules', 'package.json')).resolve('@pyric/live/register')).href;
  const run = await app.command('node', ['--import', register, entry], { cwd, timeoutMs: 60_000 });
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
  assert.ok(run.output.includes(`@pyric/live/register: reporting calls to the live host at ${devUrl}.`), run.output);
  serverPassesThrough(run.output, join(app.dir, 'web', 'node_modules', 'firebase'));
}

export default scenario(async (app) => {
  const liveDir = await app.step('install pyric, @pyric/cli and @pyric/live in rules/, beside the app', async () => {
    await app.installProject('rules');
    assert.equal(existsSync(join(app.dir, 'node_modules', '@pyric', 'live')), false, 'the repository root has no @pyric/live');
    assert.equal(existsSync(join(app.dir, 'web', 'node_modules')), false, 'the web app has no install of its own');
    return realpathSync(join(app.dir, 'rules', 'node_modules', '@pyric', 'live'));
  });

  const host = await app.step('vite dev on web/ starts with pyricLive() loaded from rules/', () => startViteDev(app));

  await app.step('the page loads firebase/app, firebase/auth and firebase/firestore through the live rows from rules/, and firebase/database and firebase/functions pass through', async () => {
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
    const passThroughLines = chip.locator('.panel-header [data-chip-live-pass-through]');
    await passThroughLines.nth(PASSED.length - 1).waitFor({ timeout: 20_000 });
    assert.deepEqual(await passThroughLines.allTextContents(), PASSED.map(passThroughLine));
    await page.close();
  });

  await app.step('the health report lists firebase/database and firebase/functions as passed through', async () => {
    const health = await (await fetch(`${host.url}/__pyric/health`)).json() as { live?: { passThrough?: string[] } };
    assert.deepEqual(health.live?.passThrough, PASSED);
  });

  await app.step('a server started from web/ under the register from rules/ loads its live rows and passes firebase/database and firebase/functions through', async () => {
    const register = pathToFileURL(createRequire(join(app.dir, 'rules', 'package.json')).resolve('@pyric/live/register')).href;
    assert.ok(register.startsWith(pathToFileURL(`${liveDir}/`).href), `the register entry is the one in rules/: ${register}`);
    // From web/, below the folder that holds firebase.json and .firebaserc: the register walks up to it (#2134).
    const run = await app.command('node', ['--import', register, 'server.mjs'], { cwd: 'web', timeoutMs: 60_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    serverPassesThrough(run.output, join(app.dir, 'node_modules', 'firebase'));
  });

  await app.step('pyric-live started from web/ with the command from rules/ finds the project in the folder above', async () => {
    // One hosted host per project: the dev server stops first, as a developer switching hosts stops it.
    await host.vite.stop();
    // From web/, below the folder that holds firebase.json and .firebaserc: pyric-live walks up to it (#2148).
    await pyricLiveStartsFromWeb(app);
  });

  await app.step('with firebase installed only in web/, pyric-live started from web/ passes its start checks', async () => {
    const webModules = join(app.dir, 'web', 'node_modules');
    // Vite's dependency cache already made web/node_modules.
    mkdirSync(webModules, { recursive: true });
    for (const name of ['firebase', '@firebase']) renameSync(join(app.dir, 'node_modules', name), join(webModules, name));
    assert.equal(existsSync(join(app.dir, 'node_modules', 'firebase')), false, 'the repository root has no firebase');
    await pyricLiveStartsFromWeb(app);
  });

  const dev = await app.step('with firebase installed only in web/, the server from web/ loads its live rows and passes firebase/database and firebase/functions through', async () => {
    // The dev server again, for the pass-through list the server reads from its health report.
    const dev = await startViteDev(app);
    await serverLoadsFromWeb(app, dev.url, 'web', 'server.mjs');
    return dev;
  });

  await app.step('with firebase installed only in web/, web/server.mjs started from the app root loads its live rows from web/', async () => {
    // From the app root, which resolves no firebase: the register reads it from the entry script's folder, as Node loads it (#2166).
    await serverLoadsFromWeb(app, dev.url, undefined, 'web/server.mjs');
    await dev.vite.stop();
  });

  await app.step('nothing reached any host but loopback', () => {
    assert.deepEqual(app.browserLog.filter((line) => line.includes('[blocked external')), []);
  });
});
