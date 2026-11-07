/**
 * Live mode for an app whose Firebase init module also sets up services live
 * mode does not serve. The notes app imports `firebase/app`, `firebase/auth`,
 * `firebase/functions` and `firebase/remote-config` in one file. With
 * `pyricLive({ passThrough: ['firebase/functions', 'firebase/remote-config'] })` the
 * page loads: Auth is the live row, and Cloud Functions and Remote Config are
 * the app's installed SDK, unwrapped, on the same app object. The start line,
 * the health report lists each one, and the chip's header names the project
 * only.
 *
 * The app's server job (`admin-server.mjs`) looks a user up with the Admin
 * SDK under `node --import @pyric/live/register`. Live mode serves and
 * observes firebase-admin by default: the real firebase-admin loads with the
 * app's own credential through the Admin rows, the start line says its calls
 * bypass Security Rules, and the job's lookup gets its answer. The job's own
 * fetch and https.request to Google's hosts go out as they would without
 * pyric (ADR 0022, amendment 2026-11-07), and the fetch to a host no row
 * observes gets its unobserved line. The job's Agent sends every https
 * request to a local stand-in for Google, and the run is offline, so no
 * request reaches a real host.
 *
 * Without the list, the same page is refused: the dev server names every
 * unserved import it was asked for and the `passThrough` option that would
 * allow them, and the page throws `PYRIC_LIVE_REFUSED`. A list that names an
 * import live mode serves, such as `firebase/database`, `firebase/ai`,
 * `firebase/storage`, `firebase/messaging` or `firebase/messaging/sw`,
 * `firebase-admin` or a `firebase-admin/*` subpath, stops the dev server at
 * start.
 *
 * The page gets each service and makes no call, so no request leaves. Like
 * every app scenario this runs offline, and the browser blocks every host but
 * loopback.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { Page } from 'playwright';
import { scenario, sleep, type App, type ExpectedCrash } from '../driver.ts';

const ENTRY = '@pyric/live/vite';
const PASSED = ['firebase/functions', 'firebase/remote-config'];
const GUARD_BLOCKED = 'PYRIC_GUARD_BLOCKED';
const UNOBSERVED_TOKEN_LINE = '@pyric/live/register: unobserved call to oauth2.googleapis.com (';
/**
 * Whether the `node` the app's processes run serves the Admin rows: Node 23
 * or later. Node 22's CommonJS require() never reaches the register's hooks,
 * so there firebase-admin stays refused, with the reason.
 */
const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;
const ADMIN_LINE =
  '@pyric/live/register: firebase-admin is observed for the Firebase project demo-live-pass-through. ' +
  'This process uses its own credential, and its Admin calls bypass Security Rules.';

/** What the server job's calls got, from its `OUTCOME` line. */
function jobOutcome(output: string): Record<string, string> {
  const line = output.split('\n').find((text) => text.startsWith('OUTCOME '));
  assert.ok(line, `the server job printed its outcome:\n${output}`);
  return JSON.parse(line.slice('OUTCOME '.length)) as Record<string, string>;
}

/**
 * Runs the server job under the live register. The register reads the
 * project from the checkout, as the Vite plugin reads its `project` option,
 * so `.firebaserc` names the same one.
 */
function runServerJob(app: App) {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: 'demo-live-pass-through' } })}\n`);
  return app.command('node', ['--import', '@pyric/live/register', 'admin-server.mjs'], { timeoutMs: 60_000 });
}

function passThroughLine(specifier: string): string {
  return `${specifier} passes through to production: its calls are not observed and still bill.`;
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

async function liveHealth(url: string): Promise<Record<string, unknown>> {
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { live?: Record<string, unknown> };
  assert.ok(health.live, 'the dev server reports live status');
  return health.live;
}

/** The chip, opened on its panel. */
async function openChip(page: Page) {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  const header = chip.locator('.panel-header [data-chip-live]');
  if (await header.count() === 0) await chip.locator('[data-expand]').click();
  return chip;
}

async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)} after ${timeoutMs / 1000}s`);
    await sleep(200);
  }
}

