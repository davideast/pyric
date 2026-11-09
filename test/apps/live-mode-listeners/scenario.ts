/**
 * Live mode monitors the app's listeners as sandbox mode does, through the
 * packed packages: the rooms app's page on `vite dev` with `pyricLive()`, and
 * its server job under `node --import @pyric/live/register`. The page signs
 * in, listens to the lobby from three components, subscribes to the patio
 * and unsubscribes on each of five renders, and listens to the Realtime
 * Database's scores; the server job renders the halls list as snapshot JSON
 * (a browser SDK writes no query snapshot bundle) and listens to the lobby
 * until it stops; the page resumes the halls from that JSON.
 *
 * Each subscribe and unsubscribe reaches the host as a listener attach or
 * detach with the caller that made it (`/__pyric/capture`), and the resumed
 * halls listener's rows name the halls collection. The resumed halls
 * listener is active while the page keeps it, and not after it unsubscribes. An agent's
 * `pyric sandbox listeners` lists the page's and the server job's active
 * listeners, and `pyric sandbox activity` reports the page's three duplicate
 * lobby listeners, counted apart from the server job's, and the patio's
 * churn. The chip's Data view lists the scores listener as a source
 * the developer can open. A reload ends the page's listeners, so a reloaded
 * page leaves none behind. The server job restarted as `node --watch` restarts
 * it, or killed and started again, leaves one listener, not one per run.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * a recording this scenario writes: the custom-token sign-in, the lobby and
 * patio documents, and the scores the Realtime Database sends. The app
 * reaches it with the SDK's own emulator connectors (`?backend=` on the page,
 * `ROOMS_FIRESTORE_HOST` for the server job). Like every app scenario this
 * runs offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { scenario, sleep, type App, type AppProcess } from '../driver.ts';

const PROJECT = 'demo-live-listeners';
const RECORDING = 'listeners-recording.json';
const DOCUMENTS = `projects/${PROJECT}/databases/(default)/documents`;
const LOBBY = { name: 'Lobby', open: true };
const SCORES = { alice: 3, bob: 5 };
/** The patio component's renders: each subscribes, then unsubscribes. */
const RENDERS = 5;

declare function signIn(): Promise<unknown>;
declare function listenToLobbyThrice(): Promise<unknown[]>;
declare function rerenderPatio(): number;
declare function resumeHalls(rendered: unknown): Promise<number>;
declare function closeHalls(): boolean;
declare function listenToScores(): Promise<unknown>;
declare function readScoresOnce(): Promise<unknown>;
declare function listenToScoreChildren(): Promise<string[]>;
declare function closeScoreChildren(): boolean;
declare function listenToLobbyOnceAfterReload(): Promise<unknown>;
declare function closeReloadedLobby(): boolean;

interface Replay {
  origin: string;
  grpc: string;
  unmatched(): Promise<unknown[]>;
}

/** One document listen as production answers it: the document, then the target's current marker. */
function documentListen(path: string, fields: Record<string, unknown>): Record<string, unknown> {
  const name = `${DOCUMENTS}/${path}`;
  const time = '2026-11-01T08:00:00.000000Z';
  return {
    kind: 'listen',
    id: `listen-${path.replace('/', '-')}`,
    target: { documents: { documents: [name] } },
    batches: [{
      messages: [
        { targetChange: { targetChangeType: 'ADD', targetIds: [{ $: 'targetId' }] } },
        { documentChange: { document: { name, fields, createTime: time, updateTime: time }, targetIds: [{ $: 'targetId' }] } },
        { targetChange: { targetChangeType: 'CURRENT', targetIds: [{ $: 'targetId' }], resumeToken: { $: 'resumeToken' }, readTime: { $: 'readTime' } } },
      ],
    }],
  };
}

/**
 * The halls collection's listen as production answers it: no halls yet, then
 * the target's current marker. The server job renders it and the page
 * resumes it.
 */
function hallsListen(): Record<string, unknown> {
  const structuredQuery = { from: [{ collectionId: 'halls' }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }] };
  return {
    kind: 'listen',
    id: 'listen-halls',
    target: { query: { structuredQuery, parent: DOCUMENTS } },
    batches: [{
      messages: [
        { targetChange: { targetChangeType: 'ADD', targetIds: [{ $: 'targetId' }] } },
        { targetChange: { targetChangeType: 'CURRENT', targetIds: [{ $: 'targetId' }], resumeToken: { $: 'resumeToken' }, readTime: { $: 'readTime' } } },
      ],
    }],
  };
}

