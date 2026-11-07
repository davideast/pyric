/**
 * Live mode records a `writeBatch` commit, an `onSnapshotResume` listener,
 * a production denial and an AI call, through the packed packages: a rooms
 * app's page on `vite dev` with `pyricLive()`, and its server job under
 * `node --import @pyric/live/register`. The page's reader commits one batch
 * that sets, updates and deletes a room and is denied the secret room, and an
 * app with an App Check token asks AI Logic for content. The server job lists
 * the bookings and resumes a listener from that list
 * (`QuerySnapshot.toJSON()`, whose bundle only the Node build makes: the
 * browser build writes `NOT SUPPORTED` in its place).
 *
 * The host's capture (`/__pyric/capture`) holds the commit as one
 * `writeBatch` event whose usage names two writes and one delete, the
 * resumed listener's deliveries with the documents production billed each
 * for, the denied read with production's `permission-denied`, and the AI call
 * with its model and tokens. The host's health report (`/__pyric/health`)
 * bills the commit as three writes: a delete is a write there. The page then
 * asks a model the project does not serve, and the `vite dev` output holds a
 * block naming the denied read's path, code and uid, and one naming the
 * rejected AI call's model (fields only, not wording).
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * `live-mode-traffic.json` for the sign-in and the denial,
 * `live-mode-rates.json` for the bookings, `live-mode-batch.json` for the
 * commit, and the AI Logic observations. Like every app scenario this runs
 * offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { scenario, sleep, type App } from '../driver.ts';

const FIXTURES = ['live-mode-traffic.json', 'live-mode-rates.json', 'live-mode-batch.json'].map((name) => fileURLToPath(new URL(`../replay/fixtures/${name}`, import.meta.url)));
const PROJECT = 'demo-live-traffic';
const BOOKINGS = ['b1', 'b2', 'b3'];
/** The tokens the AI Logic observation reports for generateContent. */
const AI_TOTAL_TOKENS = 11;
const MODEL = 'gemini-flash-lite-latest';
/** A model no observation served: production answers it 404. */
const UNSERVED_MODEL = 'gemini-not-served';

declare function signIn(): Promise<string>;
declare function commitRooms(): Promise<string>;
declare function readSecret(): Promise<string>;
declare function askAssistant(): Promise<unknown>;
declare function askUnservedModel(): Promise<unknown>;

interface Replay {
  origin: string;
  grpc: string;
  unmatched(): Promise<unknown[]>;
}

/** A live call's event, as the host's capture holds it. */
interface CapturedEvent {
  kind?: string;
  service?: string;
  method?: string;
  path?: string;
  result?: string;
  caller?: { kind?: string };
  production?: { outcome?: { status?: string; code?: string }; usage?: Record<string, number>; billedDocuments?: number };
  observation?: { ai?: { requestedModel?: string; totalTokens?: number } };
}

interface BilledCount {
  reads: number;
  writes: number;
  deliveries: number;
}

function writeProject(app: App): void {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' } })}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs(FIXTURES, app.dir, { ai: true }));
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

/** The host's live call events, from `/__pyric/capture` with the session token `/__pyric/init.json` hands a loopback client. */
async function liveEvents(base: string): Promise<CapturedEvent[]> {
  const { sessionToken } = await hostJson<{ sessionToken: string }>(`${base}/__pyric/init.json`);
  const response = await fetch(`${base}/__pyric/capture`, { headers: { 'x-pyric-session-token': sessionToken } });
  if (response.status === 404) return [];
  assert.equal(response.status, 200, `/__pyric/capture answered ${response.status}`);
  const capture = await response.json() as { events?: CapturedEvent[] };
  return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.production !== undefined);
}

/** The host's billed-call count, as its health report carries it. */
async function billed(url: string): Promise<BilledCount | undefined> {
  const health = await hostJson<{ live?: { billed?: BilledCount } }>(`${url}/__pyric/health`);
  return health.live?.billed;
}

