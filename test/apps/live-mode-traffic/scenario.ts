/**
 * Live mode end to end, through the packed packages: the rooms app's page on
 * `vite dev` with `pyricLive()`, its server job under
 * `node --import @pyric/live/register`, and the `pyric-live` command. The
 * page and the server job sign in as two accounts, and each reads, listens,
 * is denied a read and writes. The chip shows every call as production's,
 * from the client that made it, with production's answer, under
 * "Live: <project>" and the billed-call count.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * recorded exchanges: Auth REST, Firestore over WebChannel for the page and
 * over gRPC for the Node build. The app reaches it the way any app reaches a
 * local backend, with the SDK's own emulator connectors in its own code
 * (`?backend=` on the page, `ROOMS_*` for the server job), and live mode
 * passes that config through unchanged. Nothing in pyric, `@pyric/cli` or
 * `@pyric/live` points anywhere: no flag, option or variable of theirs is set.
 *
 * Each call live mode refuses (Cloud Storage, a named database, the Admin
 * SDK, an `@firebase/*` package, pyric's own writes from MCP or a pyric
 * command on the `pyric-live` host) throws pyric's refusal, and the replay
 * server receives nothing for it. Like every app scenario this runs offline,
 * and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const FIXTURE = fileURLToPath(new URL('../replay/fixtures/live-mode-traffic.json', import.meta.url));
const REFUSED = 'PYRIC_LIVE_REFUSED';

interface Received {
  rpc: 'Listen' | 'Write' | 'auth';
  as: string | null;
  message: Record<string, unknown>;
}

interface Replay {
  origin: string;
  grpc: string;
  received(): Promise<Received[]>;
  unmatched(): Promise<unknown[]>;
}

declare function signIn(): Promise<string>;
declare function readLobby(): Promise<unknown>;
declare function readSecret(): Promise<string>;
declare function listenToOpenRooms(): Promise<string[]>;
declare function openGarden(): Promise<string>;
declare function openRooms(): string[];
declare function snapshotCount(): number;
declare const refused: Record<'storage' | 'sdkPackage' | 'namedDatabase', () => Promise<string> | string>;

interface Recorded {
  /** The project the recording was made in: the app's config and `.firebaserc` name it, as a recorded app's would. */
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

function nameProject(app: App, project: string): void {
  const config = JSON.parse(app.readFile('firebase-config.json')) as Record<string, string>;
  app.writeFile('firebase-config.json', `${JSON.stringify({ ...config, projectId: project, authDomain: `${project}.firebaseapp.com` })}\n`);
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: project } })}\n`);
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

/** The server job's environment: its own backend settings, nothing of pyric's. */
function serverJobEnv(replay: Replay): Record<string, string> {
  return { ROOMS_AUTH_URL: replay.origin, ROOMS_FIRESTORE_HOST: replay.grpc };
}

function resultOf(output: string): Record<string, unknown> {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

/** The chip, opened. */
async function openChip(page: Page): Promise<Locator> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  const header = chip.locator('.panel-header [data-chip-live]');
  if (await header.count() === 0) await chip.locator('[data-expand]').click();
  return chip;
}

async function trafficRows(chip: Locator): Promise<Locator> {
  await chip.locator('[data-chip-tab=traffic]').click();
  await chip.locator('[data-traffic-scope=all]').click();
  return chip.locator('[data-traffic-rows] [data-request-row]');
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

/** What a Traffic row shows: who served it, the client that made it, the call, its path and the answer. */
interface TrafficRow {
  served: string | null;
  source: string | null;
  label: string | null;
  text: string;
  answer: string | null;
}

async function readRows(rows: Locator): Promise<TrafficRow[]> {
  return rows.evaluateAll((elements) => elements.map((element) => ({
    served: element.querySelector('[data-traffic-row-production]')?.textContent ?? null,
    source: element.querySelector('[data-traffic-row-source]')?.getAttribute('data-traffic-row-source') ?? null,
    label: element.querySelector('[data-traffic-row-source]')?.textContent ?? null,
    text: element.textContent ?? '',
    answer: element.querySelector('[data-verdict-production]')?.getAttribute('title') ?? null,
  })));
}

type Answer = 'Production succeeded' | 'Production denied';

/** A row for `call` from `source`, served by production with `answer`. */
async function expectRow(rows: Locator, call: string, source: 'page' | 'node', answer: Answer): Promise<void> {
  const fits = (row: TrafficRow) => row.source === source && row.text.includes(call) && row.answer === answer;
  const shown = await eventually(() => readRows(rows), (all) => all.some(fits), `a ${call} row from ${source}`);
  const row = shown.find(fits)!;
  assert.equal(row.served, 'Production', `${call} from ${source} is production's: ${row.text}`);
  assert.equal(row.label, LABELS[source], `${call} names its client: ${row.text}`);
  assert.equal(row.answer, answer, `${call} from ${source} shows production's answer: ${row.text}`);
}

