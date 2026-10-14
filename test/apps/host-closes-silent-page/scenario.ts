// A page that stops talking without closing its socket must not stay online
// on the host (#965). Two such pages register presence with
// `onDisconnect().set('offline')`:
//
// - one whose JavaScript is halted through CDP (`Debugger.pause`), the state
//   of a frozen tab or a sleeping laptop: the socket stays open and its
//   timers stop. `Page.setWebLifecycleState({ state: 'frozen' })` would be
//   the closer model, but Chromium does not freeze a visible page, and every
//   headless page is visible, so its timers kept running;
// - one that navigates away into the back-forward cache. Chromium keeps the
//   page, and the host never sees its socket close.
//
// The host closes each once the liveness window passes with no frame, so
// both statuses flip to offline. A third page that keeps running is not
// closed. The window is shortened through PYRIC_TEST_PEER_LIVENESS_MS, a
// test-only knob read when the host starts; it stays longer than the
// client's 15s heartbeat so the running page proves heartbeats keep it open.
//
// Playwright disables the back-forward cache by default and its headless
// shell refuses it, so this app launches full Chromium in new headless mode
// with the cache enabled.
import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { scenario, sleep } from '../driver.ts';

declare const presence: { goOnline(user: string): Promise<void>; read(user: string): Promise<unknown> };
declare const restoredFromCache: boolean | undefined;

const WINDOW_MS = 40_000;
const HEARTBEAT_MS = 15_000;

async function openOnline(context: BrowserContext, url: string, user: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => 'presence' in window);
  await page.evaluate((name) => presence.goOnline(name), user);
  return page;
}

/** Poll until `user` reads `offline`; returns the milliseconds since `since`, or undefined. */
async function offlineWithin(observer: Page, user: string, since: number, limitMs: number): Promise<number | undefined> {
  while (Date.now() - since < limitMs) {
    const value = await observer.evaluate((name) => presence.read(name), user);
    if (value === 'offline') return Date.now() - since;
    await sleep(500);
  }
  return undefined;
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server with a 40s liveness window', () =>
    app.devServer({ env: { PYRIC_TEST_PEER_LIVENESS_MS: String(WINDOW_MS) } }));

  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  try {
    const context = await browser.newContext();
    const observer = await context.newPage();
    await observer.goto(host.url);
    await observer.waitForFunction(() => 'presence' in window);

    const pages = await app.step('three pages go online and register onDisconnect', async () => {
      const running = await openOnline(context, host.url, 'running');
      const frozen = await openOnline(context, host.url, 'frozen');
      const cached = await openOnline(context, host.url, 'cached');
      for (const user of ['running', 'frozen', 'cached']) {
        assert.equal(await observer.evaluate((name) => presence.read(name), user), 'online', user);
      }
      return { running, frozen, cached };
    });

    const cacheMisses: string[] = [];
    // Frames the frozen page sends to the host after it is halted; Vite's own
    // `{"type":"ping"}` on its HMR socket is not one of them.
    const framesAfterFreeze: string[] = [];
    const silencedAt = await app.step('one page is frozen and one navigates into the back-forward cache', async () => {
      const cachedSession = await context.newCDPSession(pages.cached);
      await cachedSession.send('Page.enable');
      cachedSession.on('Page.backForwardCacheNotUsed', (event) => cacheMisses.push(JSON.stringify(event.notRestoredExplanations)));
      const frozenSession = await context.newCDPSession(pages.frozen);
      await frozenSession.send('Network.enable');
      frozenSession.on('Network.webSocketFrameSent', (event) => {
        const isHostFrame = !event.response.payloadData.startsWith('{"type":"ping"}');
        if (isHostFrame) framesAfterFreeze.push(event.response.payloadData.slice(0, 80));
      });
      await frozenSession.send('Debugger.enable');
      const paused = new Promise<void>((resolve) => frozenSession.once('Debugger.paused', () => resolve()));
      await frozenSession.send('Debugger.pause');
      await paused;
      framesAfterFreeze.length = 0;
      await pages.cached.goto(`${host.url}/other.html`);
      const at = Date.now();
      await sleep(2_000);
      for (const user of ['frozen', 'cached']) {
        assert.equal(await observer.evaluate((name) => presence.read(name), user), 'online', `${user} closed its socket on its own`);
      }
      return at;
    });

    await app.step('the host closes both silent pages, so their onDisconnect sets offline', async () => {
      const limit = WINDOW_MS + 20_000;
      const [frozenMs, cachedMs] = await Promise.all([
        offlineWithin(observer, 'frozen', silencedAt, limit),
        offlineWithin(observer, 'cached', silencedAt, limit),
      ]);
      assert.deepEqual(framesAfterFreeze, [], 'the frozen page kept talking to the host');
      assert.ok(frozenMs !== undefined, `the frozen page was still online ${limit / 1000}s after it froze`);
      assert.ok(cachedMs !== undefined, `the cached page was still online ${limit / 1000}s after it left`);
    });

    await app.step('the running page, which keeps heartbeating, stays online past the window', async () => {
      const remaining = WINDOW_MS + HEARTBEAT_MS - (Date.now() - silencedAt);
      if (remaining > 0) await sleep(remaining);
      assert.equal(await observer.evaluate(() => presence.read('running')), 'online');
      assert.equal(await pages.running.evaluate(() => presence.read('running')), 'online');
    });

    await app.step('the navigated page was held in the back-forward cache', async () => {
      await pages.cached.goBack({ waitUntil: 'commit' });
      await pages.cached.waitForFunction(() => restoredFromCache === true, undefined, { timeout: 5_000 }).catch(() => {});
      assert.deepEqual(cacheMisses, []);
      assert.equal(await pages.cached.evaluate(() => restoredFromCache), true);
    });
  } finally {
    await browser.close();
  }
});
