/**
 * Live mode refuses a call whose app names another project than the host's,
 * through the packed packages: a rooms page on `vite dev` with
 * `pyricLive({ project })`, and its server job under
 * `node --import @pyric/live/register`. Each holds two Firebase apps, the
 * default one on the host's project and a second whose config names another
 * project, and each app reads the lobby. The read through the second app
 * throws `PYRIC_LIVE_REFUSED` on both planes before the SDK sends anything,
 * so production never hears of it, the host's event stream holds only the
 * host project's calls, and the health report lists only the host's project
 * among the projects the app's calls named.
 *
 * Both planes learn the host's project from the seam that resolved it: the
 * Vite plugin and the register each hand it to the rows they serve
 * (`serveHostProject`). Without that hand-off the second app's read reaches
 * production and the health report lists its project.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * `live-mode-traffic.json`, recorded in the host's project. The app reaches
 * it with the SDK's own emulator connectors (`?backend=` on the page,
 * `ROOMS_*` for the server job). Like every app scenario this runs offline,
 * and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scenario, sleep, type App } from '../driver.ts';

const FIXTURE = fileURLToPath(new URL('../replay/fixtures/live-mode-traffic.json', import.meta.url));
const REFUSED = 'PYRIC_LIVE_REFUSED';
/** The project the app's config names on its second app; nothing serves it. */
const OTHER = 'demo-live-other';

interface Received {
  rpc: string;
  as: string | null;
  message: Record<string, unknown>;
}

interface Replay {
  origin: string;
  grpc: string;
  received(): Promise<Received[]>;
  unmatched(): Promise<unknown[]>;
}

type Settled = { ok: true; value: unknown } | { ok: false; code: string; message: string };

declare function signIn(): Promise<Settled>;
declare function readLobby(name: 'host' | 'other'): Promise<Settled>;

interface Recorded {
  /** The project the recording was made in, and the one `vite.config.js` names. */
  project: string;
  /** The uid production gave each account at sign-in. */
  reader: string;
  writer: string;
}

function recorded(): Recorded {
  const file = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    project: string;
    exchanges: Array<{ request?: { path?: string; body?: { email?: string } }; response?: { body?: { localId?: string } } }>;
  };
  const uidOf = (email: string) => {
    const signIn = file.exchanges.find((exchange) => exchange.request?.path === '/v1/accounts:signInWithPassword' && exchange.request.body?.email === email);
    const uid = signIn?.response?.body?.localId;
    assert.ok(uid, `the recording has no sign-in for ${email}`);
    return uid;
  };
  return { project: file.project, reader: uidOf('reader@example.com'), writer: uidOf('writer@example.com') };
}

/** The checkout's project files: `.firebaserc` names the host's project, as the register resolves it. */
function writeProject(app: App, project: string): void {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: project } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' } })}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([FIXTURE], app.dir));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints?.grpc, `the replay server named no gRPC host:\n${server.output}`);
  return {
    origin: endpoints.origin,
    grpc: endpoints.grpc,
    received: () => receivedBy(endpoints.origin) as Promise<Received[]>,
    unmatched: () => unmatchedBy(endpoints.origin),
  };
}

function resultOf(output: string): Record<string, Settled> {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, Settled>;
}

/** Polls `read` until `check` passes, failing with the last value after `timeoutMs`. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)} after ${timeoutMs / 1000}s`);
    await sleep(200);
  }
}

/** What production received that names the other project's database. */
async function receivedForOther(replay: Replay): Promise<Received[]> {
  const received = await replay.received();
  return received.filter((entry) => JSON.stringify(entry.message ?? {}).includes(`projects/${OTHER}/`));
}

/** The read through the second app threw the project refusal, naming both projects. */
function expectRefused(settled: Settled, project: string, plane: string): void {
  assert.equal(settled.ok, false, `the ${plane}'s read through the ${OTHER} app was refused: ${JSON.stringify(settled)}`);
  const refusal = settled as Extract<Settled, { ok: false }>;
  assert.equal(refusal.code, REFUSED, `the ${plane}'s refusal code: ${JSON.stringify(settled)}`);
  assert.ok(refusal.message.includes(`'${OTHER}'`), `the refusal names the app's project: ${refusal.message}`);
  assert.ok(refusal.message.includes(`'${project}'`), `the refusal names the host's project: ${refusal.message}`);
}