/**
 * The recording the replay plays, hand-written from the Auth REST v1,
 * Firestore v1 Listen and Realtime Database wire formats: `client-1` signs
 * in as `user-1`, the lobby and patio documents, and the scores.
 */
function recording(format: string): Record<string, unknown> {
  const uid = 'user-1';
  const instance = `${PROJECT}-default-rtdb`;
  const exchanges = [{
    kind: 'auth',
    id: 'sign-in-1',
    request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:signInWithCustomToken', body: { token: 'client-1', returnSecureToken: true } },
    response: { status: 200, body: { kind: 'identitytoolkit#VerifyCustomTokenResponse', idToken: { $: 'idToken', uid, provider: 'anonymous' }, refreshToken: { $: 'refreshToken' }, expiresIn: '3600', isNewUser: true } },
  }, {
    kind: 'auth',
    id: 'lookup-1',
    request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:lookup', body: { idToken: { $: 'idToken', uid } } },
    response: { status: 200, body: { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: uid, lastLoginAt: '1794000000000', createdAt: '1794000000000' }] } },
  },
  documentListen('rooms/lobby', { name: { stringValue: LOBBY.name }, open: { booleanValue: LOBBY.open } }),
  documentListen('rooms/patio', { name: { stringValue: 'Patio' }, open: { booleanValue: false } }),
  hallsListen(),
  { kind: 'rtdb', id: 'connect', instance, events: [{ t: 'c', d: { t: 'h', d: { ts: { $: 'serverTime' }, v: '5', h: { $: 'host' }, s: { $: 'session' } } } }] },
  {
    kind: 'rtdb',
    id: 'listen-scores',
    instance,
    request: { a: 'q', b: { p: '/scores', h: '' } },
    events: [{ t: 'd', d: { b: { p: 'scores', d: SCORES }, a: 'd' } }],
    reply: { s: 'ok', d: {} },
  }];
  return { format, project: PROJECT, source: 'hand-written from the Auth REST v1, Firestore v1 Listen and Realtime Database wire formats', exchanges };
}

async function startReplay(app: App): Promise<Replay> {
  const { FORMAT } = await import('../replay/format.ts');
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile(RECORDING, `${JSON.stringify(recording(FORMAT))}\n`);
  const server = app.commandProcess('node', replayServerArgs([`${app.dir}/${RECORDING}`], app.dir));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints?.grpc, `the replay server named no gRPC host:\n${server.output}`);
  return {
    origin: endpoints.origin,
    grpc: endpoints.grpc,
    unmatched: async () => (await unmatchedBy(endpoints.origin)).filter((entry) => !isLongPollStart(entry)),
  };
}

/**
 * The browser SDK's long-poll start (`GET /.lp?start=t`), which the replay
 * does not serve: the SDK falls back to the WebSocket.
 */
