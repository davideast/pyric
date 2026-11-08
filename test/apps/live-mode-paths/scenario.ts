/**
 * Live rows name their path and their query's shape, through the packed
 * packages: a rooms app's page on `vite dev` with `pyricLive()`. The page
 * reads a room, lists the open rooms with the most seats first, and listens
 * to every room's messages through a collection group. The project's
 * `firestore.indexes.json` has no index for the list, and production refuses
 * it with `failed-precondition`.
 *
 * Each call's event in the host's capture (`/__pyric/capture`) names its path
 * (the collection group's id for the group), the list's and the listener's
 * query shape (fields and operators, never a value), the documents
 * production billed each delivery for, and the list's `failed-precondition`.
 * `firestore.extractIndexes`, sent the way `pyric mcp`'s `firestore` tool and
 * a pyric command send it (`/__pyric/hosted/method`), turns the captured
 * shape into the index the list needs; the host's `/__pyric/mcp` route has
 * no index tool. The chip's Traffic row for the list opens its index block,
 * which reads the same shape against the project's index file. Production's
 * answer named a missing index, so the event's `detail.failure` reads
 * `missing-index` and the row carries the index badge sandbox rows use.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * `live-mode-traffic.json` for the sign-in and the room, and
 * `live-mode-paths.json` for the two queries. The app reaches it with the
 * SDK's own emulator connectors (`?backend=` on the page). Like every app
 * scenario this runs offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const FIXTURES = ['live-mode-traffic.json', 'live-mode-paths.json'].map((name) => fileURLToPath(new URL(`../replay/fixtures/${name}`, import.meta.url)));
const PROJECT = 'demo-live-traffic';
const MESSAGES = ['rooms/garden/messages/m2', 'rooms/lobby/messages/m1'];
/** The list's shape as the page sends it: its filter's field and operator, its order, and a hash of the filter's value. */
const LIST_SHAPE = { scope: 'collection', filters: [{ field: 'open', op: '==' }], orderBy: [{ field: 'seats', direction: 'desc' }] };

declare function signIn(): Promise<string>;
declare function readLobby(): Promise<unknown>;
declare function listBiggestOpenRooms(): Promise<unknown>;
declare function listenToMessages(): Promise<string[]>;
declare function billedDocumentCount(): number;

interface Replay {
  origin: string;
  unmatched(): Promise<unknown[]>;
}

/** The project's files a user's checkout has: `.firebaserc` names it, and `firebase.json` names the index file. */
function writeProject(app: App): void {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ firestore: { indexes: 'firestore.indexes.json' } })}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs(FIXTURES));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints?.origin, `the replay server named no origin:\n${server.output}`);
  return { origin: endpoints.origin, unmatched: () => unmatchedBy(endpoints.origin) };
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

interface QueryShape {
  scope?: string;
  filters?: Array<{ field: string; op: string }>;
  orderBy?: Array<{ field: string; direction: string }>;
  limit?: boolean;
  fingerprint?: string;
}

/** A live call's event, as the host's capture holds it. */
interface CapturedEvent {
  id: string;
  kind?: string;
  service?: string;
  method?: string;
  path?: string;
  request?: { query?: QueryShape };
  detail?: { failure?: string };
  production?: { outcome?: { status?: string; code?: string }; usage?: Record<string, number>; billedDocuments?: number };
}

/** The host's live call events, from `/__pyric/capture` with the session token `/__pyric/init.json` hands a loopback client. */
async function liveEvents(base: string): Promise<CapturedEvent[]> {
  const { sessionToken } = await hostJson<{ sessionToken: string }>(`${base}/__pyric/init.json`);
  const response = await fetch(`${base}/__pyric/capture`, { headers: { 'x-pyric-session-token': sessionToken } });
  if (response.status === 404) return [];
  assert.equal(response.status, 200, `/__pyric/capture answered ${response.status}`);
  const capture = await response.json() as { events?: CapturedEvent[] };
  return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'firestore' && event.production !== undefined);
}

/** The shape without its fingerprint, which is a salted hash and differs per page. */
function shapeOf(query: QueryShape | undefined): QueryShape | undefined {
  if (query === undefined) return undefined;
  const { fingerprint: _fingerprint, ...shape } = query;
  return shape;
}

/** What a pyric method answers. */
interface Answer {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
}

/** One service method through `/__pyric/hosted/method`, as `pyric mcp`'s service tools and pyric commands send it. */
async function hostedMethod(app: App, base: string, key: string, args: Record<string, unknown>): Promise<Answer> {
  const health = await hostJson<{ instanceId: string }>(`${base}/__pyric/health`);
  const response = await fetch(`${base}/__pyric/hosted/method`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: health.instanceId, projectDir: app.dir, key, args }),
  });
  return await response.json() as Answer;
}

