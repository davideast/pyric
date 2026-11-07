// The chip's Traffic panel names who sent each request. One `pyric sandbox
// --hosted` Node host takes four callers: the page in Chromium, a
// firebase-admin write and a client SDK read from `node --import
// @pyric/cli/register` processes, and an MCP tool call through the installed
// `pyric mcp --attach`. The chip opens on This page, which lists only the
// page's own requests, and still does after a reload. All sandbox traffic
// lists all four, each labelled with its source, and the admin write reads
// Bypassed. On the default SharedWorker setup, All sandbox traffic says that
// server code using the client SDK needs `--hosted`. The scope, denied and
// auto-update controls are switches (role=switch, aria-checked) that each flip
// their effect, and the footer holds only the Requests/Rates picker, with
// nothing in it overflowing at 1280px or 360px.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

declare function writeFromPage(): Promise<unknown>;

interface TrafficRow { source: string | null; call: string; path: string; verdict: string }

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs / 1000}s`);
    await sleep(250);
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Runs `pyric mcp --attach` over stdio from the app directory and returns the tool's result. */
async function mcpCall(app: App, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: { ok: boolean } }> {
  const { code, output } = await app.command('node', ['mcp-call.mjs', name, JSON.stringify(args)], { timeoutMs: 60_000 });
  assert.equal(code, 0, output);
  const line = output.split('\n').find((entry) => entry.startsWith('result '));
  assert.ok(line, `no result line in:\n${output}`);
  return JSON.parse(line.slice('result '.length));
}

/** Opens the chip on its Traffic tab. */
async function openTraffic(page: Page): Promise<void> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  const expand = chip.locator('[data-expand]');
  if (await expand.isVisible()) await expand.click();
  await chip.locator('[data-chip-tab="traffic"]').click();
  await chip.locator('[data-traffic-scope][role="switch"]').waitFor({ timeout: 15_000 });
}

/** Flips a Traffic switch, when it is not already in `on`, and waits for its aria-checked. */
async function setSwitch(page: Page, selector: string, on: boolean): Promise<void> {
  const control = page.locator(`[data-pyric-runtime-chip-host] ${selector}[role="switch"]`);
  const wanted = String(on);
  if ((await control.getAttribute('aria-checked')) !== wanted) await control.click();
  await waitFor(`${selector} did not turn ${on ? 'on' : 'off'}`, async () => (await control.getAttribute('aria-checked')) === wanted, 5_000);
}

async function chooseScope(page: Page, scope: 'page' | 'all'): Promise<void> {
  await setSwitch(page, '[data-traffic-scope]', scope === 'all');
}

/** The footer controls whose content is wider than their box. */
function overflowingFooterControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-pyric-runtime-chip-host]')?.shadowRoot;
    const bar = root?.querySelector<HTMLElement>('[data-action-bar]');
    if (!bar) return ['no footer'];
    return [bar, ...bar.querySelectorAll<HTMLElement>('*')]
      .filter((element) => element.scrollWidth > element.clientWidth && element.clientWidth > 0)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className} ${element.scrollWidth} > ${element.clientWidth}`);
  });
}

/** The rows the Traffic panel lists now. */
function trafficRows(page: Page): Promise<TrafficRow[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-pyric-runtime-chip-host]')?.shadowRoot;
    const rows = [...(root?.querySelectorAll<HTMLElement>('[data-request-row]') ?? [])];
    const text = (row: HTMLElement, selector: string) => row.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    return rows.map((row) => {
      const source = row.querySelector<HTMLElement>('[data-traffic-row-source]');
      return {
        source: source?.dataset.trafficRowSource ?? null,
        call: text(row, '.c1'),
        path: text(row, '.c2'),
        verdict: text(row, '.slot'),
      };
    });
  });
}

