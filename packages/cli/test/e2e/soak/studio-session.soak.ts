/**
 * Serve-survival soak: a real Studio browsing session must never kill the
 * `pyric dev` process.
 *
 * Regression scope (owner-observed, live): the dev server died during
 * browser-driven Studio use, including a plain browsing session across the
 * data tabs. Static curls of the same routes survive; the crash
 * class is an error surfacing at the event-loop level (unhandled rejection,
 * unhandled 'error' event on a stream/watcher/socket) from a real browser's
 * connection churn. `installServeProcessGuard` + the per-path hardening in
 * serve are the fix; this suite pins "the process stays alive" end to end.
 *
 * Named `*.soak.ts` so `bun test` never picks it up; runs via the root
 * `bun run test:soak` (requires the built @pyric/cli dist + Chromium).
 */
import { test, expect, type Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import {
  health,
  startSoakServe,
  waitFor,
  type SoakServe,
} from './harness.js';

async function mcpWrite(mcpUrl: string, state: { sid: string | null; id: number }, path: string): Promise<void> {
  const post = async (body: Record<string, unknown>): Promise<Response> =>
    fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(state.sid ? { 'mcp-session-id': state.sid } : {}),
      },
      body: JSON.stringify(body),
    });
  if (!state.sid) {
    const res = await post({
      jsonrpc: '2.0',
      id: state.id++,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'studio-soak', version: '0' } },
    });
    state.sid = res.headers.get('mcp-session-id');
    await res.text();
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then((r) => r.text());
  }
  await post({
    jsonrpc: '2.0',
    id: state.id++,
    method: 'tools/call',
    params: { name: 'firestore_set_document', arguments: { path, data: { at: Date.now() } } },
  }).then((r) => r.text());
}

function assertServeAlive(serve: SoakServe, label: string): void {
  expect(
    serve.child.exitCode,
    `serve process died (${label}). stderr tail:\n${serve.stderr().slice(-2000)}`,
  ).toBeNull();
}

async function clickTab(page: Page, name: string): Promise<void> {
  const nav = page
    .locator(`a:has-text("${name}"), [role="tab"]:has-text("${name}"), button:has-text("${name}")`)
    .first();
  if (await nav.count()) {
    await nav.click({ timeout: 3_000 }).catch(() => {});
  }
  await page.waitForTimeout(500);
}

test('a full Studio session (tab browsing + writes) never kills the serve process', async () => {
  const serve = await startSoakServe();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();

    // The app tab (the sandbox host) + the Studio tab, like a real session.
    const appPage = await context.newPage();
    await appPage.goto(serve.info.url, { waitUntil: 'load' });

    const studio = await context.newPage();
    expect(serve.info.uiUrl).not.toBeNull();
    await studio.goto(serve.info.uiUrl!, { waitUntil: 'load' });
    await waitFor('bridge health after Studio load', async () => (await health(serve.info.url)) !== null);

    // A browsing pass: click through the data tabs while MCP writes land
    //    through the bridge relay (import-style traffic), with a mid-pass
    //    reload (peer churn: sockets die mid-flight).
    const mcp = { sid: null as string | null, id: 1 };
    const tabs = ['Firestore', 'Auth', 'RTDB', 'Storage', 'Traffic', 'Settings', 'Home'];
    for (let pass = 0; pass < 2; pass++) {
      for (const tab of tabs) {
        await mcpWrite(serve.info.mcpUrl!, mcp, `soak/${tab.toLowerCase()}-${pass}`).catch(() => {});
        await clickTab(studio, tab);
        assertServeAlive(serve, `browsing ${tab} (pass ${pass})`);
      }
      await studio.reload({ waitUntil: 'load' }).catch(() => {});
      await appPage.reload({ waitUntil: 'load' }).catch(() => {});
    }

    // 3. Back to Prototype once more after the churn.
    await clickTab(studio, 'Prototype');
    await studio.waitForTimeout(2_000);
    assertServeAlive(serve, 'after returning to Prototype');

    // The bridge endpoint still answers (the server is alive AND functional).
    const h = await health(serve.info.url);
    expect(h).not.toBeNull();

    // The process guard must not have been silently eating errors either —
    // if it fired, surface what it caught so the root cause gets fixed at
    // the source (the guard is a net, not a license).
    const guardHits = serve
      .stderr()
      .split('\n')
      .filter((l) => l.includes('UNHANDLED REJECTION') || l.includes('UNCAUGHT EXCEPTION'));
    expect(guardHits, `the process guard caught errors:\n${guardHits.join('\n')}`).toHaveLength(0);
  } finally {
    await browser.close().catch(() => {});
    await serve.stop();
  }
});
