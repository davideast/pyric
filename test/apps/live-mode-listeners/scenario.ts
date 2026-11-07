/**
 * Live mode monitors the app's listeners as sandbox mode does, through the
 * packed packages: the rooms app's page on `vite dev` with `pyricLive()`, and
 * its server job under `node --import @pyric/live/register`. The page signs
 * in, listens to the lobby from three components, subscribes to the patio
 * and unsubscribes on each of five renders, and listens to the Realtime
 * Database's scores; the server job listens to the lobby until it stops.
 *
 * Each subscribe and unsubscribe reaches the host as a listener attach or
 * detach with the caller that made it (`/__pyric/capture`). An agent's
 * `pyric sandbox listeners` lists the page's and the server job's active
 * listeners, and `pyric sandbox activity` reports the lobby's duplicate
 * listeners and the patio's churn. The chip's Data view lists the scores listener as a source
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
declare function listenToScores(): Promise<unknown>;

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

/** The incident patterns `sandbox.activity` reports, sorted and unique. */
async function incidentPatterns(app: App): Promise<string[]> {
  const answer = await sandboxMethod(app, 'activity');
  const incidents = (answer.data?.incidents ?? []) as Array<{ pattern: string }>;
  return [...new Set(incidents.map((incident) => incident.pattern))].sort();
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

/** Starts the server job under the live register and waits for its lobby listener. */
async function startServerJob(app: App, replay: Replay): Promise<AppProcess> {
  const job = app.commandProcess('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: { ROOMS_FIRESTORE_HOST: replay.grpc } });
  await job.waitForLog(/^LISTENING /m, { timeoutMs: 60_000 });
  return job;
}

const SERVER_ONLY = ['node firestore rooms/lobby'];

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

  const server = await app.step('the server job under @pyric/live/register listens to the lobby, reporting to the dev server', async () => {
    const job = await startServerJob(app, replay);
    assert.match(job.output, /@pyric\/live\/register: reporting calls to the live host at /);
    assert.match(job.output, new RegExp(`LISTENING ${JSON.stringify(LOBBY).replace(/[{}]/g, '\\$&')}`));
    return job;
  });

  await app.step('the capture holds each attach and detach with the caller that made it', async () => {
    await eventually(() => listenerEvents(host.url).then(lifecycleCounts), (counts) => JSON.stringify(counts) === JSON.stringify(LIFECYCLE), 'the listener events');
  });

  await app.step('pyric sandbox listeners lists the page\'s and the server job\'s active listeners', async () => {
    const expected = ['node firestore rooms/lobby', 'page database /scores', 'page firestore rooms/lobby', 'page firestore rooms/lobby', 'page firestore rooms/lobby'];
    await eventually(() => activeListeners(app), (listed) => JSON.stringify(listed) === JSON.stringify(expected), 'the active listeners');
  });

  await app.step('pyric sandbox activity reports the lobby\'s duplicate listeners and the patio\'s churn', async () => {
    await eventually(() => incidentPatterns(app), (patterns) => patterns.includes('duplicate-listener') && patterns.includes('listener-churn'), 'the incidents');
  });

  await app.step('the chip\'s Data view lists the scores listener as a source, which opens', async () => {
    await openScoresSource(page);
  });

  await app.step('a reload ends the page\'s listeners, leaving the server job\'s', async () => {
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready', undefined, { timeout: 30_000 });
    await listenersAre(app, SERVER_ONLY, 'the listeners after the reload');
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
