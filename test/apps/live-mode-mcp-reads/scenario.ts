/**
 * On a live host, an agent's data reads go through an open tab of the app,
 * through the packed packages: a rooms page on `vite dev` with
 * `pyricLive({ project })` opens Firestore, the Realtime Database and Cloud
 * Storage and signs its user in, and an agent's editor runs `pyric mcp`
 * over stdio against the dev server (`mcp-call.mjs`).
 *
 * The agent's `firestore_get_document` runs `getDoc` in the page, on the
 * app's own Firestore as the signed-in user, so it answers production's
 * document and the host's event stream holds the read as a live call. A
 * Storage list the agent runs with `pyric storage listAll` lists the bucket
 * through the page the same way (`/__pyric/mcp` carries no Storage tool).
 * Once the page closes, the same read is refused with live mode's code,
 * never answered from the sandbox, and production never received a read
 * without the user's token.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * `live-mode-traffic.json` and a hand-written listing of the default bucket.
 * The app reaches it with the SDK's own emulator connectors (`?backend=` on
 * the page). Like every app scenario this runs offline, and the browser
 * blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { scenario, sessionHeaders, sleep, type App } from '../driver.ts';

const FIXTURE = fileURLToPath(new URL('../replay/fixtures/live-mode-traffic.json', import.meta.url));
const PROJECT = 'demo-live-traffic';
const BUCKET = `${PROJECT}.firebasestorage.app`;
const LISTING = 'storage-listing.json';
const REFUSED = 'PYRIC_LIVE_REFUSED';
const LOBBY = { name: 'Lobby', open: true, seats: 12 };

declare function signIn(): Promise<string>;

interface Received {
  rpc: string;
  as: string | null;
  message: Record<string, unknown>;
}

interface Replay {
  origin: string;
  received(): Promise<Received[]>;
  unmatched(): Promise<unknown[]>;
}

interface ToolBody {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** The default bucket's listing under `uploads/`, as production answers the reader's list. */
function listing(format: string): Record<string, unknown> {
  return {
    format,
    project: PROJECT,
    source: 'hand-written from capture S\'s list exchange (prefix and delimiter query, prefixes and items answer)',
    exchanges: [{
      kind: 'storage',
      id: 'list-uploads',
      as: 'user-reader',
      request: { method: 'GET', bucket: BUCKET, query: { prefix: 'uploads/', delimiter: '/' } },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: { prefixes: [], items: [{ name: 'uploads/a.txt', bucket: BUCKET }] },
      },
    }],
  };
}

async function writeProject(app: App): Promise<void> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' } })}\n`);
  app.writeFile(LISTING, `${JSON.stringify(listing(FORMAT))}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([FIXTURE, `${app.dir}/${LISTING}`]));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints, `the replay server named no origin:\n${server.output}`);
  return {
    origin: endpoints.origin,
    received: () => receivedBy(endpoints.origin) as Promise<Received[]>,
    unmatched: () => unmatchedBy(endpoints.origin),
  };
}

/** One tool call through `pyric mcp --attach` over stdio, as an agent's editor makes it. */
async function mcpCall(app: App, name: string, args: Record<string, unknown>): Promise<ToolBody> {
  const { code, output } = await app.command('node', ['mcp-call.mjs', name, JSON.stringify(args)], { timeoutMs: 60_000 });
  assert.equal(code, 0, output);
  const line = output.split('\n').find((entry) => entry.startsWith('result '));
  assert.ok(line, `no result line:\n${output}`);
  return (JSON.parse(line.slice('result '.length)) as { body: ToolBody }).body;
}

/** Polls `read` until `check` passes, failing with the last value after `timeoutMs`. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)} after ${timeoutMs / 1000}s`);
    await sleep(250);
  }
}

const refused = (body: ToolBody) => JSON.stringify(body.data ?? {}).includes(REFUSED);

interface CapturedEvent { kind?: string; service?: string; method?: string; path?: string; production?: unknown }

/** The host's live Firestore events, from `/__pyric/capture`. */
async function liveFirestoreEvents(app: App, base: string): Promise<CapturedEvent[]> {
  const response = await fetch(`${base}/__pyric/capture`, { headers: sessionHeaders(app, base) });
  if (response.status === 404) return [];
  const capture = await response.json() as { events?: CapturedEvent[] };
  return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'firestore' && event.production !== undefined);
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  await writeProject(app);
  const replay = await app.step('start the replay server that plays production for the host\'s project', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive({ project }): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const page = await app.step('the page opens Firestore, the Realtime Database and Storage, and signs its user in', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting');
    assert.equal(await opened.evaluate(() => document.querySelector('#status')?.textContent), 'Ready');
    assert.equal(await opened.evaluate(() => signIn()), 'user-reader');
    return opened;
  });

  await app.step('an agent\'s firestore_get_document through pyric mcp reads the lobby through the page', async () => {
    const body = await eventually(() => mcpCall(app, 'firestore_get_document', { path: 'rooms/lobby' }), (answer) => !refused(answer), 'the read through the page');
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.deepEqual(body.data, { exists: true, data: LOBBY });
  });

  await app.step('the read shows in the host\'s event stream as a live call', async () => {
    const events = await eventually(() => liveFirestoreEvents(app, host.url), (all) => all.some((event) => event.method === 'getDoc'), 'a live getDoc on the host');
    const read = events.find((event) => event.method === 'getDoc');
    assert.ok(read, JSON.stringify(events));
  });

  await app.step('an agent\'s Storage list through pyric lists the bucket through the page', async () => {
    const run = await app.pyric(['storage', 'listAll', '--prefix', 'uploads']);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /1 objects under uploads/);
    assert.match(run.output, /"uploads\/a\.txt"/);
  });

  await app.step('once the page closes, the same read is refused with live mode\'s code', async () => {
    await page.close();
    const body = await eventually(() => mcpCall(app, 'firestore_get_document', { path: 'rooms/lobby' }), refused, 'the refusal with no tab');
    assert.equal(body.ok, false);
    assert.match(body.summary, /Open the app/);
  });

  await app.step('production never received a read without the user\'s token, and nothing left loopback', async () => {
    const reads = (await replay.received()).filter((entry) => entry.rpc !== 'auth');
    assert.ok(reads.some((entry) => entry.rpc === 'Listen'), 'the replay received the page\'s Listen');
    assert.ok(reads.some((entry) => entry.rpc === 'storage'), 'the replay received the page\'s list');
    assert.deepEqual(reads.filter((entry) => entry.as === null), [], 'every read carried the reader\'s token');
    assert.deepEqual(await replay.unmatched(), []);
    assert.deepEqual(blockedLines(app), []);
    await host.process.stop();
  });
});
