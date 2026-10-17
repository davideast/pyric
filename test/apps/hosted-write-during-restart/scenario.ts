// A page writes while the hosted dev server restarts (#968). The hosted
// client holds a write issued while it reconnects and sends it once after it
// re-attaches, instead of failing it at once with `unavailable`
// (ADR-0019 decision 7, amended 2026-10-14).
//
// Part one edits vite.config.js, so Vite restarts the server in place on a new
// host instance; the writes the page issues at the drop must resolve and land
// once. Part two stops the server for longer than the 10s hold deadline and
// starts it again on the same port; the write must fail once, saying it was
// not sent, and the restarted host must never receive it.
//
// The config points Vite's HMR client at a port nothing serves, so the client
// gives up at load and never reloads the page after the restart.
// (`server.hmr: false` would also stop Vite from restarting on a config edit.)
// Every browser call is bounded, so a stuck page fails the step that called it
// instead of the run.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { scenario, sleep, type App } from '../driver.ts';

interface Outcome { name: string; state: 'pending' | 'fulfilled' | 'rejected'; code?: string; message?: string }
declare const counters: { connected(): boolean | null; arm(): void; outcomes(): Outcome[]; barrier(): Promise<boolean> };
declare let restartToken: string | undefined;

const NOT_RESTORED = 'The hosted sandbox connection was not restored within 10 seconds. The request was not sent.';

/** Settles `pending` within `ms`, or fails naming the browser call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

function outcomes(page: Page): Promise<Outcome[]> {
  return within('page.evaluate(() => counters.outcomes())', 5_000, page.evaluate(() => counters.outcomes()));
}

function connected(page: Page): Promise<boolean | null> {
  return within('page.evaluate(() => counters.connected())', 5_000, page.evaluate(() => counters.connected()));
}

/** Polls until the page has issued its writes and each has settled. */
async function settledWrites(page: Page, limitMs: number): Promise<Outcome[]> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const current = await outcomes(page);
    const issued = current.length === 2;
    const settled = issued && current.every((outcome) => outcome.state !== 'pending');
    if (settled) return current;
    assert.ok(Date.now() < deadline, `the writes did not settle within ${limitMs / 1000}s: ${JSON.stringify(current)}`);
    await sleep(100);
  }
}

async function untilConnected(page: Page, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (await connected(page) !== true) {
    assert.ok(Date.now() < deadline, `.info/connected was not true within ${limitMs / 1000}s`);
    await sleep(100);
  }
}

async function readCounters(app: App, url: string, command?: 'seed'): Promise<unknown> {
  const args = command === undefined ? [] : [command];
  const { output } = await app.serverScript('counters.mjs', args, { env: { PYRIC_SANDBOX: `remote:${url}` } });
  const line = output.match(/^counters (.*)$/m);
  assert.ok(line, `counters.mjs printed no counters:\n${output}`);
  return JSON.parse(line[1]!);
}

function describe(list: Outcome[]): string {
  return list.map((outcome) => `${outcome.name}: ${outcome.state}${outcome.code ? ` [${outcome.code}] ${outcome.message}` : ''}`).join('\n');
}

export default scenario(async (app) => {
  // The restart interrupts the page's connection, and the page posts that to
  // /__pyric/diagnostics. A post made before the new server generation mounts
  // Pyric's routes answers 404, and the page keeps the report in memory.
  app.expectHostError(/^404 POST \/__pyric\/diagnostics$/);

  const host = await app.step('start the hosted dev server', () => app.devServer());

  await app.step('a server script seeds both counters to 0', async () => {
    assert.deepEqual(await readCounters(app, host.url, 'seed'), { firestore: 0, database: 0 });
  });

  const page = await app.step('open the page; it is connected', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'counters' in window, undefined, { timeout: 30_000 });
    await untilConnected(page, 30_000);
    await within('page.evaluate(() => { restartToken = ... })', 5_000, page.evaluate(() => { restartToken = 'before restart'; }));
    return page;
  });

  await app.step('arm the page; edit vite.config.js and Vite restarts the server', async () => {
    await within('page.evaluate(() => counters.arm())', 5_000, page.evaluate(() => counters.arm()));
    const mark = host.process.mark();
    const config = app.readFile('vite.config.js');
    const edited = config.replace(
      'server: { port: 5181, strictPort: true, hmr: { clientPort: 1 } },',
      'server: { port: 5181, strictPort: true, hmr: { clientPort: 1 }, headers: { "x-config-revision": "2" } },',
    );
    assert.notEqual(edited, config, 'the edit did not apply to vite.config.js');
    app.writeFile('vite.config.js', edited);
    const [outcome] = await host.process.waitForLog(/server restarted|server restart failed/, { since: mark, timeoutMs: 60_000 });
    assert.equal(outcome, 'server restarted', `Vite reported: ${host.process.output.slice(mark).trim()}`);
  });

  await app.step('the writes issued during the restart resolve', async () => {
    const settled = await settledWrites(page, 20_000);
    const allFulfilled = settled.every((outcome) => outcome.state === 'fulfilled');
    assert.ok(allFulfilled, `a write issued during the restart failed:\n${describe(settled)}`);
  });

  await app.step('the page was not reloaded by the restart', async () => {
    const token = await within('page.evaluate(() => restartToken)', 5_000, page.evaluate(() => restartToken));
    assert.equal(token, 'before restart');
  });

  await app.step('each write lands once', async () => {
    assert.deepEqual(await readCounters(app, host.url), { firestore: 1, database: 1 });
  });

  await app.step('no unavailable error reaches the browser console', () => {
    const unavailable = app.browserLog.filter((line) => /unavailable/i.test(line));
    assert.deepEqual(unavailable, []);
  });

  await app.step('arm the page; stop the dev server for longer than the hold deadline', async () => {
    await untilConnected(page, 30_000);
    await within('page.evaluate(() => counters.arm())', 5_000, page.evaluate(() => counters.arm()));
    await host.process.stop();
  });

  await app.step('the write held through the outage fails once, saying it was not sent', async () => {
    const settled = await settledWrites(page, 15_000);
    for (const outcome of settled) {
      assert.equal(outcome.state, 'rejected', describe(settled));
      assert.equal(outcome.code, 'unavailable', describe(settled));
      assert.equal(outcome.message, NOT_RESTORED, describe(settled));
    }
  });

  const restarted = await app.step('start the dev server again on the same port; the page reconnects', async () => {
    const restarted = await app.devServer({ port: host.port, name: 'dev server after the outage' });
    await untilConnected(page, 30_000);
    return restarted;
  });

  await app.step('the restarted host never received the failed writes', async () => {
    // A held write would be sent as the client re-attached, before it reported
    // the connection. Writes the page issues now follow it on the same session,
    // which the host applies in order, so their answers mean it would have landed.
    await within('page.evaluate(() => counters.barrier())', 10_000, page.evaluate(() => counters.barrier()));
    const read = await readCounters(app, restarted.url);
    // The counters read 1, not null: the host's state survived the process restart,
    // so an unchanged readback shows the writes were not applied.
    assert.deepEqual(read, { firestore: 1, database: 1 });
    const token = await within('page.evaluate(() => restartToken)', 5_000, page.evaluate(() => restartToken));
    assert.equal(token, 'before restart', 'the page was reloaded during the outage');
  });
});