function isLongPollStart(entry: unknown): boolean {
  const { rpc, request } = entry as { rpc?: string; request?: { method?: string; path?: string } };
  return rpc === 'http' && request?.method === 'GET' && (request.path ?? '').startsWith('/.lp?start=t&');
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

/** A listener event, as the host's capture holds it. */
interface ListenerEvent {
  kind?: string;
  phase?: string;
  target?: string | { path?: string };
  caller?: { kind?: string };
}

/** The host's listener events, from `/__pyric/capture` with the session token `/__pyric/init.json` hands a loopback client. */
async function listenerEvents(base: string): Promise<ListenerEvent[]> {
  const init = await fetch(`${base}/__pyric/init.json`);
  const { sessionToken } = await init.json() as { sessionToken: string };
  const response = await fetch(`${base}/__pyric/capture`, { headers: { 'x-pyric-session-token': sessionToken } });
  if (response.status === 404) return [];
  assert.equal(response.status, 200, `/__pyric/capture answered ${response.status}`);
  const capture = await response.json() as { events?: ListenerEvent[] };
  return (capture.events ?? []).filter((event) => event.kind === 'listener');
}

/** `<caller> <phase> <target> <count>` for each kind of listener event, sorted. */
function lifecycleCounts(events: ListenerEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const target = typeof event.target === 'string' ? event.target : event.target?.path;
    const line = `${event.caller?.kind} ${event.phase} ${target}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, count]) => `${line} ${count}`).sort();
}

/** The listener events the page and the server job make before any reload. */
const LIFECYCLE = [
  'page attach rooms/lobby 3',
  `page attach rooms/patio ${RENDERS}`,
  `page detach rooms/patio ${RENDERS}`,
  'node attach halls 1',
  'node detach halls 1',
  'page attach /scores 1',
  'node attach rooms/lobby 1',
].sort();

/** A sandbox method's answer, as `pyric sandbox <method> --json` prints it. */
interface Answer {
  ok?: boolean;
  data?: Record<string, unknown>;
}

/**
 * One sandbox method through the installed `pyric` command, as an agent runs
 * it against the dev server. The live host's MCP route carries no listener or
 * activity tool, so the command reaches the same methods (`sandbox.listeners`,
 * `sandbox.activity`).
 */
async function sandboxMethod(app: App, method: string): Promise<Answer> {
  const run = await app.pyric(['sandbox', method, '--json'], { timeoutMs: 60_000 });
  assert.equal(run.code, 0, run.output);
  const json = run.output.split('\n').filter((line) => !line.startsWith('pyric: ')).join('\n');
  const answer = JSON.parse(json) as Answer;
  assert.equal(answer.ok, true, run.output);
  return answer;
}

/** `<caller kind> <service> <target>` for each listener `sandbox.listeners` lists as active, sorted. */
async function activeListeners(app: App): Promise<string[]> {
  const answer = await sandboxMethod(app, 'listeners');
  const listeners = (answer.data?.listeners ?? []) as Array<{ id: string; service: string; target: unknown }>;
  return listeners.map((listener) => {
    const target = typeof listener.target === 'string' ? listener.target : (listener.target as { path?: string }).path;
    return `${listener.id.split(':')[0]} ${listener.service} ${target}`;
  }).sort();
}

/** `<pattern> <count>` for each incident `sandbox.activity` reports, sorted and unique. */
async function incidentCounts(app: App): Promise<string[]> {
  const answer = await sandboxMethod(app, 'activity');
  const incidents = (answer.data?.incidents ?? []) as Array<{ pattern: string; count: number }>;
  return [...new Set(incidents.map((incident) => `${incident.pattern} ${incident.count}`))].sort();
}

/** A live call's event, as the host's capture holds it. */
interface CallEvent {
  kind?: string;
  method?: string;
  path?: string;
}

/** `<path>` for each `onSnapshotResume` delivery in the host's capture. */
async function resumedPaths(base: string): Promise<string[]> {
  const init = await fetch(`${base}/__pyric/init.json`);
  const { sessionToken } = await init.json() as { sessionToken: string };
  const response = await fetch(`${base}/__pyric/capture`, { headers: { 'x-pyric-session-token': sessionToken } });
  if (response.status === 404) return [];
  const capture = await response.json() as { events?: CallEvent[] };
  const resumes = (capture.events ?? []).filter((event) => event.kind === 'operation' && event.method === 'onSnapshotResume');
  return resumes.map((event) => event.path ?? '(no path)');
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

/** The chip's Data view lists the scores listener as a source, which opens: each control visible and clickable. */
async function openScoresSource(page: Page): Promise<void> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  if (!await chip.locator('[data-chip-tab=listeners]').isVisible()) await chip.locator('[data-expand]').click();
  await chip.locator('[data-chip-tab=listeners]').click();
  const rows = chip.locator('[data-listener-rows] [data-listener-row]');
  const scores = rows.filter({ has: page.locator('.data-path[title="/scores"]') }).first();
  try {
    await scores.waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    const listed = await rows.locator('.data-path').evaluateAll((paths) => paths.map((path) => path.getAttribute('title')));
    throw new Error(`no visible Data row for /scores; rows: ${JSON.stringify(listed)}`, { cause: error });
  }
  await scores.click();
  await chip.locator('[data-sources-back]').waitFor({ state: 'visible', timeout: 20_000 });
}

/** Starts the server job under the live register and waits for its rendered halls and its lobby listener. */
async function startServerJob(app: App, replay: Replay): Promise<AppProcess> {
  const job = app.commandProcess('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: { ROOMS_FIRESTORE_HOST: replay.grpc } });
  await job.waitForLog(/^HALLS /m, { timeoutMs: 60_000 });
  await job.waitForLog(/^LISTENING /m, { timeoutMs: 60_000 });
  return job;
}

/** The halls snapshot JSON the server job rendered. */
function renderedHalls(job: AppProcess): unknown {
  const line = job.output.split('\n').find((entry) => entry.startsWith('HALLS '));
  assert.ok(line, `no HALLS line:\n${job.output}`);
  return JSON.parse(line.slice('HALLS '.length)) as unknown;
}

const SERVER_ONLY = ['node firestore rooms/lobby'];
/** The page's and the server job's active listeners once each has subscribed, before the page resumes the halls. */
const ACTIVE = ['node firestore rooms/lobby', 'page database /scores', 'page firestore rooms/lobby', 'page firestore rooms/lobby', 'page firestore rooms/lobby'];

/** Waits until `sandbox.listeners` lists exactly `expected`. */
async function listenersAre(app: App, expected: readonly string[], what: string): Promise<void> {
  await eventually(() => activeListeners(app), (listed) => JSON.stringify(listed) === JSON.stringify(expected), what);
}

/** Opens the page and waits for its module. */
async function openPage(app: App, url: string): Promise<Page> {
  const page = await app.page(url);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
  const status = await page.evaluate(() => document.querySelector('#status')?.textContent ?? '');
  assert.equal(status, 'Ready', `the page's module did not load\nconsole:\n${app.browserLog.join('\n')}`);
  return page;
}

export default scenario(async (app) => {
  const replay = await app.step('start the replay server that plays production for the project', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });
  const pageUrl = `${host.url}/?backend=${encodeURIComponent(replay.origin)}`;

  const page = await app.step('the page listens to the lobby three times, re-renders the patio five times, and listens to the scores', async () => {
    const opened = await openPage(app, pageUrl);
    assert.equal(await opened.evaluate(() => signIn()), 'user-1');
    assert.deepEqual(await opened.evaluate(() => listenToLobbyThrice()), [LOBBY, LOBBY, LOBBY]);
    assert.equal(await opened.evaluate(() => rerenderPatio()), RENDERS);
    assert.deepEqual(await opened.evaluate(() => listenToScores()), SCORES);
    return opened;
  });

  const server = await app.step('the server job under @pyric/live/register renders the halls and listens to the lobby, reporting to the dev server', async () => {
    const job = await startServerJob(app, replay);
    assert.match(job.output, /@pyric\/live\/register: reporting calls to the live host at /);
    assert.match(job.output, new RegExp(`LISTENING ${JSON.stringify(LOBBY).replace(/[{}]/g, '\\$&')}`));
    return job;
  });

  await app.step('the capture holds each attach and detach with the caller that made it', async () => {
    await eventually(() => listenerEvents(host.url).then(lifecycleCounts), (counts) => JSON.stringify(counts) === JSON.stringify(LIFECYCLE), 'the listener events');
  });

  await app.step('pyric sandbox listeners lists the page\'s and the server job\'s active listeners', async () => {
    await listenersAre(app, ACTIVE, 'the active listeners');
  });

  await app.step('pyric sandbox activity reports the page\'s three duplicate lobby listeners, apart from the server job\'s, and the patio\'s churn', async () => {
    const counts = await eventually(() => incidentCounts(app), (found) => found.some((line) => line.startsWith('duplicate-listener ')) && found.some((line) => line.startsWith('listener-churn ')), 'the incidents');
    assert.deepEqual(counts.filter((line) => line.startsWith('duplicate-listener ')), ['duplicate-listener 3']);
  });

  await app.step('the page resumes the halls the server rendered, and the resumed listener\'s rows name the halls collection', async () => {
    const rendered = renderedHalls(server);
    assert.equal(await page.evaluate((json) => resumeHalls(json), rendered), 0);
    await eventually(() => resumedPaths(host.url), (paths) => paths.length > 0 && paths.every((path) => path === 'halls'), 'the resumed rows');
  });

  await app.step('pyric sandbox listeners lists the resumed halls listener while it is subscribed, and drops it after unsubscribe', async () => {
    await listenersAre(app, [...ACTIVE, 'page firestore halls'].sort(), 'the listeners with the resumed halls');
    assert.equal(await page.evaluate(() => closeHalls()), true);
    await listenersAre(app, ACTIVE, 'the listeners after the halls closed');
  });

  await app.step('the chip\'s Data view lists the scores listener as a source, which opens', async () => {
    await openScoresSource(page);
  });

  await app.step("Studio's Billable metrics and Listeners subtabs separate Firestore operations from RTDB transfers, track onChildAdded and onlyOnce lifecycles, scope by client, and keep the tab bar visible", async () => {
    const context = await app.browser();
    const fontHosts = /^https:\/\/(use\.typekit\.net|fonts\.googleapis\.com)\//;
    await context.route(fontHosts, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));

    // Exercise browser { onlyOnce: true } and onChildAdded on /scores.
    assert.deepEqual(await page.evaluate(() => readScoresOnce()), SCORES);
    assert.deepEqual(await page.evaluate(() => listenToScoreChildren()), ['alice:3', 'bob:5']);

    const studio = await app.page(`${host.url}/__pyric/ui/traffic?view=billable`);
    const opPanel = studio.locator('[data-pyric-billable-panel="operation"]');
    const bwPanel = studio.locator('[data-pyric-billable-panel="bandwidth"]');
    const metricValue = async (key: string) => (await studio.locator(`[data-pyric-metric-key="${key}"] [data-pyric-metric-value]`).textContent())?.trim() ?? '';

    await studio.locator('[data-pyric-ui="traffic-billable-view"]').waitFor({ timeout: 30_000 });
    const health = await (await fetch(`${host.url}/__pyric/health`)).json() as { live?: { billed?: { reads: number; deliveries: number } } };
    const firestoreBilled = (health.live?.billed?.reads ?? 0) + (health.live?.billed?.deliveries ?? 0);
    await eventually(
      async () => Number(((await opPanel.locator('[data-pyric-metric-key="reads"] [data-pyric-metric-value]').textContent()) ?? '0').replace(/,/g, '')),
      (reads) => reads === firestoreBilled,
      'Operation-metered panel counts Firestore document reads without mixing RTDB callbacks',
    );
    await eventually(
      async () => ({
        deliveries: Number(((await bwPanel.locator('[data-pyric-metric-key="deliveries"] [data-pyric-metric-value]').textContent()) ?? '0').replace(/,/g, '')),
        writes: Number(((await bwPanel.locator('[data-pyric-metric-key="writes"] [data-pyric-metric-value]').textContent()) ?? '0').replace(/,/g, '')),
        removes: Number(((await bwPanel.locator('[data-pyric-metric-key="removes"] [data-pyric-metric-value]').textContent()) ?? '0').replace(/,/g, '')),
      }),
      ({ deliveries, writes, removes }) => deliveries === 4 && writes === 0 && removes === 0,
      'Bandwidth-metered panel counts exact RTDB onValue (1), onlyOnce (1), and onChildAdded (2) deliveries',
    );
    assert.equal(
      (await opPanel.locator('.traffic__metric-source').textContent())?.trim(),
      'Source: observed live requests · Firestore documents and Storage operations, not a Firebase invoice',
    );

    await studio.getByRole('tab', { name: 'Listeners' }).click();
    await studio.locator('[data-pyric-ui="traffic-listeners-view"]').waitFor({ timeout: 30_000 });
    // 5 original listeners + 1 active onChildAdded (/scores); { onlyOnce: true } auto-detached so it is NOT active!
    await eventually(async () => ({
      delivering: await metricValue('delivering'),
      idle: await metricValue('idle'),
    }), ({ delivering, idle }) => delivering === '6' && idle === '0', 'six active Firestore and Database listeners delivering while onlyOnce auto-detached');

    const rows = await studio.locator('[data-pyric-listener-row]').evaluateAll((elements) => elements.map((row) => ({
      target: row.querySelector('[data-col="target"] .traffic__listener-target-text')?.textContent ?? '',
      duplicate: row.querySelector('[data-pyric-listener-duplicate]')?.textContent?.trim() ?? '',
      deliveries: Number((row.querySelector('[data-col="deliveries"]')?.textContent ?? '0').replace(/,/g, '')),
      attached: row.querySelector('[data-col="attached"]')?.textContent?.trim() ?? '',
      service: row.querySelector('[data-col="service"]')?.textContent?.trim() ?? '',
    })));
    const scoresRow = rows.find((row) => row.target === '/scores');
    assert.ok(scoresRow, `expected /scores row in ${JSON.stringify(rows)}`);
    assert.equal(scoresRow.service, 'Database');
    // Both onValue (1 delivery) and onChildAdded (2 deliveries) watch /scores; onlyOnce detached.
    assert.equal(scoresRow.duplicate, '×2');
    assert.equal(scoresRow.deliveries, 3, `/scores combined deliveries: ${scoresRow.deliveries}`);
    for (const row of rows) {
      assert.ok(row.deliveries >= 1, `${row.target} had 0 deliveries`);
      assert.match(row.attached, /^(\d+s|[1-4]m) ago$/, `${row.target} attached label: ${row.attached}`);
    }

    // Close the onChildAdded listener and confirm /scores drops back to ×1 with 1 delivery.
    assert.equal(await page.evaluate(() => closeScoreChildren()), true);
    await eventually(() => metricValue('delivering'), (delivering) => delivering === '5', 'five listeners after onChildAdded detached');

    const from = studio.locator('[data-pyric-traffic-from]');
    const nodeOption = await from.locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).find((value) => value.startsWith('client:node:')),
    );
    assert.ok(nodeOption, 'expected a client:node:* option in the From selector');
    await from.selectOption(nodeOption);
    await eventually(() => metricValue('delivering'), (delivering) => delivering === '1', 'only the server job listener under node scope');
    await from.selectOption('all');
    await eventually(() => metricValue('delivering'), (delivering) => delivering === '5', 'all five listeners under all scope');

    await studio.setViewportSize({ width: 1280, height: 320 });
    await studio.locator('.studio__content').evaluate((element) => {
      element.scrollTop = 300;
    });
    const tabBox = await studio.locator('.traffic__tabs').boundingBox();
    assert.ok(tabBox && tabBox.y >= 0 && tabBox.height > 20, `expected sticky .traffic__tabs to remain visible: ${JSON.stringify(tabBox)}`);

    await studio.locator('[data-pyric-listener-row]').filter({ hasText: '/scores' }).click();
    await studio.locator('[data-pyric-inspector-title]').click();
    await studio.locator('[data-pyric-ui="traffic-listener-page"]').waitFor({ timeout: 30_000 });
    assert.equal(await metricValue('deliveries'), '1');
    assert.equal(await metricValue('snapshot'), '2 documents');

    await studio.close();
    await context.unroute(fontHosts);
  });

  await app.step('a reload ends the page\'s listeners and sweeps any stale tab entries when the reloaded tab subscribes again', async () => {
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready', undefined, { timeout: 30_000 });
    await listenersAre(app, SERVER_ONLY, 'the listeners after the reload');

    // Re-subscribe on the reloaded tab (preserving sessionStorage tabId) and verify Studio shows only the fresh page listener + server listener.
    assert.equal(await page.evaluate(() => signIn()), 'user-1');
    assert.deepEqual(await page.evaluate(() => listenToLobbyOnceAfterReload()), LOBBY);
    await listenersAre(app, ['node firestore rooms/lobby', 'page firestore rooms/lobby'], 'one fresh page listener plus the server listener');

    const context = await app.browser();
    const fontHosts = /^https:\/\/(use\.typekit\.net|fonts\.googleapis\.com)\//;
    await context.route(fontHosts, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const studio = await app.page(`${host.url}/__pyric/ui/traffic?view=listeners`);
    await studio.locator('[data-pyric-ui="traffic-listeners-view"]').waitFor({ timeout: 30_000 });
    await eventually(
      async () => (await studio.locator('[data-pyric-metric-key="delivering"] [data-pyric-metric-value]').textContent())?.trim(),
      (delivering) => delivering === '2',
      'Studio Listeners shows only the server listener and the reloaded tab listener without stale rows',
    );
    await studio.close();
    await context.unroute(fontHosts);

    assert.equal(await page.evaluate(() => closeReloadedLobby()), true);
    await listenersAre(app, SERVER_ONLY, 'the listeners after closing the reloaded page listener');
  });

  const restarted = await app.step('the server job stopped with SIGTERM, as node --watch restarts it, ends its listener, and its next run leaves one', async () => {
    await server.stop();
    assert.match(server.output, /\[driver\] exited on SIGTERM/);
    await listenersAre(app, [], 'the listeners after the job stopped');
    const next = await startServerJob(app, replay);
    await listenersAre(app, SERVER_ONLY, 'the listeners after the restart');
    return next;
  });

  const lastRun = await app.step('a killed server job\'s listener ends when its next run connects', async () => {
    const pid = restarted.pid;
    assert.ok(pid !== undefined, 'the restarted job has no pid');
    process.kill(pid, 'SIGKILL');
    await eventually(async () => restarted.running, (running) => !running, 'the killed job');
    const next = await startServerJob(app, replay);
    await listenersAre(app, SERVER_ONLY, 'the listeners after the killed job ran again');
    return next;
  });

  await app.step('production received only what the recording holds, and nothing reached any host but loopback', async () => {
    assert.deepEqual(await replay.unmatched(), []);
    assert.deepEqual(blockedLines(app), []);
    await lastRun.stop();
    await page.close();
    await host.process.stop();
  });
});