function resultOf(output: string): Record<string, unknown> {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

/** A process's output as lines, with terminal colors taken out. */
function terminalLines(output: string): string[] {
  return output.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
}

/** The `[pyric]` warning block a line of which names `field`: its headline and indented lines; empty when none does. */
function blockNaming(lines: string[], field: string): string[] {
  const at = lines.findIndex((line) => line.includes(field) && (line.includes('[pyric]') || /^ {6}\S/.test(line)));
  if (at === -1) return [];
  let start = at;
  while (start > 0 && !lines[start]!.includes('[pyric]')) start -= 1;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !/^ {6}\S/.test(line));
  return [lines[start]!, ...(end === -1 ? rest : rest.slice(0, end))];
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

  const page = await app.step('the page signs in as the reader', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
    const status = await opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.equal(status, 'Ready', `the page's module did not load\nconsole:\n${app.browserLog.join('\n')}`);
    assert.equal(await opened.evaluate(() => signIn()), 'user-reader');
    return opened;
  });

  await app.step('the batch commit is one writeBatch event, and the health report bills it as three writes', async () => {
    const before = await eventually(() => billed(host.url), (count) => count !== undefined, 'the billed count');
    assert.equal(await page.evaluate(() => commitRooms()), 'committed');
    assert.deepEqual(await replay.unmatched(), []);
    const events = await eventually(() => liveEvents(host.url), (all) => all.some((event) => event.method === 'writeBatch'), 'the writeBatch event');
    const commits = events.filter((event) => event.service === 'firestore' && event.method === 'writeBatch');
    assert.equal(commits.length, 1, JSON.stringify(commits));
    assert.deepEqual(commits[0]!.production?.outcome, { status: 'ok' });
    assert.deepEqual(commits[0]!.production?.usage, { documentWrites: 2, documentDeletes: 1 });
    // The batch's own set, update and delete are not calls of their own.
    assert.deepEqual(events.filter((event) => ['setDoc', 'updateDoc', 'deleteDoc'].includes(event.method ?? '')), []);
    const expected = { ...before!, writes: before!.writes + 3 };
    await eventually(() => billed(host.url), (count) => JSON.stringify(count) === JSON.stringify(expected), 'the billed count after the commit');
  });

  await app.step('the server job\'s resumed listener delivers, each delivery with the documents production billed', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: { BOOKINGS_FIRESTORE_HOST: replay.grpc }, timeoutMs: 90_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    const result = resultOf(run.output) as { bookings: unknown; billedDocuments: number };
    assert.deepEqual(result.bookings, BOOKINGS);
    assert.deepEqual(await replay.unmatched(), []);
    const deliveries = result.billedDocuments;
    const resumed = (events: CapturedEvent[]) => events.filter((event) => event.service === 'firestore' && event.method === 'onSnapshotResume' && event.caller?.kind === 'node');
    const delivered = (events: CapturedEvent[]) => resumed(events).reduce((sum, event) => sum + (event.production?.billedDocuments ?? 0), 0);
    const events = await eventually(() => liveEvents(host.url), (all) => delivered(all) >= deliveries, 'the resumed deliveries');
    assert.ok(resumed(events).length > 0, 'onSnapshotResume deliveries');
    assert.equal(delivered(events), deliveries);
    // The resumed listener's first argument is the Firestore and a bundle, not a query, so its rows name no path yet.
    for (const event of resumed(events)) assert.deepEqual(event.production?.outcome, { status: 'ok' });
  });

  await app.step('the denied read reads as production\'s denial, and the AI call names its model and tokens', async () => {
    assert.equal(await page.evaluate(() => readSecret()), 'permission-denied');
    assert.deepEqual(await page.evaluate(() => askAssistant()), { text: 'pyric', totalTokenCount: AI_TOTAL_TOKENS });
    assert.deepEqual(await replay.unmatched(), []);
    const events = await eventually(() => liveEvents(host.url), (all) => {
      const denied = all.some((event) => event.method === 'getDoc' && event.path === 'rooms/secret');
      return denied && all.some((event) => event.service === 'ai');
    }, 'the denied read and the AI call');
    const denied = events.find((event) => event.method === 'getDoc' && event.path === 'rooms/secret');
    assert.equal(denied?.result, 'deny');
    assert.deepEqual(denied?.production?.outcome, { status: 'error', code: 'permission-denied' });
    const ai = events.filter((event) => event.service === 'ai');
    assert.equal(ai.length, 1, JSON.stringify(ai));
    assert.match(ai[0]!.observation?.ai?.requestedModel ?? '', new RegExp(MODEL));
    assert.equal(ai[0]!.observation?.ai?.totalTokens, AI_TOTAL_TOKENS);
  });

  await app.step('the vite dev output names the denied read and the rejected AI call\'s model', async () => {
    assert.equal(typeof await page.evaluate(() => askUnservedModel()), 'string');
    assert.deepEqual(await replay.unmatched(), []);
    const events = await eventually(() => liveEvents(host.url), (all) => all.some((event) => event.service === 'ai' && event.production?.outcome?.status === 'error'), 'the rejected AI call');
    const rejected = events.find((event) => event.service === 'ai' && event.production?.outcome?.status === 'error');
    assert.equal(rejected?.production?.outcome?.code, 'not_found');
    // Fields only: the call's path, production's code and the uid in one block, and the model in another.
    const lines = () => terminalLines(host.process.output);
    const deniedBlock = () => blockNaming(lines(), 'rooms/secret');
    const aiBlock = () => blockNaming(lines(), UNSERVED_MODEL);
    await eventually(async () => [deniedBlock(), aiBlock()], ([denial, ai]) => denial.length > 0 && ai.length > 0, 'the terminal blocks', 10_000)
      .catch((error: Error) => assert.fail(`${error.message}\nvite dev output:\n${host.process.output}`));
    const denial = deniedBlock().join('\n');
    assert.match(denial, /getDoc/);
    assert.match(denial, /permission-denied/);
    assert.match(denial, /user-reader/);
    assert.match(aiBlock().join('\n'), /not_found|NOT_FOUND|404/i);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    await page.close();
    await host.process.stop();
  });
});
