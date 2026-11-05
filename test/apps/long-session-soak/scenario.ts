// A long session on a real app, to find the crashes and bugs that only show up
// over time. The scenario scaffolds the create-pyric web template, turns on
// the Node host (`pyric({ hosted: true })`, so state lasts through reloads,
// tabs, and restarts, and the dev server holds the sandbox whose memory is
// measured), and adds email accounts, fielded posts, and listeners next to
// the template's own Google sign-in and post form (soak-page.ts).
//
// A seeded script then uses the app for SOAK_MINUTES (default 60): sign-ups,
// sign-ins and sign-outs, Firestore writes, reads, queries and denied writes,
// listeners added and removed, reloads, a second tab, and now and then a dev
// server restart. Every few minutes it compares what the app reads back, its
// own list, and each listener with a model of what the script wrote.
//
// It fails on any crash in the page or the dev server, an error page, a
// state check that does not match, an action that does not settle, or steady
// memory growth in the page's JS heap or the dev server's RSS. A failure
// names the seed, the action index, and the last 20 actions; the whole action
// log and every memory sample are saved under test-results/apps/long-session-soak/.
//
//   SOAK_SEED=<n or word> SOAK_MINUTES=<n> bun test/apps/run.ts long-session-soak
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { scenario, sleep, type App, type DevServer } from '../driver.ts';
import { findProcessCrashes } from '../crash-output.ts';
import {
  ActionLog,
  DEFAULT_MINUTES,
  judgeGrowth,
  pickAction,
  seededRandom,
  soakSettings,
  type Choice,
  type GrowthLimit,
  type MemorySample,
  type Random,
  type SoakSettings,
} from '../soak.ts';

export const slow = true;

/** The runner's limit for this app: the soak's own length, plus room to install, start, and judge it. */
export const timeoutMs = (soakMinutesForTimeout() + 10) * 60_000;

function soakMinutesForTimeout(): number {
  try {
    return soakSettings(process.env).minutes;
  } catch {
    // The scenario reports a bad SOAK_MINUTES when it runs; the runner reads this while loading every app.
    return DEFAULT_MINUTES;
  }
}

const PROJECT = 'my-web';
const RESULTS = join(import.meta.dir, '../../../test-results/apps/long-session-soak');
const TAGS = ['a', 'b', 'c'] as const;
const MAX_ACCOUNTS = 12;
const MANY_POSTS = 15;
const MAX_LISTENERS = 4;
/** Restarts and reloads are gated by action count, not time, so a seed replays the same actions. */
const ACTIONS_BETWEEN_RESTARTS = 600;
const ACTIONS_BETWEEN_RELOADS = 120;
const ACTION_LIMIT_MS = 30_000;
const SETTLE_MS = 10_000;
const MB = 1024 * 1024;
const PAGE_HEAP_LIMIT: GrowthLimit = { floorBytes: 48 * MB, ratio: 1, minSamples: 5 };
const SERVER_RSS_LIMIT: GrowthLimit = { floorBytes: 192 * MB, ratio: 0.75, minSamples: 5 };

interface Account { email: string; password: string | null; uid: string }
interface Post { title: string; n: number | null; tag: string | null }
interface ListenerState { ids: string[] | null; error: string | null }

interface SoakPage {
  authSettled(): Promise<string | null>;
  currentUid(): string | null;
  signUp(email: string, password: string): Promise<string>;
  signIn(email: string, password: string): Promise<string>;
  signOut(): Promise<void>;
  setPost(id: string, data: { title: string; n: number; tag: string }): Promise<void>;
  updatePost(id: string, patch: { n: number; tag: string }): Promise<void>;
  deletePost(id: string): Promise<void>;
  getPost(id: string): Promise<Post | null>;
  allPosts(): Promise<Record<string, Post>>;
  idsWithTag(tag: string): Promise<string[]>;
  idsWithTitle(title: string): Promise<string[]>;
  writeAs(otherUid: string, id: string): Promise<string>;
  listen(key: string, tag: string): void;
  unlisten(key: string): void;
  unlistenAll(): void;
  listenerStates(): Record<string, ListenerState>;
}
declare const soak: SoakPage;