export const expectedCrashes: ExpectedCrash[] = [
  {
    message: /^Error: @pyric\/live: firebase\/(functions|remote-config) \((Cloud Functions|Remote Config)\) is refused in live mode\. .*passThrough/s,
    source: /^page http:\/\/127\.0\.0\.1:\d+\/ \(at http:\/\/127\.0\.0\.1:\d+\/@id\/__x00__pyric-stop:refused:page:firebase\/(functions|remote-config):\d+\)$/,
    reason: 'the step that starts the dev server without passThrough loads a page that imports both, and the first refusal throws at module evaluation',
  },
  ...(ADMIN_ROWS_ON ? [] : [{
    message: /^Error: @pyric\/live: firebase-admin\/app \(the Admin SDK\) is refused in live mode\. @pyric\/live observes firebase-admin on Node 23 or later/,
    source: /^command \d+ \(node --import @pyric\/live\/register admin-server\.mjs\)$/,
    reason: 'on Node 22, whose require() skips the hooks, the Admin rows stay shut and the server job is refused its import',
  }]),
];

export default scenario(async (app) => {
  const host = await app.step('start vite dev with pyricLive({ passThrough }): the start line names each passed-through service', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`${escaped(ENTRY)}: live mode for the Firebase project demo-live-pass-through\\.`));
    for (const specifier of PASSED) {
      await started.process.waitForLog(new RegExp(`${escaped(ENTRY)}: ${escaped(passThroughLine(specifier))}`));
    }
    return started;
  });

  await app.step('the health report lists the passed-through services', async () => {
    const live = await liveHealth(host.url);
    assert.deepEqual(live.passThrough, PASSED);
  });

  await app.step('the server job under @pyric/live/register loads the observed firebase-admin, gets its lookup answered, and its own calls to Google go out', async () => {
    const run = await runServerJob(app);
    if (!ADMIN_ROWS_ON) {
      assert.notEqual(run.code, 0, run.output);
      assert.match(run.output, new RegExp(escaped(`@pyric/live/register: firebase-admin is refused in this process. @pyric/live observes firebase-admin on Node 23 or later`)));
      assert.doesNotMatch(run.output, /passThrough: \['firebase-admin'\]/);
      return;
    }
    assert.equal(run.code, 0, run.output);
    assert.doesNotMatch(run.output, /PYRIC_LIVE_REFUSED|PYRIC_REAL_SDK_STOPPED/);
    assert.match(run.output, /@pyric\/live\/register: live mode for the Firebase project demo-live-pass-through\./);
    assert.match(run.output, new RegExp(escaped(ADMIN_LINE)));
    assert.doesNotMatch(run.output, /firebase-admin passes through/);
    const { ownFetch, ...outcome } = jobOutcome(run.output);
    assert.deepEqual(outcome, { firestore: 'loaded', adminLookup: 'scenario-user', ownRequest: 'sent' });
    // Offline, the fetch fails at the network, never at pyric.
    assert.notEqual(ownFetch, GUARD_BLOCKED);
    assert.ok(run.output.includes(UNOBSERVED_TOKEN_LINE), run.output);
    assert.doesNotMatch(run.output, new RegExp(GUARD_BLOCKED));
  });

  const page = await app.step('the page loads: Auth, Cloud Functions and Remote Config share the app it made', async () => {
    const opened = await app.page(`${host.url}/`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready', undefined, { timeout: 30_000 });
    const services = await opened.locator('#services li').allTextContents();
    assert.deepEqual(services, ['auth: ready', 'functions: ready', 'remote-config: ready']);
    return opened;
  });

  await app.step('the chip opens on the live project, and the health report still lists each passed-through service', async () => {
    const chip = await openChip(page);
    await chip.locator('.panel-header [data-chip-live]').waitFor({ timeout: 20_000 });
    const live = await liveHealth(host.url);
    assert.equal(live.projectId, 'demo-live-pass-through');
    assert.deepEqual(live.passThrough, PASSED);
    assert.deepEqual(live.observed, ['firebase/app', 'firebase/auth']);
  });

  await app.step("the chip's Live tab lists the project, this page, each passed-through and observed import, and its controls are usable", async () => {
    const chip = await openChip(page);
    await chip.locator('[data-chip-tab="sandbox"]').click();
    await chip.locator('[data-live-view]').waitFor({ timeout: 10_000 });
    const sections = await chip.locator('[data-live-section]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-live-section')));
    assert.deepEqual(sections, ['project', 'clients', 'coverage', 'billed', 'overlays']);
    assert.equal(await chip.locator('[data-live-project]').getAttribute('data-live-project'), 'demo-live-pass-through');
    // This page is listed once, first, whatever else the host lists.
    const clients = await chip.locator('[data-live-client]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-live-client')));
    assert.equal(clients[0], 'self', JSON.stringify(clients));
    assert.equal(clients.filter((client) => client === 'self').length, 1);
    const imports = await chip.locator('[data-coverage-import]').evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('data-coverage-import'), node.getAttribute('data-coverage-state')]));
    assert.deepEqual(imports, [
      ...PASSED.map((specifier) => [specifier, 'not-observed']),
      ['firebase/app', 'observed'],
      ['firebase/auth', 'observed'],
    ]);
    assert.equal(await chip.locator('[data-worker-row]').count(), 0);
    await chip.locator('[data-open-console]').waitFor({ state: 'visible' });
    const hide = chip.locator('[data-action-bar] [data-dismiss-chip]');
    await hide.click();
    await chip.waitFor({ state: 'hidden' });
  });

  await app.step('stop the dev server', async () => {
    await page.close();
    await host.process.stop();
  });

  await app.step('without the list, the dev server names every unserved import and the option that allows it, and the page is refused', async () => {
    const refusing = await app.devServer({ env: { PASS_THROUGH: '[]' } });
    const opened = await app.page(`${refusing.url}/`);
    const option = "pyricLive({ passThrough: ['firebase/functions', 'firebase/remote-config'] })";
    await refusing.process.waitForLog(new RegExp(escaped(option)), { timeoutMs: 30_000 });
    assert.match(refusing.process.output, /firebase\/functions \(Cloud Functions\) and firebase\/remote-config \(Remote Config\)/);
    const refusal = await eventually(
      async () => app.browserLog.find((line) => line.includes('PYRIC_LIVE_REFUSED') || line.includes('is refused in live mode')) ?? null,
      (line) => line !== null,
      'the page throws the refusal',
    );
    assert.match(refusal!, /firebase\/(functions|remote-config) \((Cloud Functions|Remote Config)\) is refused in live mode/);
    assert.notEqual(await opened.locator('#status').textContent(), 'Ready');
    await opened.close();
    await refusing.process.stop();
  });

  await app.step('a list naming a served import, such as firebase/database, firebase/ai, firebase/storage, firebase/messaging or firebase-admin, or a firebase-admin subpath stops the dev server at start', async () => {
    const port = await app.freePort();
    const env = { PASS_THROUGH: JSON.stringify(['firebase/firestore', 'firebase/database', 'firebase/ai', 'firebase/storage', 'firebase/messaging', 'firebase/messaging/sw', 'firebase-admin', 'firebase-admin/app', '@firebase/functions']) };
    const run = await app.command('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env, timeoutMs: 60_000 });
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.output, /@pyric\/live\/vite: passThrough lists firebase\/firestore, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/database, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/ai, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/storage, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/messaging, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/messaging\/sw, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase-admin, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase-admin\/app/);
    assert.match(run.output, /@firebase\/functions, an SDK package name; list firebase\/functions/);
  });

  await app.step('nothing reached any host but loopback', () => {
    assert.deepEqual(blockedLines(app), []);
  });
});