const LABELS = { page: 'This page', node: 'Server (client SDK)' } as const;

async function billedLine(chip: Locator): Promise<string> {
  return (await chip.locator('[data-chip-billed]').first().textContent()) ?? '';
}

/** Nothing reached the replay server while `run` ran, and nothing went to another host. */
async function sendsNothing<T>(app: App, replay: Replay, run: () => Promise<T>): Promise<T> {
  const before = (await replay.received()).length;
  const blockedBefore = blockedLines(app).length;
  const result = await run();
  await sleep(500);
  assert.equal((await replay.received()).length, before, 'the replay server received a request for a refused call');
  assert.deepEqual(blockedLines(app).slice(blockedBefore), [], 'a refused call tried another host');
  return result;
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  const { project, reader, writer } = recorded();
  nameProject(app, project);
  const replay = await app.step('start the replay server that plays production', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${project}\\.`));
    return started;
  });

  const page = await app.step('the page signs in as the reader, reads, listens, is denied a read and writes', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready');
    assert.equal(await opened.evaluate(() => signIn()), reader);
    assert.deepEqual(await opened.evaluate(() => readLobby()), { exists: true, data: { name: 'Lobby', open: true, seats: 12 } });
    assert.deepEqual(await opened.evaluate(() => listenToOpenRooms()), ['lobby']);
    assert.equal(await opened.evaluate(() => readSecret()), 'permission-denied');
    assert.equal(await opened.evaluate(() => openGarden()), 'written');
    await eventually(() => opened.evaluate(() => openRooms()), (rooms) => rooms.includes('garden'), 'the listener lists the garden');
    return opened;
  });

  const serverJob = await app.step('the server job under @pyric/live/register signs in as the writer and does the same, reporting to the dev server', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: serverJobEnv(replay), timeoutMs: 90_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${project}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    const { listened, ...calls } = resultOf(run.output) as { listened: string[][] };
    assert.deepEqual(calls, { uid: writer, read: { name: 'Lobby', open: true, seats: 12 }, denied: 'permission-denied', wrote: 'written' });
    // The SDK may first deliver the lobby from its cache; then production's rooms, then the patio it wrote.
    assert.deepEqual(listened.slice(-2), [['garden', 'lobby'], ['garden', 'lobby', 'patio']]);
    return { deliveries: listened.length };
  });

  await app.step('production answered each client as its own account, and had a recording for every request', async () => {
    const received = await replay.received();
    const streamsAs = (uid: string) => received.filter((entry) => entry.rpc !== 'auth' && entry.as === uid);
    assert.ok(streamsAs(reader).some((entry) => entry.rpc === 'Write'), 'the page wrote as the reader');
    assert.ok(streamsAs(writer).some((entry) => entry.rpc === 'Write'), 'the server job wrote as the writer');
    assert.deepEqual(received.filter((entry) => entry.rpc !== 'auth' && entry.as === null), [], 'every stream ran signed in');
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('the chip shows Live: <project>, the billed count, and each call as production\'s from its client', async () => {
    const chip = await openChip(page);
    assert.equal(await chip.locator('.panel-header [data-chip-live]').textContent(), `Live: ${project}`);
    // Each client's ok read and write, and every snapshot its listener got, the cached and pending ones too.
    const deliveries = await page.evaluate(() => snapshotCount()) + serverJob.deliveries;
    const expected = `Billed calls: 2 reads, 2 writes, ${deliveries} listener deliveries`;
    await eventually(() => billedLine(chip), (line) => line === expected, 'the billed count');
    const rows = await trafficRows(chip);
    for (const source of ['page', 'node'] as const) {
      await expectRow(rows, 'auth.signInWithEmailAndPassword', source, 'Production succeeded');
      await expectRow(rows, 'firestore.getDoc', source, 'Production succeeded');
      await expectRow(rows, 'firestore.getDoc', source, 'Production denied');
      await expectRow(rows, 'firestore.onSnapshot', source, 'Production succeeded');
      await expectRow(rows, 'firestore.setDoc', source, 'Production succeeded');
    }
  });

  await app.step('each call the page makes that live mode refuses throws its refusal and sends nothing', async () => {
    const outcomes = await sendsNothing(app, replay, async () => ({
      storage: await page.evaluate(() => refused.storage()),
      sdkPackage: await page.evaluate(() => refused.sdkPackage()),
      namedDatabase: await page.evaluate(() => refused.namedDatabase()),
    }));
    assert.match(outcomes.storage, new RegExp(`^${REFUSED}: @pyric/live: firebase/storage \\(Cloud Storage\\) is refused in live mode`));
    assert.match(outcomes.sdkPackage, new RegExp(`^${REFUSED}: @pyric/live: @firebase/firestore \\(a Firebase SDK package; apps import firebase/firestore\\) is refused in live mode`));
    assert.match(outcomes.namedDatabase, new RegExp(`^${REFUSED}: @pyric/live: getFirestore with the database "reports" is refused in live mode, from a page`));
  });

  await app.step('each call the server job makes that live mode refuses throws its refusal and sends nothing', async () => {
    const run = await sendsNothing(app, replay, () => app.command('node', ['--import', '@pyric/live/register', 'refusals.mjs'], { timeoutMs: 60_000 }));
    assert.equal(run.code, 0, run.output);
    const outcomes = resultOf(run.output) as Record<string, string>;
    assert.match(outcomes.storage!, new RegExp(`^${REFUSED}: @pyric/live: firebase/storage \\(Cloud Storage\\) is refused in live mode`));
    assert.match(outcomes.admin!, new RegExp(`^${REFUSED}: @pyric/live: firebase-admin/firestore \\(the Admin SDK\\) is refused in live mode`));
    assert.match(outcomes.namedDatabase!, new RegExp(`^${REFUSED}: @pyric/live: getFirestore with the database "reports" is refused in live mode, from a Node process`));
  });

  await app.step('stop the dev server', async () => {
    await page.close();
    await host.process.stop();
  });

  const live = await app.step('start pyric-live: the Node host in live mode', async () => {
    const port = await app.freePort();
    const url = `http://127.0.0.1:${port}`;
    const command = app.commandProcess('node', ['node_modules/.bin/pyric-live', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    await command.waitForLog(new RegExp(`pyric-live: live mode for the Firebase project ${project}\\.`));
    await eventually(() => fetch(`${url}/__pyric/health`).then((response) => response.ok, () => false), Boolean, 'the pyric-live host answers', 90_000);
    return { url, command };
  });

  await app.step('the server job reports to the pyric-live host, and its Hosting page\'s chip shows it as production\'s', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: serverJobEnv(replay), timeoutMs: 90_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: reporting calls to the live host at ${live.url.replace(/[.]/g, '\\.')}`));
    const result = resultOf(run.output) as { uid: string; listened: string[][] };
    assert.equal(result.uid, writer);
    const hosting = await app.page(`${live.url}/`);
    const chip = await openChip(hosting);
    assert.equal(await chip.locator('.panel-header [data-chip-live]').textContent(), `Live: ${project}`);
    const expected = `Billed calls: 1 read, 1 write, ${result.listened.length} listener deliveries`;
    await eventually(() => billedLine(chip), (line) => line === expected, 'the billed count');
    const rows = await trafficRows(chip);
    await expectRow(rows, 'firestore.getDoc', 'node', 'Production succeeded');
    await expectRow(rows, 'firestore.getDoc', 'node', 'Production denied');
    await expectRow(rows, 'firestore.setDoc', 'node', 'Production succeeded');
    await hosting.close();
  });

  await app.step('pyric\'s own writes against the pyric-live host, from an MCP tool and a pyric command, are refused and send nothing', async () => {
    await sendsNothing(app, replay, async () => {
      const mcp = mcpClient(live.url);
      await mcp(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-mode-traffic', version: '0' } });
      await mcp(null, 'notifications/initialized');
      const call = await mcp(2, 'tools/call', { name: 'firestore_create_document', arguments: { path: 'rooms/agent', data: { open: true } } });
      assert.match(JSON.stringify(call), /firestore_create_document from an MCP tool is refused in live mode/);
      const health = await (await fetch(`${live.url}/__pyric/health`)).json() as { instanceId: string };
      const method = await fetch(`${live.url}/__pyric/hosted/method`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: health.instanceId, projectDir: app.dir, key: 'firestore.setDoc', args: { path: 'rooms/cli', data: { open: true } } }),
      });
      const result = await method.json() as { ok: boolean; summary: string; data?: { code?: string } };
      assert.equal(result.ok, false);
      assert.equal(result.data?.code, REFUSED);
      assert.match(result.summary, /firestore\.setDoc from a pyric command is refused in live mode/);
    });
  });

  await app.step('nothing reached any host but loopback, and production answered every request from a recording', async () => {
    assert.deepEqual(blockedLines(app), []);
    assert.deepEqual(await replay.unmatched(), []);
  });
});

/** One JSON-RPC request to the host's MCP route, keeping the session it opened. */
function mcpClient(base: string) {
  let sessionId: string | null = null;
  return async (id: number | null, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId !== null) headers['mcp-session-id'] = sessionId;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== null) body.id = id;
    const response = await fetch(`${base}/__pyric/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    const text = await response.text();
    if (text.length === 0) return null;
    const line = text.split('\n').find((entry) => entry.startsWith('data:')) ?? text;
    return JSON.parse(line.replace(/^data:\s*/, '')) as Record<string, unknown>;
  };
}
