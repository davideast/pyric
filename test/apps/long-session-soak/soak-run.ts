// One soak run: picks each next action by weight from the model, runs it, and
// on their own clocks checks the app against the model and samples memory.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { sleep, type App, type DevServer } from '../driver.ts';
import { findProcessCrashes } from '../crash-output.ts';
import { ACTIONS_BETWEEN_RESTARTS, latencyReport, pickAction, type Choice, type SoakSettings } from '../soak.ts';
import { SoakMemory } from './memory.ts';
import { sortedEntries, until, within } from './model.ts';
import { ACTIONS_BETWEEN_RELOADS, MANY_POSTS, MAX_ACCOUNTS, MAX_LISTENERS, SETTLE_MS, type ActionName, type SoakPage } from './page-api.ts';
import { reload, restart, secondTab } from './session-actions.ts';
import { Session } from './session.ts';
import * as user from './user-actions.ts';

declare const soak: SoakPage;

const SLOWEST_ACTIONS = 10;

export class Soak {
  readonly session: Session;
  readonly memory: SoakMemory;
  private lastRestart = 0;
  private lastReload = 0;

  constructor(
    app: App,
    context: BrowserContext,
    host: DevServer,
    page: Page,
    readonly settings: SoakSettings,
    private readonly inspectorPort: number,
    takeSnapshots: boolean,
    private readonly results: string,
  ) {
    this.session = new Session(app, context, host, page, settings);
    this.memory = new SoakMemory(this.session, inspectorPort, takeSnapshots, results);
  }

  /** The actions open now, with their weights. Each weight reads only the model and the action count. */
  private choices(index: number): Choice<ActionName>[] {
    const { model } = this.session;
    const signedIn = model.current !== null;
    const posts = signedIn ? model.currentPosts().size : 0;
    const passwordAccounts = model.accounts.filter((account) => account.password !== null).length;
    const restartOpen = index >= this.settings.firstRestartAction && index - this.lastRestart >= ACTIONS_BETWEEN_RESTARTS;
    const when = (condition: boolean, weight: number) => (condition ? weight : 0);
    return [
      { name: 'sign up', weight: when(model.accounts.length < MAX_ACCOUNTS, 3) },
      { name: 'sign in', weight: when(passwordAccounts > 0, 4) },
      { name: 'sign in with Google', weight: when(!signedIn && user.canSignInWithGoogle(this.session), 3) },
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
      { name: 'restart dev server', weight: when(restartOpen, 0.3) },
      { name: 'pause', weight: 1.5 },
    ];
  }

  /** Runs the script until SOAK_MINUTES pass, with a state check and memory samples on their own clocks. */
  async run(): Promise<void> {
    const { session, memory, settings } = this;
    const end = session.started + settings.minutes * 60_000;
    let nextCheckpoint = session.started + settings.checkpointMs;
    let nextPageSample = session.started;
    let nextServerSample = session.started;
    for (let index = 0; Date.now() < end; index += 1) {
      if (Date.now() >= nextPageSample) {
        await memory.samplePage();
        nextPageSample = Date.now() + settings.pageSampleMs;
      }
      if (Date.now() >= nextServerSample) {
        await memory.sampleServer();
        nextServerSample = Date.now() + settings.sampleMs;
        this.save();
      }
      if (Date.now() >= nextCheckpoint) {
        await this.checkpoint();
        nextCheckpoint = Date.now() + settings.checkpointMs;
      }
      const name = pickAction(session.random, this.choices(index));
      session.current = session.log.add(name);
      await this.act(name, index);
      session.log.finish(session.current);
      this.assertNoCrash();
      await sleep(session.random.int(100, 600));
    }
    await this.checkpoint();
    await memory.samplePage();
    await memory.sampleServer();
  }

  private assertNoCrash(): void {
    const { session } = this;
    assert.deepEqual(session.crashes, [], 'a page crashed');
    if (!session.restarting) assert.ok(session.host.process.running, `${session.host.process.name} exited on its own`);
  }

