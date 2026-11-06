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
 * Without the list, the same page is refused: the dev server names every
 * unserved import it was asked for and the `passThrough` option that would
 * allow them, and the page throws `PYRIC_LIVE_REFUSED`. A list that names an
 * import live mode serves, such as `firebase/database`, `firebase/ai` or
 * `firebase/storage`, or
 * `firebase-admin`, stops the dev server at start.
 *
 * The page gets each service and makes no call, so no request leaves. Like
 * every app scenario this runs offline, and the browser blocks every host but
 * loopback.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { scenario, sleep, type App, type ExpectedCrash } from '../driver.ts';

const ENTRY = '@pyric/live/vite';
const PASSED = ['firebase/functions', 'firebase/remote-config'];

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

  const page = await app.step('the page loads: Auth, Cloud Functions and Remote Config share the app it made', async () => {
    const opened = await app.page(`${host.url}/`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready', undefined, { timeout: 30_000 });
    const services = await opened.locator('#services li').allTextContents();
    assert.deepEqual(services, ['auth: ready', 'functions: ready', 'remote-config: ready']);
    return opened;
  });

  await app.step('the chip shows the project only, and the health report still lists each passed-through service', async () => {
    const chip = await openChip(page);
    assert.equal(await chip.locator('.panel-header [data-chip-live]').textContent(), 'demo-live-pass-through');
    assert.equal(await chip.locator('.panel-header .brand').textContent(), 'pyricdemo-live-pass-through');
    const live = await liveHealth(host.url);
    assert.deepEqual(live.passThrough, PASSED);
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

  await app.step('a list naming a served import, such as firebase/database, firebase/ai or firebase/storage, or firebase-admin stops the dev server at start', async () => {
    const port = await app.freePort();
    const env = { PASS_THROUGH: JSON.stringify(['firebase/firestore', 'firebase/database', 'firebase/ai', 'firebase/storage', 'firebase-admin', '@firebase/functions']) };
    const run = await app.command('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { env, timeoutMs: 60_000 });
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.output, /@pyric\/live\/vite: passThrough lists firebase\/firestore, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/database, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/ai, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /passThrough lists firebase\/storage, which live mode already serves and observes; remove it\./);
    assert.match(run.output, /firebase-admin, which never passes through/);
    assert.match(run.output, /@firebase\/functions, an SDK package name; list firebase\/functions/);
  });

  await app.step('nothing reached any host but loopback', () => {
    assert.deepEqual(blockedLines(app), []);
  });
});
