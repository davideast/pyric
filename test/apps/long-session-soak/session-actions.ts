// The actions that end or add a page or a server: a reload, a second tab, and
// a dev server restart. Each checks the session survived it.
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { inspectedEnv } from './inspector.ts';
import type { SoakMemory } from './memory.ts';
import { sortedEntries, until, within } from './model.ts';
import { ACTION_LIMIT_MS, PROJECT, SETTLE_MS, TAGS, type SoakPage } from './page-api.ts';
import type { Session } from './session.ts';

declare const soak: SoakPage;

const STOP_LIMIT_MS = 30_000;
const START_LIMIT_MS = 90_000;
/** How long Vite's client gets to reload the page once the restarted server answers. */
const RESTART_RELOAD_MS = 30_000;

export async function reload(s: Session): Promise<void> {
  const response = await s.call('page.reload()', (page) => page.reload());
  assert.ok(response?.ok(), `the reload answered ${response?.status()}`);
  s.pageEpoch += 1;
  s.model.listeners.clear();
  await s.pageReady(s.page, 'after a reload');
}

/** A second tab sees the same user and posts, and a write from it reaches the first tab's list. */
export async function secondTab(s: Session, index: number): Promise<void> {
  const tab = await s.app.page(s.host.url);
  s.watchPage(tab);
  try {
    await s.pageReady(tab, 'in a second tab');
    const read = await s.call('soak.allPosts() in the second tab', (p) => p.evaluate(() => soak.allPosts()), tab);
    assert.deepEqual(sortedEntries(read), sortedEntries(s.model.currentPosts()), 'the second tab read other posts');
    const id = `p${index}t`;
    const post = { title: `tab post ${index}`, n: s.random.int(0, 1000), tag: s.random.pick(TAGS) };
    s.note(id);
    await s.call('soak.setPost() in the second tab', (p) => p.evaluate(([i, d]) => soak.setPost(i, d), [id, post] as const), tab);
    s.model.currentPosts().set(id, post);
    await until(`the first tab's list did not show "${post.title}"`, SETTLE_MS, async () => (await s.listedTitles()).includes(post.title));
  } finally {
    await within('closing the second tab', ACTION_LIMIT_MS, tab.close());
  }
}

/** Seconds since `from`, for the restart's note. */
function since(from: number): string {
  return `${((Date.now() - from) / 1000).toFixed(1)}s`;
}

/**
 * Stops the dev server and starts it again on the same port. Vite's client
 * reloads the page when it answers. Each step has its own time limit, so a
 * slow stop or start is not reported as a page that did not reload.
 */
export async function restart(s: Session, memory: SoakMemory, inspectorPort: number): Promise<void> {
  s.restarting = true;
  const port = s.host.port;
  let step = Date.now();
  await memory.heapSnapshot();
  const snapshotTook = since(step);
  memory.closeInspector();
  // Listening from before the stop, since Vite's client can reload the page as soon as the new server answers.
  let loadedAt: number | undefined;
  const onLoad = (): void => { loadedAt ??= Date.now(); };
  const page: Page = s.page;
  page.on('load', onLoad);
  try {
    step = Date.now();
    await within('stopping the dev server', STOP_LIMIT_MS, s.host.process.stop());
    const stopTook = since(step);
    step = Date.now();
    const name = `dev server after restart ${s.servers.length}`;
    s.host = await within('starting the dev server again', START_LIMIT_MS, s.app.devServer({ port, cwd: PROJECT, name, env: inspectedEnv(inspectorPort) }));
    const startTook = since(step);
    s.servers.push(s.host);
    s.serverEpoch += 1;
    s.restarting = false;
    const answered = Date.now();
    // A page Vite's client does not reload is a dead page for a user, so the run fails rather than reloading it.
    await until(`Vite's client did not reload the page after the restarted server answered`, RESTART_RELOAD_MS, async () => loadedAt !== undefined);
    const reloadTook = `${(Math.max(0, loadedAt! - answered) / 1000).toFixed(1)}s`;
    s.note(`snapshot ${snapshotTook}, stop ${stopTook}, start ${startTook}, Vite's client reloaded the page ${reloadTook} after the server answered`);
  } finally {
    page.off('load', onLoad);
  }
  s.pageEpoch += 1;
  s.model.listeners.clear();
  await s.pageReady(s.page, 'after a dev server restart');
}