type ActionName =
  | 'sign up' | 'sign in' | 'sign in with Google' | 'sign out'
  | 'add post in the form' | 'set post' | 'update post' | 'delete post' | 'read post' | 'query by tag'
  | 'write as another user' | 'add listener' | 'remove listener'
  | 'reload' | 'second tab' | 'restart dev server' | 'pause';

/** What the script wrote, and so what the app must read back. */
class Model {
  readonly accounts: Account[] = [];
  current: Account | null = null;
  private readonly posts = new Map<string, Map<string, Post>>();
  readonly listeners = new Map<string, string>();

  postsOf(uid: string): Map<string, Post> {
    let posts = this.posts.get(uid);
    if (!posts) this.posts.set(uid, (posts = new Map()));
    return posts;
  }

  currentPosts(): Map<string, Post> {
    assert.ok(this.current, 'the model has no signed-in account');
    return this.postsOf(this.current.uid);
  }

  /** The current account's post ids, sorted, so a pick by index replays. */
  currentIds(): string[] {
    return [...this.currentPosts().keys()].sort();
  }

  idsWithTag(tag: string): string[] {
    return [...this.currentPosts()].filter(([, post]) => post.tag === tag).map(([id]) => id).sort();
  }

  others(): Account[] {
    return this.accounts.filter((account) => account !== this.current);
  }
}

