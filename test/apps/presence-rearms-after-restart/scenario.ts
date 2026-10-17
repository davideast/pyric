// Presence re-arms across a hosted dev server restart (#990). The page runs
// the presence code from the Firebase docs: each time `.info/connected` turns
// true it queues `onDisconnect(status).set('offline')` and then sets `online`.
//
// A restart closes every connection on the old host instance, so the old host
// runs the page's onDisconnect and the restarted host reads `offline` (#973).
// An app that re-arms on `true` registers again on the new host instance, so
// the status returns to `online`, and closing the page later runs that new
// registration. The page has a switch that turns the re-arm off, which shows
// both halves: the drain on restart, and the re-registration surviving it.
//
// The restart is an edit to vite.config.js, as in hosted-write-during-restart,
// and the config points Vite's HMR client at a port nothing serves so the page
// is never reloaded. Nothing here waits on a liveness window.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, sleep, type App, type DevServer } from '../driver.ts';

interface Arm { state: 'pending' | 'fulfilled' | 'rejected'; message?: string }
declare const presence: { connected(): boolean | null; connections(): number; setRearm(value: boolean): void; arms(): Arm[] };

/** Settles `pending` within `ms`, or fails naming the browser call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

function connections(page: Page): Promise<number> {
  return within('page.evaluate(() => presence.connections())', 5_000, page.evaluate(() => presence.connections()));
}

function arms(page: Page): Promise<Arm[]> {
  return within('page.evaluate(() => presence.arms())', 5_000, page.evaluate(() => presence.arms()));
}

/** Polls until the page has seen `.info/connected` turn true `count` times and is connected now. */
async function untilConnections(page: Page, count: number, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const seen = await connections(page);
    const connected = await within('page.evaluate(() => presence.connected())', 5_000, page.evaluate(() => presence.connected()));
    const reached = seen >= count && connected === true;
    if (reached) return;
    assert.ok(Date.now() < deadline, `.info/connected turned true ${seen} times, not ${count}, within ${limitMs / 1000}s`);
    await sleep(100);
  }
}

/** Polls until the page has armed `count` times and each arm has settled. */
async function settledArms(page: Page, count: number, limitMs: number): Promise<Arm[]> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const current = await arms(page);
    const settled = current.length === count && current.every((arm) => arm.state !== 'pending');
    if (settled) return current;
    assert.ok(Date.now() < deadline, `the page did not settle ${count} arms within ${limitMs / 1000}s: ${JSON.stringify(current)}`);
    await sleep(100);
  }
}

async function readStatus(app: App, url: string): Promise<unknown> {
  const { output } = await app.serverScript('status.mjs', [], { env: { PYRIC_SANDBOX: `remote:${url}` } });
  const line = output.match(/^status (.*)$/m);
  assert.ok(line, `status.mjs printed no status:\n${output}`);
  return JSON.parse(line[1]!);
}

/** Polls the status from a server script until it reads `expected`, or fails with the last value read. */
async function untilStatus(app: App, url: string, expected: string, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const status = await readStatus(app, url);
    if (status === expected) return;
    assert.ok(Date.now() < deadline, `status/alice read ${JSON.stringify(status)}, not ${JSON.stringify(expected)}, within ${limitMs / 1000}s`);
    await sleep(250);
  }
}

/** Edits vite.config.js so Vite restarts the server in place on a new host instance. */
async function restartByConfigEdit(app: App, host: DevServer, revision: number): Promise<void> {
  const mark = host.process.mark();
  const config = app.readFile('vite.config.js');
  const edited = config.replace(
    /hmr: \{ clientPort: 1 \}(, headers: \{ "x-config-revision": "\d+" \})? \}/,
    `hmr: { clientPort: 1 }, headers: { "x-config-revision": "${revision}" } }`,
  );
  assert.notEqual(edited, config, 'the edit did not apply to vite.config.js');
  app.writeFile('vite.config.js', edited);
  const [outcome] = await host.process.waitForLog(/server restarted|server restart failed/, { since: mark, timeoutMs: 60_000 });
  assert.equal(outcome, 'server restarted', `Vite reported: ${host.process.output.slice(mark).trim()}`);
}

export default scenario(async (app) => {
  // The restart interrupts the page's connection, and the page posts that to
  // /__pyric/diagnostics. A post made before the new server generation mounts
  // Pyric's routes answers 404, and the page keeps the report in memory.
  app.expectHostError(/^404 POST \/__pyric\/diagnostics$/);

  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('open the page; it connects and goes online', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'presence' in window, undefined, { timeout: 30_000 });
    await untilConnections(page, 1, 30_000);
    const [first] = await settledArms(page, 1, 10_000);
    assert.equal(first!.state, 'fulfilled', first!.message);
    assert.equal(await readStatus(app, host.url), 'online');
    return page;
  });

  await app.step('turn the re-arm off; a restart runs the onDisconnect, and the restarted host reads offline', async () => {
    await within('page.evaluate(() => presence.setRearm(false))', 5_000, page.evaluate(() => presence.setRearm(false)));
    await restartByConfigEdit(app, host, 2);
    await untilConnections(page, 2, 30_000);
    assert.equal(await readStatus(app, host.url), 'offline');
    assert.equal((await arms(page)).length, 1, 'the page armed again with the re-arm off');
  });

  await app.step('turn the re-arm on; after another restart the page re-arms and the host reads online', async () => {
    await within('page.evaluate(() => presence.setRearm(true))', 5_000, page.evaluate(() => presence.setRearm(true)));
    await restartByConfigEdit(app, host, 3);
    await untilConnections(page, 3, 30_000);
    const [, rearm] = await settledArms(page, 2, 10_000);
    assert.equal(rearm!.state, 'fulfilled', rearm!.message);
    assert.equal(await readStatus(app, host.url), 'online');
  });

  await app.step('close the page; the restarted host runs the re-armed onDisconnect', async () => {
    await within('page.close()', 10_000, page.close());
    await untilStatus(app, host.url, 'offline', 10_000);
  });
});