  private async act(name: ActionName, index: number): Promise<void> {
    const s = this.session;
    switch (name) {
      case 'sign up': return user.signUp(s, index);
      case 'sign in': return user.signIn(s);
      case 'sign in with Google': return user.signInWithGoogle(s);
      case 'sign out': return user.signOut(s);
      case 'add post in the form': return user.addPostInForm(s, index);
      case 'set post': return user.setPost(s, index);
      case 'update post': return user.updatePost(s);
      case 'delete post': return user.deletePost(s);
      case 'read post': return user.readPost(s);
      case 'query by tag': return user.queryByTag(s);
      case 'write as another user': return user.writeAsAnotherUser(s, index);
      case 'add listener': return user.addListener(s, index);
      case 'remove listener': return user.removeListener(s);
      case 'reload':
        this.lastReload = index;
        return reload(s);
      case 'second tab': return secondTab(s, index);
      case 'restart dev server':
        this.lastRestart = index;
        return restart(s, this.memory, this.inspectorPort);
      case 'pause': return sleep(s.random.int(500, 4_000));
    }
  }

  /** Compares everything the app reads back with the model, and checks the dev servers printed no crash. */
  async checkpoint(): Promise<void> {
    const s = this.session;
    const index = s.log.add('checkpoint');
    if (this.memory.wantsFirstSnapshot) await this.memory.heapSnapshot();
    for (const server of s.servers) {
      const printed = findProcessCrashes(server.process.output);
      assert.deepEqual(printed.map((crash) => `${crash.kind}: ${crash.message}`), [], `${server.process.name} printed a crash`);
    }
    await s.assertNoErrorPage(s.page);
    const uid = await s.call('soak.currentUid()', (page) => page.evaluate(() => soak.currentUid()));
    assert.equal(uid, s.model.current?.uid ?? null, 'the page has another user than the model');
    if (s.model.current !== null) await this.postsMatch();
    s.log.finish(index);
  }

  private async postsMatch(): Promise<void> {
    const s = this.session;
    const read = await s.call('soak.allPosts()', (page) => page.evaluate(() => soak.allPosts()));
    assert.deepEqual(sortedEntries(read), sortedEntries(s.model.currentPosts()), `${s.model.current!.email}'s posts read back differently`);
    const titles = [...s.model.currentPosts().values()].map((post) => post.title).sort();
    try {
      await until("the template's list did not match", SETTLE_MS, async () => JSON.stringify(await s.listedTitles()) === JSON.stringify(titles));
    } catch {
      assert.deepEqual(await s.listedTitles(), titles, "the template's own list shows other posts than the model");
    }
    await s.listenersMatch();
  }

  /** How long each kind of action took, and the slowest ones. */
  latency(): string[] {
    return latencyReport(this.session.log.entries, SLOWEST_ACTIONS);
  }

  /** Saves what the page showed when the soak failed: a screenshot and its HTML, open dialogs included. */
  async captureFailure(): Promise<void> {
    const { page } = this.session;
    mkdirSync(this.results, { recursive: true });
    await within('the failure screenshot', 10_000, page.screenshot({ path: join(this.results, 'soak-failure.png'), fullPage: true })).catch(() => {});
    const html = await within('the failure page HTML', 10_000, page.content()).catch((error: unknown) => `could not read the page: ${String(error)}`);
    writeFileSync(join(this.results, 'soak-failure.html'), html);
  }

  /** Writes the action log, the latency report, and the memory samples, so a run that stops early keeps them. */
  save(): void {
    const { memory, settings } = this;
    mkdirSync(this.results, { recursive: true });
    writeFileSync(join(this.results, 'soak-actions.log'), `${this.session.log.text()}\n`);
    writeFileSync(join(this.results, 'soak-latency.txt'), `${this.latency().join('\n')}\n`);
    const samples = { seed: settings.seed, minutes: settings.minutes, pageHeap: memory.pageHeap, serverHeap: memory.serverHeap, serverRss: memory.serverRss };
    writeFileSync(join(this.results, 'soak-memory.json'), `${JSON.stringify(samples, null, 2)}\n`);
  }
}
