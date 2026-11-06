// The state every soak action shares: the app, the dev server and page in use,
// the model, the log, the seeded random source, and the checks an action
// runs against the page.
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from '@playwright/test';
import type { App, DevServer } from '../driver.ts';
import { ActionLog, seededRandom, type Random, type SoakSettings } from '../soak.ts';
import { Model, canonical, until, within } from './model.ts';
import { ACTION_LIMIT_MS, SETTLE_MS, type ListenerState, type SoakPage } from './page-api.ts';

declare const soak: SoakPage;

export class Session {
  readonly log = new ActionLog();
  readonly model = new Model();
  readonly random: Random;
  readonly crashes: string[] = [];
  readonly servers: DevServer[] = [];
  readonly started = Date.now();
  /** Counts page loads: a new page heap epoch starts at each. */
  pageEpoch = 0;
  /** Counts dev server processes: a new server memory epoch starts at each. */
  serverEpoch = 0;
  restarting = false;
  /** The index in the log of the action running now. */
  current: number | undefined;

  constructor(
    readonly app: App,
    readonly context: BrowserContext,
    public host: DevServer,
    public page: Page,
    readonly settings: SoakSettings,
  ) {
    this.random = seededRandom(settings.seed);
    this.servers.push(host);
    context.on('weberror', (webError) => this.crashes.push(`page error: ${webError.error().stack ?? webError.error().message}`));
    this.watchPage(page);
  }

  watchPage(page: Page): void {
    page.on('crash', () => this.crashes.push(`the renderer of ${page.url()} crashed`));
  }

  get seconds(): number {
    return (Date.now() - this.started) / 1000;
  }

  /** Adds detail to the action running now. */
  note(detail: string): void {
    this.log.note(this.current!, detail);
  }

  call<T>(what: string, run: (page: Page) => Promise<T>, page = this.page): Promise<T> {
    return within(what, ACTION_LIMIT_MS, run(page));
  }

  /**
   * An app drops its listeners when the user changes, as the template does
   * for its own. So no listener in the soak ever sees a user change.
   */
  async dropListeners(): Promise<void> {
    await this.call('soak.unlistenAll()', (page) => page.evaluate(() => soak.unlistenAll()));
    this.model.listeners.clear();
  }

  async statusText(): Promise<string> {
    return (await this.page.locator('#auth-status').textContent()) ?? '';
  }

  async untilStatus(pattern: RegExp): Promise<void> {
    await until(`the page did not say ${pattern}`, SETTLE_MS, async () => pattern.test(await this.statusText()));
  }

  async listedTitles(): Promise<string[]> {
    return (await this.page.locator('#posts li').allTextContents()).sort();
  }

  async listenersMatch(): Promise<void> {
    const expected = Object.fromEntries([...this.model.listeners].map(([key, tag]) => [key, { ids: this.model.idsWithTag(tag), error: null }]));
    let states: Record<string, ListenerState> = {};
    try {
      await until('the listeners did not match', SETTLE_MS, async () => {
        states = await this.call('soak.listenerStates()', (page) => page.evaluate(() => soak.listenerStates()));
        return canonical(states) === canonical(expected);
      });
    } catch {
      assert.deepEqual(states, expected, 'a listener shows other posts than the model');
    }
  }

  /** Waits for the page's soak helpers, then checks the session survived: the same user, and no error page. */
  async pageReady(page: Page, what: string): Promise<void> {
    await page.waitForFunction(() => 'soak' in globalThis, undefined, { timeout: ACTION_LIMIT_MS });
    const uid = await this.call('soak.authSettled()', (p) => p.evaluate(() => soak.authSettled()), page);
    assert.equal(uid, this.model.current?.uid ?? null, `${what}: the page restored another user`);
    await this.assertNoErrorPage(page);
  }

  async assertNoErrorPage(page: Page): Promise<void> {
    const overlays = await page.locator('vite-error-overlay').count();
    assert.equal(overlays, 0, `${page.url()} shows Vite's error overlay`);
  }
}
