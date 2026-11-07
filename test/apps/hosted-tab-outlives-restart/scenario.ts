// A browser tab keeps running the bundle and rules it loaded when the hosted
// dev server restarts underneath it. The page's socket reattaches to the new
// host boot, so its calls keep working, but nothing it runs is new. The page
// must say so: one console warning, the collapsed chip turned to a warning
// that names the reload, and a Reload page action that loads the new boot.
//
// The restart is an edit to vite.config.js, as in presence-rearms-after-restart,
// and the config points Vite's HMR client at a port nothing serves, so Vite
// never reloads the page itself.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, sleep, type App, type DevServer, type ExpectedCrash } from '../driver.ts';

declare const notes: { write(text: string): Promise<void>; read(): Promise<unknown> };
/** What Pyric's runtime puts on a page's global object: the HTML stamps the init, and the app module its own boot. */
type PyricGlobals = { __PYRIC_WORKER_INIT__?: { instanceId?: string }; __PYRIC_HOST_INSTANCE_ID__?: string };

const WARNING_PREFIX = '[pyric] The host restarted since this page loaded';

/** Settles `pending` within `ms`, or fails naming the browser call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

async function hostInstance(url: string): Promise<string> {
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { instanceId?: string };
  assert.ok(health.instanceId, `/__pyric/health has no instanceId: ${JSON.stringify(health)}`);
  return health.instanceId;
}

/** The host boot the page's app module was served by. */
function pageBoot(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (globalThis as PyricGlobals).__PYRIC_HOST_INSTANCE_ID__);
}

/** Edits vite.config.js so Vite restarts the server in place on a new host boot. */
async function restartByConfigEdit(app: App, host: DevServer): Promise<void> {
  const mark = host.process.mark();
  const config = app.readFile('vite.config.js');
  const edited = config.replace(
    'hmr: { clientPort: 1 } },',
    'hmr: { clientPort: 1 }, headers: { "x-config-revision": "2" } },',
  );
  assert.notEqual(edited, config, 'the edit did not apply to vite.config.js');
  app.writeFile('vite.config.js', edited);
  const [outcome] = await host.process.waitForLog(/server restarted|server restart failed/, { since: mark, timeoutMs: 60_000 });
  assert.equal(outcome, 'server restarted', `Vite reported: ${host.process.output.slice(mark).trim()}`);
}

export const expectedCrashes: ExpectedCrash[] = [
  {
    message: /^Error: WebSocket closed without opened\.$/,
    source: /^page http:\/\/127\.0\.0\.1:\d+\/ \(at http:\/\/127\.0\.0\.1:\d+\/@vite\/client:\d+\)$/,
    reason: "vite.config.js points Vite's HMR client at port 1 so it never reloads the page, and the client rejects when that socket fails",
  },
];

export default scenario(async (app) => {
  // The restart interrupts the page's connection, and the page posts that to
  // /__pyric/diagnostics. A post made before the new server generation mounts
  // Pyric's routes answers 404, and the page keeps the report in memory.
  app.expectHostError(/^404 POST \/__pyric\/diagnostics$/, { mayNotHappen: 'a race decides whether the post lands before the new routes mount (#2098)' });

  const host = await app.step('start the hosted dev server', () => app.devServer());
  const before = await app.step('read the host boot', () => hostInstance(host.url));

  const warnings: string[] = [];
  const page = await app.step('open the page and write a note; the chip shows no warning', async () => {
    const page = await app.page(host.url);
    page.on('console', (message) => {
      if (message.text().startsWith(WARNING_PREFIX)) warnings.push(message.text());
    });
    await page.waitForFunction(() => 'notes' in window);
    await within('notes.write()', 30_000, page.evaluate(() => notes.write('before restart')));
    assert.equal(await pageBoot(page), before);
    const expand = page.locator('[data-pyric-runtime-chip-host] [data-expand]');
    await expand.waitFor({ timeout: 30_000 });
    assert.doesNotMatch(await expand.getAttribute('class') ?? '', /\bwarning\b/);
    return page;
  });

  await app.step('edit vite.config.js; Vite restarts the server on a new boot and leaves the page open', async () => {
    await restartByConfigEdit(app, host);
    assert.notEqual(await hostInstance(host.url), before);
  });

  await app.step('the page reattaches, still reads its note, and warns once in the console', async () => {
    const note = await within('notes.read()', 60_000, page.evaluate(() => notes.read()));
    assert.equal(note, 'before restart');
    const deadline = Date.now() + 30_000;
    while (warnings.length === 0) {
      assert.ok(Date.now() < deadline, 'the page printed no host-restart warning within 30s of reattaching');
      await sleep(100);
    }
    // Another round trip and a pause give a second warning the time to land.
    await within('notes.read()', 30_000, page.evaluate(() => notes.read()));
    await sleep(2_000);
    assert.equal(warnings.length, 1, `the page warned ${warnings.length} times: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0]!, new RegExp(`host ${before} -> `));
    assert.equal(await pageBoot(page), before, 'the page still runs the bundle the earlier boot served');
  });

  await app.step('the collapsed chip turns to a warning that names the reload', async () => {
    const expand = page.locator('[data-pyric-runtime-chip-host] [data-expand]');
    await expand.waitFor({ timeout: 15_000 });
    assert.match(await expand.getAttribute('class') ?? '', /\bwarning\b/);
    assert.equal(await expand.getAttribute('title'), 'Host restarted — reload page');
  });

  await app.step('Reload page loads the bundle the restarted host serves', async () => {
    const chip = page.locator('[data-pyric-runtime-chip-host]');
    await chip.locator('[data-expand]').click();
    // The panel opens on the Sandbox view, which holds the reload row.
    const reload = chip.locator('[data-host-bundle-stale] [data-reload-page]');
    await reload.waitFor({ timeout: 15_000 });
    const loaded = page.waitForEvent('load', { timeout: 60_000 });
    await reload.click();
    await loaded;
    await page.waitForFunction(() => 'notes' in window, undefined, { timeout: 30_000 });
    const after = await hostInstance(host.url);
    assert.equal(await pageBoot(page), after);
    const note = await within('notes.read()', 30_000, page.evaluate(() => notes.read()));
    assert.equal(note, 'before restart');
    const expand = page.locator('[data-pyric-runtime-chip-host] [data-expand]');
    await expand.waitFor({ timeout: 30_000 });
    assert.doesNotMatch(await expand.getAttribute('class') ?? '', /\bwarning\b/);
  });
});