/** A loopback request to the live host. */
async function hostJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.ok(response.ok, `${url} answered ${response.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${url} answered ${response.headers.get('content-type')}: ${text.slice(0, 300)}`);
  }
}

interface CapturedEvent { kind?: string; service?: string; method?: string; caller?: { kind?: string } }

/**
 * The host's Firestore events, from `/__pyric/capture` with the session token
 * `/__pyric/init.json` hands a loopback client; null while the host has not
 * written a capture, or is writing one.
 */
async function firestoreEvents(base: string): Promise<CapturedEvent[] | null> {
  const { sessionToken } = await hostJson<{ sessionToken: string }>(`${base}/__pyric/init.json`);
  const response = await fetch(`${base}/__pyric/capture`, { headers: { 'x-pyric-session-token': sessionToken } });
  if (response.status === 404) return null;
  assert.ok(response.ok, `/__pyric/capture answered ${response.status}`);
  try {
    const capture = JSON.parse(await response.text()) as { events?: CapturedEvent[] };
    return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'firestore');
  } catch {
    return null;
  }
}

/** The client kind (`page` or `node`) of each `getDoc` the capture holds, sorted. Live rows carry no path yet. */
function readsByClient(events: CapturedEvent[] | null): string[] {
  return (events ?? []).filter((event) => event.method === 'getDoc').map((event) => String(event.caller?.kind)).sort();
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  const { project, reader, writer } = recorded();
  writeProject(app, project);
  const replay = await app.step('start the replay server that plays production for the host\'s project', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive({ project }): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${project}\\.`));
    return started;
  });

  const page = await app.step('the page\'s host app reads the lobby, and its other-project app is refused and sends nothing', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting');
    assert.equal(await opened.evaluate(() => document.querySelector('#status')?.textContent), 'Ready');
    assert.deepEqual(await opened.evaluate(() => signIn()), { ok: true, value: reader });
    assert.deepEqual(await opened.evaluate(() => readLobby('host')), { ok: true, value: { name: 'Lobby', open: true, seats: 12 } });
    expectRefused(await opened.evaluate(() => readLobby('other')), project, 'page');
    await sleep(500);
    assert.deepEqual(await receivedForOther(replay), [], 'production received the page\'s other-project read');
    return opened;
  });

  await app.step('the server job under @pyric/live/register does the same: the host app reads, the other-project app is refused', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], {
      env: { ROOMS_AUTH_URL: replay.origin, ROOMS_FIRESTORE_HOST: replay.grpc },
      timeoutMs: 90_000,
    });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${project}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    const result = resultOf(run.output);
    assert.deepEqual(result.signIn, { ok: true, value: writer });
    assert.deepEqual(result.host, { ok: true, value: { name: 'Lobby', open: true, seats: 12 } });
    expectRefused(result.other!, project, 'server job');
    assert.deepEqual(await receivedForOther(replay), [], 'production received the server job\'s other-project read');
  });

  await app.step('production had a recording for every request it received', async () => {
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('the host\'s event stream holds one lobby read from each plane, the host app\'s', async () => {
    // A refused call is never recorded: each plane's one event is its host app's read.
    await eventually(() => firestoreEvents(host.url), (events) => readsByClient(events).length >= 2, 'two getDoc events on the host');
    await sleep(500);
    const events = await eventually(() => firestoreEvents(host.url), (all) => all !== null, 'the host\'s capture');
    assert.deepEqual(readsByClient(events), ['node', 'page'], `one getDoc event per plane:\n${JSON.stringify(events, null, 2)}`);
  });

  await app.step('the health report lists only the host\'s project among the projects the app\'s calls named', async () => {
    const health = await hostJson<{ live?: { projectId: string; configProjectId: string; appProjectIds: string[] } }>(`${host.url}/__pyric/health`);
    assert.ok(health.live, 'the dev server reports live status');
    assert.deepEqual(health.live.appProjectIds, [project]);
    assert.equal(health.live.configProjectId, project);
    assert.equal(health.live.projectId, project);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    await page.close();
    await host.process.stop();
  });
});