/** The captured shape as `extractIndexes` takes a query: the constraints `getDocs` would, with no values. */
function indexQueryOf(event: CapturedEvent): Record<string, unknown> {
  const shape = event.request?.query ?? {};
  const constraints = [
    ...(shape.filters ?? []).map((filter) => ({ type: 'where', field: filter.field, op: filter.op })),
    ...(shape.orderBy ?? []).map((order) => ({ type: 'orderBy', field: order.field, direction: order.direction })),
  ];
  return { path: event.path, collectionGroup: shape.scope === 'collection-group', constraints };
}

/** The chip's Traffic row for `id` opened, and its index block shown: each visible and clickable. */
async function openIndexBlock(page: Page, id: string): Promise<void> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  if (!await chip.locator('[data-chip-tab=traffic]').isVisible()) await chip.locator('[data-expand]').click();
  await chip.locator('[data-chip-tab=traffic]').click();
  const row = chip.locator(`[data-inspect-request="${id}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  // Production's missing index reads as the index badge, still marked as production's failure.
  await row.locator('.verdict.index-warning[data-verdict-production="failed"]').waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
  await chip.locator('[data-index-details]').first().waitFor({ state: 'visible', timeout: 20_000 });
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

  const { page, deliveries } = await app.step('the page reads a room, lists the open rooms by seats, and listens to every room\'s messages', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
    const status = await opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.equal(status, 'Ready', `the page's module did not load\nconsole:\n${app.browserLog.join('\n')}`);
    assert.equal(await opened.evaluate(() => signIn()), 'user-reader');
    assert.deepEqual(await opened.evaluate(() => readLobby()), { name: 'Lobby', open: true, seats: 12 });
    assert.equal(await opened.evaluate(() => listBiggestOpenRooms()), 'failed-precondition');
    assert.deepEqual(await opened.evaluate(() => listenToMessages()), MESSAGES);
    assert.deepEqual(await replay.unmatched(), []);
    return { page: opened, deliveries: await opened.evaluate(() => billedDocumentCount()) };
  });

  const list = await app.step('the capture names each call\'s path and query shape, never a value, and production\'s failed-precondition', async () => {
    const events = await eventually(() => liveEvents(host.url), (all) => {
      const hasList = all.some((event) => event.method === 'getDocs');
      const delivered = all.filter((event) => event.method === 'onSnapshot').reduce((sum, event) => sum + (event.production?.billedDocuments ?? 0), 0);
      return hasList && delivered >= deliveries;
    }, 'the page\'s Firestore calls');

    const read = events.find((event) => event.method === 'getDoc');
    assert.equal(read?.path, 'rooms/lobby');
    assert.equal(read?.request?.query, undefined);
    assert.deepEqual(read?.production?.usage, { documentReads: 1 });

    const listed = events.find((event) => event.method === 'getDocs');
    assert.ok(listed, 'one getDocs event');
    assert.equal(listed.path, 'rooms');
    assert.deepEqual(shapeOf(listed.request?.query), LIST_SHAPE);
    assert.match(listed.request?.query?.fingerprint ?? '', /^[0-9a-f]{16}$/);
    assert.deepEqual(listed.production?.outcome, { status: 'error', code: 'failed-precondition' });
    // Production's message named the index; the event keeps that reading, never the message.
    assert.equal(listed.detail?.failure, 'missing-index');
    assert.ok(!JSON.stringify(listed).includes('requires an index'), 'the event holds production\'s message');

    const group = events.filter((event) => event.method === 'onSnapshot');
    assert.ok(group.length > 0, 'the listener\'s deliveries');
    for (const delivery of group) {
      assert.equal(delivery.path, 'messages');
      assert.deepEqual(shapeOf(delivery.request?.query), { scope: 'collection-group' });
    }
    // Each delivery carries the documents production billed it for.
    assert.equal(group.reduce((sum, delivery) => sum + (delivery.production?.billedDocuments ?? 0), 0), deliveries);

    // No filter value leaves the page: the captured events never hold the room data or the filter's operand.
    const captured = JSON.stringify(events);
    for (const value of ['Lobby', 'Welcome', 'Doors open at nine', '"value"']) assert.ok(!captured.includes(value), `the capture holds ${value}`);
    return listed;
  });

  await app.step('firestore.extractIndexes, as pyric mcp calls it, turns the captured shape into the index the list needs', async () => {
    const answer = await hostedMethod(app, host.url, 'firestore.extractIndexes', { queries: [indexQueryOf(list)] });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.deepEqual(answer.data?.indexes, [{
      collectionGroup: 'rooms',
      queryScope: 'COLLECTION',
      fields: [{ fieldPath: 'open', order: 'ASCENDING' }, { fieldPath: 'seats', order: 'DESCENDING' }],
    }]);
  });

  await app.step('the chip\'s Traffic row for the list carries the index badge and opens its index block', async () => {
    await openIndexBlock(page, list.id);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    await page.close();
    await host.process.stop();
  });
});
