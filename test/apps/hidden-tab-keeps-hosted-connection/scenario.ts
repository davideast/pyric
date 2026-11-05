// A tab the user leaves in the background must stay connected to the hosted
// dev server: its presence stays online, and it opens no new bridge socket.
//
// In Chrome a hidden tab's timers run at most once a second, and after five
// minutes hidden a chain of timers, such as the bridge client's 15 s
// heartbeat, runs about once a minute. Playwright turns this off: it passes
// `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`
// and `--disable-backgrounding-occluded-windows`, and it keeps every page it
// drives visible through CDP focus emulation, so a page it opens is never
// hidden however many tabs cover it. This app launches full Chromium in new
// headless mode without those three switches, and opens its two tabs over
// CDP in a browser context Playwright does not manage, so no focus emulation
// holds them visible. That context has the driver's resolver rules but none
// of its routes or crash watch; the tabs' error responses still count.
// Measured that way on Playwright 1.62.0: a hidden tab's 15 s timer chain ran
// every 16 s for five minutes, then 38 s, then 60 s apart. With Playwright's
// switches it kept 100 ms timers at 100 ms while hidden.
//
// The first tab goes online with `onDisconnect().set('offline')`, the second
// covers it and watches its status for seven and a half minutes, with the
// host's default liveness windows. The hidden tab's own timer chain must show
// the throttling, or the run proves nothing. On main the tab's socket closes
// and its status reads offline after about six minutes hidden (#2097).
import assert from 'node:assert/strict';
import type { CDPSession } from '@playwright/test';
import { launchScenarioBrowser, scenario, sleep, type App } from '../driver.ts';

/** Waits over seven minutes with the tab hidden, so pull requests skip it (test/apps/selection.ts). */
export const slow = true;
export const timeoutMs = 15 * 60_000;

/** Five minutes until Chrome throttles a hidden tab's timer chains hard, then two of its one-minute wake-ups and a margin. */
const HIDDEN_MS = 7.5 * 60_000;
/** A hidden tab's heavily throttled timers run about once a minute; a gap this long shows the throttling happened. */
const THROTTLED_GAP_MS = 45_000;
const THROTTLE_SWITCHES = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];
const BRIDGE_SOCKET = /\/__pyric\/sandbox/;

interface CdpMessage { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } }

/**
 * A tab driven over the browser's CDP session, through `Target.sendMessageToTarget`,
 * so Playwright never attaches to it. It records the bridge sockets it opens
 * and closes, and passes its error responses to the app.
 */
class RawTab {
  readonly socketsOpened: string[] = [];
  readonly socketsClosed: string[] = [];
  private readonly socketUrls = new Map<string, string>();
  private readonly methods = new Map<string, string>();
  private readonly closedIds = new Set<string>();
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private nextId = 1;

  private constructor(private readonly browser: CDPSession, private readonly sessionId: string, private readonly app: App) {
    browser.on('Target.receivedMessageFromTarget', (event) => {
      if (event.sessionId !== this.sessionId) return;
      this.receive(JSON.parse(event.message) as CdpMessage);
    });
  }

