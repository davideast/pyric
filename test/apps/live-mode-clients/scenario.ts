/**
 * Live mode tells its clients apart, through the packed packages: a rooms
 * app's page on `vite dev` with `pyricLive()`, opened in two browser profiles
 * (two browser contexts), and its server job run twice under
 * `node --import @pyric/live/register`. Profile A signs in as the reader in
 * two tabs, profile B as the writer in one; each tab reads a room and listens
 * to the open rooms. Each server run signs in as the reader and reads the
 * room.
 *
 * In the host's capture (`/__pyric/capture`), every call from profile A's
 * tabs carries one `caller.clientId` (the id the profile keeps in
 * `localStorage`) and its tab's own `pageId`; profile B's calls carry another
 * client id; each call's `auth.uid` is its account; the two server runs carry
 * two distinct client ids. `eventScope`, the one rule the chip and Studio
 * scope by, keeps exactly each client's calls and each user's calls.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * `live-mode-traffic.json` over WebChannel for the pages and gRPC for the
 * server runs. Like every app scenario this runs offline, and the browser
 * blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { guardContext, scenario, sleep, type App } from '../driver.ts';

const FIXTURE = fileURLToPath(new URL('../replay/fixtures/live-mode-traffic.json', import.meta.url));
const PROJECT = 'demo-live-traffic';
const READER = 'user-reader';
const WRITER = 'user-writer';
const LOBBY = { name: 'Lobby', open: true, seats: 12 };

declare function signIn(): Promise<string>;
declare function readLobby(): Promise<unknown>;
declare function listenToOpenRooms(): Promise<string[]>;

interface Replay {
  origin: string;
  grpc: string;
  unmatched(): Promise<unknown[]>;
}

interface Caller {
  kind: string;
  pageId?: string;
  clientId?: string;
}

/** A live call's event, as the host's capture holds it. */
interface CapturedEvent {
  id: string;
  kind?: string;
  service?: string;
  method?: string;
  caller?: Caller;
  auth?: { uid: string } | null;
  production?: unknown;
}

type Scope = 'all' | { client?: { kind: string; clientId: string }; user?: string | null };
type EventScope = (event: CapturedEvent, scope: Scope) => boolean;

function writeProject(app: App): void {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' } })}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([FIXTURE], app.dir));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints?.grpc, `the replay server named no gRPC host:\n${server.output}`);
  return { origin: endpoints.origin, grpc: endpoints.grpc, unmatched: () => unmatchedBy(endpoints.origin) };
}

/** Polls `read` until `check` passes, failing with the last value after `timeoutMs`. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value, null, 1)} after ${timeoutMs / 1000}s`);
    await sleep(250);
  }
}

async function hostJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  return await response.json() as T;
}

/** The host's live Firestore call events, from `/__pyric/capture` with the session token `/__pyric/init.json` hands a loopback client. */
async function liveEvents(base: string): Promise<CapturedEvent[]> {
  const { sessionToken } = await hostJson<{ sessionToken: string }>(`${base}/__pyric/init.json`);
  const response = await fetch(`${base}/__pyric/capture`, { headers: { 'x-pyric-session-token': sessionToken } });
  if (response.status === 404) return [];
  assert.equal(response.status, 200, `/__pyric/capture answered ${response.status}`);
  const capture = await response.json() as { events?: CapturedEvent[] };
  return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'firestore' && event.production !== undefined);
}