function rowsFor(rows: TrafficRow[], path: string): TrafficRow[] {
  return rows.filter((row) => row.path.includes(path));
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { PYRIC_SANDBOX: `remote:${url}` };

  const host = await app.step('pyric sandbox --hosted serves the page', async () => {
    const host = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    await waitFor(`pyric sandbox --hosted did not serve ${url}/__pyric/init.json`, async () => {
      if (!host.running) throw new Error(`pyric sandbox --hosted exited (code ${await host.exited}):\n${host.output}`);
      return answers(`${url}/__pyric/init.json`);
    }, 90_000);
    return host;
  });

  const page = await app.step('the page writes and reads its note on the Node host', async () => {
    const page = await app.page(`${url}/`);
    await page.locator('#status').filter({ hasText: 'ready' }).waitFor({ timeout: 30_000 });
    assert.deepEqual(await page.evaluate(() => writeFromPage()), { from: 'page' });
    return page;
  });

  await app.step('firebase-admin in a registered process writes a note', async () => {
    const { output } = await app.serverScript('admin.mjs', [], { env, timeoutMs: 60_000 });
    assert.match(output, /^admin done$/m, output);
  });

  await app.step('the client SDK in a registered process reads a note', async () => {
    const { output } = await app.serverScript('client.mjs', [], { env, timeoutMs: 60_000 });
    assert.match(output, /^client done$/m, output);
  });

  await app.step('an MCP tool call through pyric mcp writes a note', async () => {
    const result = await mcpCall(app, 'firestore_create_document', { path: 'notes/from-mcp', data: { from: 'mcp' } });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.body.ok, true, JSON.stringify(result));
  });

  await app.step("Traffic opens on This page, listing only the page's own requests", async () => {
    await openTraffic(page);
    const scope = page.locator('[data-pyric-runtime-chip-host] [data-traffic-scope]');
    assert.equal(await scope.getAttribute('role'), 'switch');
    assert.equal(await scope.getAttribute('aria-checked'), 'false');
    await waitFor("the page's own rows did not appear", async () => rowsFor(await trafficRows(page), 'notes/from-page').length > 0);
    const rows = await trafficRows(page);
    for (const other of ['notes/from-admin', 'notes/from-client-read', 'notes/from-mcp']) {
      assert.deepEqual(rowsFor(rows, other), [], `This page lists ${other}:\n${JSON.stringify(rows, null, 2)}`);
    }
    assert.ok(rows.every((row) => row.source === null), `This page labels its rows:\n${JSON.stringify(rows, null, 2)}`);
  });

  await app.step('All sandbox traffic lists all four callers, each with its source', async () => {
    await chooseScope(page, 'all');
    const expected: Array<[string, string]> = [
      ['notes/from-page', 'page'],
      ['notes/from-admin', 'admin'],
      ['notes/from-client-read', 'node'],
      ['notes/from-mcp', 'mcp'],
    ];
    await waitFor('All sandbox traffic did not list every caller', async () => {
      const rows = await trafficRows(page);
      return expected.every(([path]) => rowsFor(rows, path).length > 0);
    });
    const rows = await trafficRows(page);
    for (const [path, source] of expected) {
      const matching = rowsFor(rows, path);
      assert.ok(
        matching.every((row) => row.source === source),
        `${path} must come from ${source}:\n${JSON.stringify(matching, null, 2)}`,
      );
    }
    const admin = rowsFor(rows, 'notes/from-admin');
    assert.ok(admin.every((row) => row.verdict === 'Bypassed'), `the admin write must read Bypassed:\n${JSON.stringify(admin, null, 2)}`);
    const note = page.locator('[data-pyric-runtime-chip-host] [data-traffic-hosted-note]');
    assert.equal(await note.count(), 0, 'the Node host shows the --hosted note');
  });

  await app.step('the denied and auto-update switches flip and filter or hold the list', async () => {
    const rowCount = async () => (await trafficRows(page)).length;
    const listed = await rowCount();
    await setSwitch(page, '[data-traffic-denied]', true);
    await waitFor('the denied switch did not narrow the list', async () => (await rowCount()) < listed);
    const problems = await page.evaluate(() => {
      const root = document.querySelector('[data-pyric-runtime-chip-host]')?.shadowRoot;
      return [...(root?.querySelectorAll<HTMLElement>('[data-request-row]') ?? [])].map((row) => row.classList.contains('problem'));
    });
    assert.ok(problems.every(Boolean), `the denied switch lists a request that succeeded: ${JSON.stringify(problems)}`);
    await setSwitch(page, '[data-traffic-denied]', false);
    await waitFor('the denied switch did not restore the list', async () => (await rowCount()) === listed);

    const fromPage = async () => rowsFor(await trafficRows(page), 'notes/from-page').length;
    const before = await fromPage();
    await setSwitch(page, '[data-request-pause]', false);
    assert.deepEqual(await page.evaluate(() => writeFromPage()), { from: 'page' });
    await sleep(1_000);
    assert.equal(await fromPage(), before, 'a paused list took a new request');
    await setSwitch(page, '[data-request-pause]', true);
    await waitFor('turning auto-update on did not show the new request', async () => (await fromPage()) > before);
  });

  await app.step('the footer holds only the view picker, and nothing in it overflows at 1280px or 360px', async () => {
    const footer = page.locator('[data-pyric-runtime-chip-host] [data-action-bar] button');
    assert.deepEqual(await footer.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('role'))), ['tab', 'tab']);
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await sleep(200);
      assert.deepEqual(await overflowingFooterControls(page), [], `footer overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await app.step("after a reload, This page still lists the page's earlier requests as its own", async () => {
    await page.reload();
    await page.locator('#status').filter({ hasText: 'ready' }).waitFor({ timeout: 30_000 });
    await openTraffic(page);
    await chooseScope(page, 'page');
    await waitFor("the page's rows did not return after a reload", async () => rowsFor(await trafficRows(page), 'notes/from-page').length > 0);
    const rows = await trafficRows(page);
    assert.deepEqual(rowsFor(rows, 'notes/from-admin'), [], JSON.stringify(rows, null, 2));
  });

  await app.step('stop the Node host', () => host.stop());

  await app.step('on the default SharedWorker setup, All sandbox traffic says server client SDK code needs --hosted', async () => {
    const sandbox = await app.sandboxServer();
    const shared = await app.page(`${sandbox.url}/`);
    await shared.locator('#status').filter({ hasText: 'ready' }).waitFor({ timeout: 30_000 });
    await openTraffic(shared);
    const note = shared.locator('[data-pyric-runtime-chip-host] [data-traffic-hosted-note]');
    assert.equal(await note.count(), 0, 'This page shows the --hosted note');
    await chooseScope(shared, 'all');
    await note.waitFor({ timeout: 15_000 });
    assert.match(await note.innerText(), /Server code that uses the client SDK reaches this sandbox only when it runs with pyric sandbox --hosted\./);
  });
});