  static async open(browser: CDPSession, browserContextId: string, url: string, app: App): Promise<RawTab> {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: false });
    const tab = new RawTab(browser, sessionId, app);
    await tab.call('Network.enable');
    await tab.call('Page.navigate', { url });
    await tab.waitFor(`'presence' in window`);
    return tab;
  }

  private receive(message: CdpMessage): void {
    const resolve = message.id === undefined ? undefined : this.pending.get(message.id);
    if (resolve) {
      this.pending.delete(message.id!);
      resolve(message);
      return;
    }
    const params = message.params ?? {};
    // Chromium can report one socket's events twice, so each socket counts once, by its request id.
    const requestId = String(params.requestId);
    const isNewBridgeSocket = message.method === 'Network.webSocketCreated' && BRIDGE_SOCKET.test(String(params.url)) && !this.socketUrls.has(requestId);
    if (isNewBridgeSocket) {
      this.socketUrls.set(requestId, String(params.url));
      this.socketsOpened.push(`${new Date().toISOString()} ${String(params.url)}`);
    }
    const url = this.socketUrls.get(requestId);
    const closesBridgeSocket = message.method === 'Network.webSocketClosed' && url !== undefined && !this.closedIds.has(requestId);
    if (closesBridgeSocket) {
      this.closedIds.add(requestId);
      this.socketsClosed.push(`${new Date().toISOString()} ${url}`);
    }
    if (message.method === 'Network.requestWillBeSent') {
      const request = params.request as { method: string };
      this.methods.set(requestId, request.method);
    }
    const isErrorResponse = message.method === 'Network.responseReceived' && (params.response as { status: number }).status >= 400;
    if (isErrorResponse) {
      const response = params.response as { status: number; url: string };
      const method = this.methods.get(requestId) ?? 'GET';
      (this.app.browserLog as string[]).push(`[raw tab response ${response.status}] ${method} ${response.url}`);
      this.app.noteErrorResponse(response.status, method, response.url);
    }
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = this.nextId++;
    const answered = new Promise<CdpMessage>((resolve) => this.pending.set(id, resolve));
    void this.browser.send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) });
    return answered;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const result = answer.result as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } } | undefined;
    if (answer.error) throw new Error(`${expression}: ${answer.error.message}`);
    if (result?.exceptionDetails) throw new Error(`${expression}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result?.result?.value as T;
  }

  async waitFor(expression: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await this.evaluate<boolean>(expression).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`${expression} stayed false for ${timeoutMs / 1000}s`);
      await sleep(250);
    }
  }
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server with its default liveness windows', () => app.devServer());

  await app.step('deploy open rtdb rules', async () => {
    const result = await app.pyric(
      ['rules', 'set', '--service', 'database', '--rules', JSON.stringify({ rules: { '.read': true, '.write': true } })],
      { env: { PYRIC_SANDBOX: `remote:${host.url}` } },
    );
    assert.equal(result.code, 0, result.output);
  });

  const launched = await launchScenarioBrowser({ channel: 'chromium', ignoreDefaultArgs: THROTTLE_SWITCHES });
  try {
    const browser = await launched.newBrowserCDPSession();
    const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: true });

    const background = await app.step('a tab goes online and registers onDisconnect', async () => {
      const tab = await RawTab.open(browser, browserContextId, host.url, app);
      await tab.evaluate(`presence.goOnline('background')`);
      return tab;
    });

    const front = await app.step('a second tab covers it, so the first is hidden', async () => {
      const tab = await RawTab.open(browser, browserContextId, host.url, app);
      await tab.evaluate(`presence.watch('background')`);
      await tab.waitFor('statusValues.length > 0');
      assert.equal(await background.evaluate('document.visibilityState'), 'hidden');
      assert.equal(await tab.evaluate('document.visibilityState'), 'visible');
      return tab;
    });
    const openedBefore = background.socketsOpened.length;

    await app.step(`the hidden tab stays online for ${HIDDEN_MS / 60_000} minutes`, async () => {
      const started = Date.now();
      while (Date.now() - started < HIDDEN_MS) {
        await sleep(Math.min(30_000, HIDDEN_MS - (Date.now() - started)));
        const values = await front.evaluate<unknown[]>('statusValues');
        const gap = await background.evaluate<number>('longestTimerGap');
        console.log(`  hidden-tab-keeps-hosted-connection: ${Math.round((Date.now() - started) / 1000)} s hidden, longest timer gap ${gap} ms, status ${JSON.stringify(values)}, bridge sockets opened ${background.socketsOpened.length - openedBefore} closed ${background.socketsClosed.length}`);
      }
      const gap = await background.evaluate<number>('longestTimerGap');
      assert.equal(await background.evaluate('document.visibilityState'), 'hidden', 'the tab did not stay hidden');
      assert.ok(gap >= THROTTLED_GAP_MS, `the hidden tab's 15 s timer chain ran at most ${gap} ms apart, so Chromium never throttled it and this run proves nothing`);
      assert.deepEqual(
        { status: await front.evaluate('statusValues'), closed: background.socketsClosed, opened: background.socketsOpened.slice(openedBefore) },
        { status: ['online'], closed: [], opened: [] },
        `the hidden tab's status as the visible tab saw it, and the bridge sockets the hidden tab closed and opened (its timers ran up to ${gap} ms apart)`,
      );
    });

    await app.step('the hidden tab still writes, and the visible tab reads it', async () => {
      await background.evaluate(`presence.write('notes/back', 'returned')`);
      assert.equal(await front.evaluate(`presence.read('notes/back')`), 'returned');
    });
  } finally {
    await launched.close();
  }
});