function resultOf(output: string): Record<string, unknown> {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

/** One tab signs in, reads the lobby and listens to the open rooms, as its account. */
async function useTab(app: App, page: Page, uid: string): Promise<void> {
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
  const status = await page.evaluate(() => document.querySelector('#status')?.textContent ?? '');
  assert.equal(status, 'Ready', `the page's module did not load\nconsole:\n${app.browserLog.join('\n')}`);
  assert.equal(await page.evaluate(() => signIn()), uid);
  assert.deepEqual(await page.evaluate(() => readLobby()), LOBBY);
  assert.ok((await page.evaluate(() => listenToOpenRooms())).includes('lobby'));
}

/** The distinct values of `pick` over `events`, sorted. */
function distinct(events: CapturedEvent[], pick: (event: CapturedEvent) => string | undefined): string[] {
  return [...new Set(events.map(pick).filter((value): value is string => value !== undefined))].sort();
}

/** The ids of `events`, sorted, to compare two selections. */
function ids(events: CapturedEvent[]): string[] {
  return events.map((event) => event.id).sort();
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  writeProject(app);
  const replay = await app.step('start the replay server that plays production for the project', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });
  const pageUrl = (user: string) => `${host.url}/?user=${user}&backend=${encodeURIComponent(replay.origin)}`;

  const tabs = await app.step('profile A signs in as the reader in two tabs, and profile B as the writer in one', async () => {
    const a1 = await app.page(pageUrl('reader'));
    await useTab(app, a1, READER);
    const a2 = await app.page(pageUrl('reader'));
    await useTab(app, a2, READER);
    // A second browser profile: its own context, so its own localStorage.
    const browser = a1.context().browser();
    assert.ok(browser, 'the scenario browser');
    const profileB = await browser.newContext();
    await guardContext(profileB, app.browserLog as string[]);
    await app.watchCrashes(profileB);
    const b1 = await profileB.newPage();
    b1.on('console', (message) => app.browserLog.push(`[profile B console.${message.type()}] ${message.text()}`));
    await b1.goto(pageUrl('writer'));
    await useTab(app, b1, WRITER);
    assert.deepEqual(await replay.unmatched(), []);
    return [a1, a2, b1];
  });

  await app.step("profile A's chip lists this page once and profile B as another client on its Live tab", async () => {
    const chip = tabs[0]!.locator('[data-pyric-runtime-chip-host]');
    await chip.waitFor({ state: 'attached', timeout: 30_000 });
    if (await chip.locator('.panel-header').count() === 0) await chip.locator('[data-expand]').click();
    await chip.locator('[data-chip-tab="sandbox"]').click();
    await chip.locator('[data-live-view]').waitFor({ timeout: 20_000 });
    // Profile A's second tab is the same client as this page; profile B is the one other client.
    const listed = () => chip.locator('[data-live-client]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-live-client')));
    await eventually(listed, (clients) => JSON.stringify(clients) === JSON.stringify(['self', 'browser']), "the Live tab's clients");
  });

  await app.step('the server job under @pyric/live/register reads the room twice, as two processes', async () => {
    for (let run = 0; run < 2; run += 1) {
      const result = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], {
        env: { ROOMS_AUTH_URL: replay.origin, ROOMS_FIRESTORE_HOST: replay.grpc },
        timeoutMs: 90_000,
      });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /@pyric\/live\/register: reporting calls to the live host at /);
      assert.deepEqual(resultOf(result.output), { uid: READER, read: LOBBY });
    }
    assert.deepEqual(await replay.unmatched(), []);
  });

  const events = await app.step('the capture names each profile, tab and server process, and each call\'s account', async () => {
    const all = await eventually(() => liveEvents(host.url), (captured) => {
      const nodeReads = captured.filter((event) => event.caller?.kind === 'node' && event.method === 'getDoc');
      const pageReads = captured.filter((event) => event.caller?.kind === 'page' && event.method === 'getDoc');
      return nodeReads.length >= 2 && pageReads.length >= 3;
    }, 'the page and server reads');

    const pages = all.filter((event) => event.caller?.kind === 'page');
    const readerPages = pages.filter((event) => event.auth?.uid === READER);
    const writerPages = pages.filter((event) => event.auth?.uid === WRITER);
    // Every page call ran as a signed-in account: the reader's or the writer's.
    assert.equal(readerPages.length + writerPages.length, pages.length, JSON.stringify(pages.map((event) => [event.method, event.auth])));

    // Profile A: one client id across its two tabs, which differ in page id.
    const profileA = distinct(readerPages, (event) => event.caller?.clientId);
    assert.equal(profileA.length, 1, `profile A's client ids: ${JSON.stringify(profileA)} callers ${JSON.stringify(all.map((event) => [event.method, event.caller, event.auth?.uid]))}`);
    assert.equal(distinct(readerPages, (event) => event.caller?.pageId).length, 2);
    // Profile B: another client id, one tab.
    const profileB = distinct(writerPages, (event) => event.caller?.clientId);
    assert.equal(profileB.length, 1, `profile B's client ids: ${JSON.stringify(profileB)}`);
    assert.notEqual(profileB[0], profileA[0]);
    assert.equal(distinct(writerPages, (event) => event.caller?.pageId).length, 1);

    // The two server runs: two distinct client ids, each the reader.
    const nodes = all.filter((event) => event.caller?.kind === 'node');
    assert.equal(distinct(nodes, (event) => event.caller?.clientId).length, 2, JSON.stringify(nodes.map((event) => event.caller)));
    for (const event of nodes) assert.equal(event.auth?.uid, READER);
    return all;
  });

  await app.step('eventScope keeps exactly each client\'s calls and each user\'s calls', async () => {
    const internal = pathToFileURL(join(app.dir, 'node_modules/pyric/dist/sandbox/internal/index.js')).href;
    const { eventScope } = await import(internal) as { eventScope: EventScope };
    const clients = distinct(events, (event) => event.caller?.clientId === undefined ? undefined : `${event.caller.kind}\u0000${event.caller.clientId}`);
    assert.equal(clients.length, 4, `two profiles and two processes: ${JSON.stringify(clients)}`);
    for (const key of clients) {
      const [kind, clientId] = key.split('\u0000') as [string, string];
      const scoped = events.filter((event) => eventScope(event, { client: { kind, clientId } }));
      const expected = events.filter((event) => event.caller?.kind === kind && event.caller.clientId === clientId);
      assert.deepEqual(ids(scoped), ids(expected), `client ${kind} ${clientId}`);
      assert.ok(scoped.length > 0);
    }
    for (const user of [READER, WRITER]) {
      const scoped = events.filter((event) => eventScope(event, { user }));
      assert.deepEqual(ids(scoped), ids(events.filter((event) => event.auth?.uid === user)), `user ${user}`);
    }
    // Profile A as the writer: no such calls.
    const profileA = events.find((event) => event.caller?.kind === 'page' && event.auth?.uid === READER)!.caller!;
    assert.deepEqual(events.filter((event) => eventScope(event, { client: { kind: 'page', clientId: profileA.clientId! }, user: WRITER })), []);
    assert.equal(events.filter((event) => eventScope(event, 'all')).length, events.length);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    for (const tab of tabs) await tab.close();
    await host.process.stop();
  });
});