/** Settles `pending` within `ms`, or fails naming the call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

async function until(what: string, ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} within ${ms / 1000}s`);
    await sleep(100);
  }
}

/** A record as JSON with its keys in order, to compare two without regard to insertion order. */
function canonical(record: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortedEntries(record: Record<string, Post> | Map<string, Post>): Array<[string, Post]> {
  const entries = record instanceof Map ? [...record] : Object.entries(record);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

/** The dev server's resident set, from /proc. */
function residentBytes(pid: number | undefined): number | undefined {
  if (pid === undefined) return undefined;
  try {
    const kb = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB$/m)?.[1];
    return kb === undefined ? undefined : Number(kb) * 1024;
  } catch {
    return undefined;
  }
}

/** One soak run: the app, its model, its log, and what it has measured. */
class Soak {
  readonly log = new ActionLog();
  readonly model = new Model();
  readonly pageHeap: MemorySample[] = [];
  readonly serverRss: MemorySample[] = [];
  private readonly random: Random;
  private readonly crashes: string[] = [];
  private readonly servers: DevServer[] = [];
  private pageEpoch = 0;
  private serverEpoch = 0;
  private lastRestart = 0;
  private lastReload = 0;
  private restarting = false;
  private readonly started = Date.now();
  current: number | undefined;

  constructor(
    private readonly app: App,
    private readonly context: BrowserContext,
    private host: DevServer,
    private page: Page,
    readonly settings: SoakSettings,
  ) {
    this.random = seededRandom(settings.seed);
    this.servers.push(host);
    context.on('weberror', (webError) => this.crashes.push(`page error: ${webError.error().stack ?? webError.error().message}`));
    this.watchPage(page);
  }

  private watchPage(page: Page): void {
    page.on('crash', () => this.crashes.push(`the renderer of ${page.url()} crashed`));
  }

  private get seconds(): number {
    return (Date.now() - this.started) / 1000;
  }

  private call<T>(what: string, run: (page: Page) => Promise<T>, page = this.page): Promise<T> {
    return within(what, ACTION_LIMIT_MS, run(page));
  }

  /** The actions open now, with their weights. Each weight reads only the model and the action count. */
  private choices(index: number): Choice<ActionName>[] {
    const { model } = this;
    const signedIn = model.current !== null;
    const posts = signedIn ? model.currentPosts().size : 0;
    const passwordAccounts = model.accounts.filter((account) => account.password !== null).length;
    const when = (condition: boolean, weight: number) => (condition ? weight : 0);
    return [
      { name: 'sign up', weight: when(model.accounts.length < MAX_ACCOUNTS, 3) },
      { name: 'sign in', weight: when(passwordAccounts > 0, 4) },
      { name: 'sign in with Google', weight: when(!signedIn, 3) },
      { name: 'sign out', weight: when(signedIn, 2) },
      { name: 'add post in the form', weight: signedIn ? 4 : 1 },
      { name: 'set post', weight: when(signedIn, posts > MANY_POSTS ? 3 : 8) },
      { name: 'update post', weight: when(posts > 0, 5) },
      { name: 'delete post', weight: when(posts > 0, posts > MANY_POSTS ? 9 : 3) },
      { name: 'read post', weight: when(posts > 0, 5) },
      { name: 'query by tag', weight: when(signedIn, 4) },
      { name: 'write as another user', weight: when(signedIn && model.others().length > 0, 1) },
      { name: 'add listener', weight: when(signedIn && model.listeners.size < MAX_LISTENERS, 2) },
      { name: 'remove listener', weight: when(model.listeners.size > 0, 2) },
      { name: 'reload', weight: when(index - this.lastReload >= ACTIONS_BETWEEN_RELOADS, 0.5) },
      { name: 'second tab', weight: when(signedIn, 0.6) },
      { name: 'restart dev server', weight: when(index - this.lastRestart >= ACTIONS_BETWEEN_RESTARTS, 0.3) },
      { name: 'pause', weight: 1.5 },
    ];
  }

  /** Runs the script until SOAK_MINUTES pass, with a state check and memory samples on their own clocks. */
  async run(): Promise<void> {
    const end = this.started + this.settings.minutes * 60_000;
    let nextCheckpoint = this.started + this.settings.checkpointMs;
    let nextSample = this.started;
    for (let index = 0; Date.now() < end; index += 1) {
      if (Date.now() >= nextSample) {
        await this.sample();
        nextSample = Date.now() + this.settings.sampleMs;
      }
      if (Date.now() >= nextCheckpoint) {
        await this.checkpoint();
        nextCheckpoint = Date.now() + this.settings.checkpointMs;
      }
      const name = pickAction(this.random, this.choices(index));
      this.current = this.log.add(name);
      await this.act(name, index);
      this.assertNoCrash();
      await sleep(this.random.int(100, 600));
    }
    await this.checkpoint();
    await this.sample();
  }

  private assertNoCrash(): void {
    assert.deepEqual(this.crashes, [], 'a page crashed');
    if (!this.restarting) assert.ok(this.host.process.running, `${this.host.process.name} exited on its own`);
  }

  private async act(name: ActionName, index: number): Promise<void> {
    switch (name) {
      case 'sign up': return this.signUp(index);
      case 'sign in': return this.signIn(index);
      case 'sign in with Google': return this.signInWithGoogle(index);
      case 'sign out': return this.signOut();
      case 'add post in the form': return this.addPostInForm(index);
      case 'set post': return this.setPost(index);
      case 'update post': return this.updatePost(index);
      case 'delete post': return this.deletePost(index);
      case 'read post': return this.readPost(index);
      case 'query by tag': return this.queryByTag(index);
      case 'write as another user': return this.writeAsAnotherUser(index);
      case 'add listener': return this.addListener(index);
      case 'remove listener': return this.removeListener(index);
      case 'reload': return this.reload(index);
      case 'second tab': return this.secondTab(index);
      case 'restart dev server': return this.restart(index);
      case 'pause': return sleep(this.random.int(500, 4_000));
    }
  }

  /** An app drops its listeners when the user changes, as the template does for its own. */
  private async dropListeners(): Promise<void> {
    await this.call('soak.unlistenAll()', (page) => page.evaluate(() => soak.unlistenAll()));
    this.model.listeners.clear();
  }

  private async statusText(): Promise<string> {
    return (await this.page.locator('#auth-status').textContent()) ?? '';
  }

  private async untilStatus(pattern: RegExp): Promise<void> {
    await until(`the page did not say ${pattern}`, SETTLE_MS, async () => pattern.test(await this.statusText()));
  }

  private async signUp(index: number): Promise<void> {
    const email = `soak${this.model.accounts.length}@example.com`;
    const password = `password-${index}`;
    await this.dropListeners();
    const uid = await this.call('soak.signUp()', (page) => page.evaluate(([e, p]) => soak.signUp(e, p), [email, password] as const));
    const account = { email, password, uid };
    this.model.accounts.push(account);
    this.model.current = account;
    this.log.note(this.current!, `${email} uid ${uid}`);
    await this.untilStatus(new RegExp(`^Signed in as ${escapeRegExp(email)}$`));
  }

  private async signIn(index: number): Promise<void> {
    const account = this.random.pick(this.model.accounts.filter((candidate) => candidate.password !== null));
    this.log.note(this.current!, account.email);
    await this.dropListeners();
    const uid = await this.call('soak.signIn()', (page) => page.evaluate(([e, p]) => soak.signIn(e, p), [account.email, account.password!] as const));
    assert.equal(uid, account.uid, `signing in as ${account.email} gave another uid`);
    this.model.current = account;
    await this.untilStatus(/^Signed in as /);
  }

  /** The template's own button, through the sandbox's Google dialog: a new account, or one signed in before. */
  private async signInWithGoogle(index: number): Promise<void> {
    const known = this.model.accounts.filter((account) => account.password === null);
    const reuse = known.length > 0 && this.random.next() < 0.6;
    const account = reuse ? this.random.pick(known) : undefined;
    const email = account?.email ?? `google${known.length}@example.com`;
    this.log.note(this.current!, `${email}${reuse ? ' again' : ''}`);
    await this.page.locator('#sign-in').click({ timeout: SETTLE_MS });
    const dialog = this.page.locator('dialog[data-pyric-auth][open]');
    await dialog.waitFor({ state: 'visible', timeout: SETTLE_MS });
    if (account) {
      // The dialog lists the accounts signed in before, as Google's account chooser does.
      await dialog.locator('.ids button', { hasText: email }).click({ timeout: SETTLE_MS });
    } else {
      await dialog.locator('input[type="email"]').fill(email);
      await dialog.locator('button.submit').click({ timeout: SETTLE_MS });
    }
    await this.untilStatus(/^Signed in as /);
    const uid = await this.call('soak.currentUid()', (page) => page.evaluate(() => soak.currentUid()));
    assert.ok(uid, 'the Google sign-in left no current user');
    if (account) assert.equal(uid, account.uid, `signing in with Google as ${email} again gave another uid`);
    const signedIn = account ?? { email, password: null, uid };
    if (!account) this.model.accounts.push(signedIn);
    this.model.current = signedIn;
  }

  private async signOut(): Promise<void> {
    await this.dropListeners();
    await this.page.locator('#sign-out').click({ timeout: SETTLE_MS });
    await this.untilStatus(/^Signed out$/);
    assert.equal(await this.call('soak.currentUid()', (page) => page.evaluate(() => soak.currentUid())), null);
    this.model.current = null;
  }

  /** The template's own form. Signed out, the template's rules deny the write and the page says so. */
  private async addPostInForm(index: number): Promise<void> {
    const title = `form post ${index}`;
    await this.page.locator('#post-title').fill(title, { timeout: SETTLE_MS });
    await this.page.locator('#add-post button[type="submit"]').click({ timeout: SETTLE_MS });
    if (this.model.current === null) {
      await this.untilStatus(/^Denied by rules \(signed out\)/);
      // The template leaves a denied title in the field.
      await this.page.locator('#post-title').fill('', { timeout: SETTLE_MS });
      return;
    }
    await until(`the template's list did not show "${title}"`, SETTLE_MS, async () => (await this.listedTitles()).includes(title));
    const ids = await this.call('soak.idsWithTitle()', (page) => page.evaluate((t) => soak.idsWithTitle(t), title));
    assert.equal(ids.length, 1, `the form added ${ids.length} posts titled "${title}"`);
    this.model.currentPosts().set(ids[0]!, { title, n: null, tag: null });
    this.log.note(this.current!, ids[0]!);
  }

  private async setPost(index: number): Promise<void> {
    const id = `p${index}`;
    const post = { title: `post ${index}`, n: this.random.int(0, 1000), tag: this.random.pick(TAGS) };
    this.log.note(this.current!, `${id} tag ${post.tag}`);
    await this.call('soak.setPost()', (page) => page.evaluate(([i, p]) => soak.setPost(i, p), [id, post] as const));
    this.model.currentPosts().set(id, post);
  }

  private async updatePost(index: number): Promise<void> {
    const id = this.random.pick(this.model.currentIds());
    const patch = { n: this.random.int(0, 1000), tag: this.random.pick(TAGS) };
    this.log.note(this.current!, `${id} tag ${patch.tag}`);
    await this.call('soak.updatePost()', (page) => page.evaluate(([i, p]) => soak.updatePost(i, p), [id, patch] as const));
    const posts = this.model.currentPosts();
    posts.set(id, { ...posts.get(id)!, ...patch });
  }

  private async deletePost(index: number): Promise<void> {
    const id = this.random.pick(this.model.currentIds());
    this.log.note(this.current!, id);
    await this.call('soak.deletePost()', (page) => page.evaluate((i) => soak.deletePost(i), id));
    this.model.currentPosts().delete(id);
  }

  private async readPost(index: number): Promise<void> {
    const id = this.random.pick(this.model.currentIds());
    this.log.note(this.current!, id);
    const read = await this.call('soak.getPost()', (page) => page.evaluate((i) => soak.getPost(i), id));
    assert.deepEqual(read, this.model.currentPosts().get(id), `post ${id} read back differently`);
  }

  private async queryByTag(index: number): Promise<void> {
    const tag = this.random.pick(TAGS);
    this.log.note(this.current!, `tag ${tag}`);
    const ids = await this.call('soak.idsWithTag()', (page) => page.evaluate((t) => soak.idsWithTag(t), tag));
    assert.deepEqual(ids, this.model.idsWithTag(tag), `the query for tag ${tag} returned other posts`);
  }

  private async writeAsAnotherUser(index: number): Promise<void> {
    const other = this.random.pick(this.model.others());
    this.log.note(this.current!, other.email);
    const code = await this.call('soak.writeAs()', (page) => page.evaluate(([u, i]) => soak.writeAs(u, i), [other.uid, `x${index}`] as const));
    assert.equal(code, 'permission-denied', `a write into ${other.email}'s posts was not denied`);
  }

  private async addListener(index: number): Promise<void> {
    const key = `l${index}`;
    const tag = this.random.pick(TAGS);
    this.log.note(this.current!, `${key} tag ${tag}`);
    await this.call('soak.listen()', (page) => page.evaluate(([k, t]) => soak.listen(k, t), [key, tag] as const));
    this.model.listeners.set(key, tag);
    await this.listenersMatch();
  }

  private async removeListener(index: number): Promise<void> {
    const key = this.random.pick([...this.model.listeners.keys()].sort());
    this.log.note(this.current!, key);
    await this.call('soak.unlisten()', (page) => page.evaluate((k) => soak.unlisten(k), key));
    this.model.listeners.delete(key);
  }

  /** Waits for the page's soak helpers, then checks the session survived: the same user, and no error page. */
  private async pageReady(page: Page, what: string): Promise<void> {
    await page.waitForFunction(() => 'soak' in globalThis, undefined, { timeout: ACTION_LIMIT_MS });
    const uid = await this.call('soak.authSettled()', (p) => p.evaluate(() => soak.authSettled()), page);
    assert.equal(uid, this.model.current?.uid ?? null, `${what}: the page restored another user`);
    await this.assertNoErrorPage(page);
  }

  private async assertNoErrorPage(page: Page): Promise<void> {
    const overlays = await page.locator('vite-error-overlay').count();
    assert.equal(overlays, 0, `${page.url()} shows Vite's error overlay`);
  }

  private async reload(index: number): Promise<void> {
    this.lastReload = index;
    const response = await this.call('page.reload()', (page) => page.reload());
    assert.ok(response?.ok(), `the reload answered ${response?.status()}`);
    this.pageEpoch += 1;
    this.model.listeners.clear();
    await this.pageReady(this.page, 'after a reload');
  }

  /** A second tab sees the same user and posts, and a write from it reaches the first tab's list. */
  private async secondTab(index: number): Promise<void> {
    const tab = await this.app.page(this.host.url);
    this.watchPage(tab);
    try {
      await this.pageReady(tab, 'in a second tab');
      const read = await this.call('soak.allPosts() in the second tab', (p) => p.evaluate(() => soak.allPosts()), tab);
      assert.deepEqual(sortedEntries(read), sortedEntries(this.model.currentPosts()), 'the second tab read other posts');
      const id = `p${index}t`;
      const post = { title: `tab post ${index}`, n: this.random.int(0, 1000), tag: this.random.pick(TAGS) };
      this.log.note(this.current!, id);
      await this.call('soak.setPost() in the second tab', (p) => p.evaluate(([i, d]) => soak.setPost(i, d), [id, post] as const), tab);
      this.model.currentPosts().set(id, post);
      await until(`the first tab's list did not show "${post.title}"`, SETTLE_MS, async () => (await this.listedTitles()).includes(post.title));
    } finally {
      await within('closing the second tab', ACTION_LIMIT_MS, tab.close());
    }
  }

  /** Stops the dev server and starts it again on the same port. Vite's client reloads the page when it answers. */
  private async restart(index: number): Promise<void> {
    this.lastRestart = index;
    this.restarting = true;
    const port = this.host.port;
    const reloaded = this.page.waitForEvent('load', { timeout: 90_000 });
    reloaded.catch(() => {});
    await this.host.process.stop();
    this.host = await this.app.devServer({ port, cwd: PROJECT, name: `dev server after restart ${this.servers.length}` });
    this.servers.push(this.host);
    this.serverEpoch += 1;
    this.restarting = false;
    const loaded = await Promise.race([reloaded.then(() => true, () => false), sleep(30_000).then(() => false)]);
    this.log.note(this.current!, loaded ? "Vite's client reloaded the page" : 'reloaded by the script');
    if (!loaded) await this.call('page.reload()', (page) => page.reload());
    this.pageEpoch += 1;
    this.model.listeners.clear();
    await this.pageReady(this.page, 'after a dev server restart');
  }

  private async listedTitles(): Promise<string[]> {
    return (await this.page.locator('#posts li').allTextContents()).sort();
  }

  private async listenersMatch(): Promise<void> {
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

  /** Compares everything the app reads back with the model, and checks the dev servers printed no crash. */
  async checkpoint(): Promise<void> {
    this.log.add('checkpoint');
    for (const server of this.servers) {
      const printed = findProcessCrashes(server.process.output);
      assert.deepEqual(printed.map((crash) => `${crash.kind}: ${crash.message}`), [], `${server.process.name} printed a crash`);
    }
    await this.assertNoErrorPage(this.page);
    const uid = await this.call('soak.currentUid()', (page) => page.evaluate(() => soak.currentUid()));
    assert.equal(uid, this.model.current?.uid ?? null, 'the page has another user than the model');
    if (this.model.current === null) return;
    const read = await this.call('soak.allPosts()', (page) => page.evaluate(() => soak.allPosts()));
    assert.deepEqual(sortedEntries(read), sortedEntries(this.model.currentPosts()), `${this.model.current.email}'s posts read back differently`);
    const titles = [...this.model.currentPosts().values()].map((post) => post.title).sort();
    try {
      await until("the template's list did not match", SETTLE_MS, async () => JSON.stringify(await this.listedTitles()) === JSON.stringify(titles));
    } catch {
      assert.deepEqual(await this.listedTitles(), titles, "the template's own list shows other posts than the model");
    }
    await this.listenersMatch();
  }

  /** One reading of the page's JS heap, after a collection, and of the dev server's RSS. */
  async sample(): Promise<void> {
    const at = this.seconds;
    const session = await this.context.newCDPSession(this.page);
    try {
      await session.send('HeapProfiler.collectGarbage');
      const { usedSize } = await session.send('Runtime.getHeapUsage');
      this.pageHeap.push({ at, epoch: this.pageEpoch, bytes: usedSize });
    } finally {
      await session.detach().catch(() => {});
    }
    const rss = residentBytes(this.host.process.pid);
    if (rss !== undefined) this.serverRss.push({ at, epoch: this.serverEpoch, bytes: rss });
    this.save();
  }

  /** Saves what the page showed when the soak failed: a screenshot and its HTML, open dialogs included. */
  async captureFailure(): Promise<void> {
    mkdirSync(RESULTS, { recursive: true });
    await within('the failure screenshot', 10_000, this.page.screenshot({ path: join(RESULTS, 'soak-failure.png'), fullPage: true })).catch(() => {});
    const html = await within('the failure page HTML', 10_000, this.page.content()).catch((error: unknown) => `could not read the page: ${String(error)}`);
    writeFileSync(join(RESULTS, 'soak-failure.html'), html);
  }

  /** Writes the action log and the memory samples, so a run that stops early keeps them. */
  save(): void {
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(join(RESULTS, 'soak-actions.log'), `${this.log.text()}\n`);
    const memory = { seed: this.settings.seed, minutes: this.settings.minutes, pageHeap: this.pageHeap, serverRss: this.serverRss };
    writeFileSync(join(RESULTS, 'soak-memory.json'), `${JSON.stringify(memory, null, 2)}\n`);
  }
}

/** Scaffolds the web template, turns on the Node host, and wires in soak-page.ts. */
async function scaffold(app: App): Promise<void> {
  await app.step('create-pyric scaffolds the web template', async () => {
    const result = await app.command('node', ['node_modules/create-pyric/dist/bin.js', PROJECT, '--template', 'web']);
    assert.equal(result.code, 0, result.output);
  });
  await app.step('install the scaffolded project', () => app.installProject(PROJECT));
  await app.step('run it on the Node host and add the soak helpers to the template', () => {
    const config = app.readFile(`${PROJECT}/vite.config.ts`);
    const hosted = config.replace('pyric({', 'pyric({\n      hosted: true,');
    assert.notEqual(hosted, config, 'vite.config.ts has no pyric({ to edit');
    app.writeFile(`${PROJECT}/vite.config.ts`, hosted);
    app.writeFile(`${PROJECT}/src/soak-page.ts`, app.readFile('soak-page.ts'));
    const main = app.readFile(`${PROJECT}/src/main.ts`);
    assert.match(main, /^const auth = getAuth\(app\);$/m);
    assert.match(main, /^const db = getFirestore\(app\);$/m);
    app.writeFile(`${PROJECT}/src/main.ts`, `${main}\nimport { installSoak } from './soak-page';\ninstallSoak(auth, db);\n`);
  });
}

/** Each epoch of the page's heap and the dev server's RSS, judged for steady growth. */
function memoryVerdict(run: Soak): { growing: boolean; report: string } {
  const heap = judgeGrowth(run.pageHeap, PAGE_HEAP_LIMIT);
  const rss = judgeGrowth(run.serverRss, SERVER_RSS_LIMIT);
  const report = ['page JS heap:', ...heap.lines, 'dev server RSS:', ...rss.lines].join('\n');
  return { growing: heap.growing || rss.growing, report };
}

async function openApp(app: App, host: DevServer): Promise<Page> {
  const context = await app.browser();
  const banner = new Promise<string>((resolve) => {
    context.on('console', (message) => { if (message.text().startsWith('[pyric sandbox] firebase/*')) resolve(message.text()); });
  });
  const page = await app.page(host.url);
  const text = await within('the sandbox banner', ACTION_LIMIT_MS, banner);
  assert.match(text, /on the dev server/, text);
  await page.waitForFunction(() => 'soak' in globalThis, undefined, { timeout: ACTION_LIMIT_MS });
  assert.equal(await page.evaluate(() => soak.authSettled()), null);
  return page;
}

export default scenario(async (app) => {
  const settings = await app.step('read SOAK_SEED and SOAK_MINUTES', () => soakSettings(process.env));
  console.log(`  long-session-soak: SOAK_SEED=${settings.seed} SOAK_MINUTES=${settings.minutes}`);
  // A restart interrupts the page's connection, and the page posts that to
  // /__pyric/diagnostics. A post made before the new server generation mounts
  // Pyric's routes answers 404, and the page keeps the report in memory.
  app.expectHostError(/^404 POST \/__pyric\/diagnostics$/);
  await scaffold(app);
  const host = await app.step('start the scaffolded project on the Node host', () => app.devServer({ cwd: PROJECT }));
  const page = await app.step('open the app; it runs on the dev server, signed out', () => openApp(app, host));
  const run = new Soak(app, await app.browser(), host, page, settings);
  await app.step(`use the app for ${settings.minutes} minutes (SOAK_SEED=${settings.seed})`, async () => {
    try {
      await run.run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await run.captureFailure();
      // The memory verdict so far, since a run that stops early never reaches the step that judges it.
      const memory = memoryVerdict(run);
      const report = `${run.log.describeFailure(settings.seed, run.current, reason)}\nmemory so far${memory.growing ? ', growing steadily' : ''}:\n${memory.report}`;
      throw new Error(report, { cause: error });
    } finally {
      run.save();
    }
    console.log(`  long-session-soak: ${run.log.entries.length} actions, saved to ${RESULTS}`);
  });
  await app.step("neither the page's heap nor the dev server's RSS grew steadily", () => {
    const { growing, report } = memoryVerdict(run);
    console.log(report.replace(/^/gm, '  '));
    assert.ok(!growing, `memory grew steadily (SOAK_SEED=${settings.seed}):\n${report}`);
  });
});
