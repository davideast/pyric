/**
 * Live mode end to end, through the packed packages: the rooms app's page on
 * `vite dev` with `pyricLive()`, its server job under
 * `node --import @pyric/live/register`, and the `pyric-live` command. The
 * page and the server job sign in as two accounts, and each reads, listens,
 * is denied a read and writes. The chip shows every call as production's,
 * from the client that made it, with production's answer, under "pyric" and
 * the project, and the host's health report carries the billed-call count.
 * Its Listeners view lists the
 * page's live listener with its deliveries, and Overview outlines the element
 * the listener's callback changed.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * recorded exchanges: Auth REST, Firestore over WebChannel for the page and
 * over gRPC for the Node build. The app reaches it the way any app reaches a
 * local backend, with the SDK's own emulator connectors in its own code
 * (`?backend=` on the page, `ROOMS_*` for the server job), and live mode
 * passes that config through unchanged. Nothing in pyric, `@pyric/cli` or
 * `@pyric/live` points anywhere: no flag, option or variable of theirs is set.
 *
 * Each call live mode refuses (Cloud Functions, a named database, the Admin
 * SDK, an `@firebase/*` package, pyric's own writes from MCP or a pyric
 * command on the `pyric-live` host) throws pyric's refusal, and the replay
 * server receives nothing for it. So does app code that would skip the live
 * rows: the page importing the SDK file the rows loaded under a cache-busting
 * query, and the server job loading `@google-cloud/firestore` or sending its
 * own `https.request` to Firestore. Like every app scenario this runs offline,
 * and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
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
declare function deliveryCount(): number;
declare function billedDocumentCount(): number;
declare const refused: Record<'functions' | 'sdkPackage' | 'namedDatabase', () => Promise<string> | string> & {
  cacheBusted(variant: 't' | 'amp' | 'encodedName' | 'absolute' | 'absoluteQuery' | 'id' | 'idQuery', root?: string): Promise<string>;
};

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

/** What a Traffic row shows: who served it, the client that made it, the call, its path, the answer and the account. */
interface TrafficRow {
  served: string | null;
  source: string | null;
  label: string | null;
  text: string;
  answer: string | null;
  identity: string | null;
}

async function readRows(rows: Locator): Promise<TrafficRow[]> {
  return rows.evaluateAll((elements) => elements.map((element) => ({
    served: element.querySelector('[data-traffic-row-production]')?.textContent ?? null,
    source: element.querySelector('[data-traffic-row-source]')?.getAttribute('data-traffic-row-source') ?? null,
    label: element.querySelector('[data-traffic-row-source]')?.textContent ?? null,
    text: element.textContent ?? '',
    answer: element.querySelector('[data-verdict-production]')?.getAttribute('title') ?? null,
    identity: element.querySelector('.s2')?.textContent ?? null,
  })));
}

type Answer = 'Production succeeded' | 'Production denied';

/** A row for `call` from `source`, served by production with `answer`, and every such row ran as `account`'s uid. */
async function expectRow(rows: Locator, call: string, source: 'page' | 'node', answer: Answer, account: string): Promise<void> {
  const fits = (row: TrafficRow) => row.source === source && row.text.includes(call) && row.answer === answer;
  const shown = await eventually(() => readRows(rows), (all) => all.some(fits), `a ${call} row from ${source}`);
  const row = shown.find(fits)!;
  assert.equal(row.served, 'Production', `${call} from ${source} is production's: ${row.text}`);
  assert.equal(row.label, LABELS[source], `${call} names its client: ${row.text}`);
  assert.equal(row.answer, answer, `${call} from ${source} shows production's answer: ${row.text}`);
  const identities = shown.filter(fits).map((each) => each.identity);
  assert.deepEqual(identities, identities.map(() => account), `${call} from ${source} ran as ${account}`);
}

const LABELS = { page: 'This page', node: 'Server (client SDK)' } as const;

interface BilledCount {
  reads: number;
  writes: number;
  deliveries: number;
}

/** The host's billed-call count, as its health report carries it. */
async function billed(url: string): Promise<BilledCount | undefined> {
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { live?: { billed?: BilledCount } };
  return health.live?.billed;
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
    const { listened, billedDocuments, ...calls } = resultOf(run.output) as { listened: string[][]; billedDocuments: number };
    // Production's first answer lists the garden the page opened; the listener's last delivery adds the patio this job wrote.
    // The deliveries before and between (from the cache, the pending write, metadata) vary from run to run.
    assert.deepEqual(calls, {
      uid: writer, read: { name: 'Lobby', open: true, seats: 12 }, denied: 'permission-denied', answered: ['garden', 'lobby'], wrote: 'written',
    });
    assert.deepEqual(listened.at(-1), ['garden', 'lobby', 'patio']);
    return { billedDocuments };
  });

  await app.step('production answered each client as its own account, and had a recording for every request', async () => {
    const received = await replay.received();
    const streamsAs = (uid: string) => received.filter((entry) => entry.rpc !== 'auth' && entry.as === uid);
    assert.ok(streamsAs(reader).some((entry) => entry.rpc === 'Write'), 'the page wrote as the reader');
    assert.ok(streamsAs(writer).some((entry) => entry.rpc === 'Write'), 'the server job wrote as the writer');
    assert.deepEqual(received.filter((entry) => entry.rpc !== 'auth' && entry.as === null), [], 'every stream ran signed in');
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('the chip shows the project, the host counts billed calls, and the chip shows each call as production\'s from its client and account', async () => {
    const chip = await openChip(page);
    assert.equal(await chip.locator('.panel-header [data-chip-live]').textContent(), project);
    // Each client's ok read and write, and each document its listener's snapshots changed, at least one for the first.
    // The acknowledgement of each client's write only changes metadata and counts nothing.
    const delivered = await page.evaluate(() => billedDocumentCount()) + serverJob.billedDocuments;
    const expected = { reads: 2, writes: 2, deliveries: delivered };
    await eventually(() => billed(host.url), (count) => JSON.stringify(count) === JSON.stringify(expected), 'the billed count');
    const rows = await trafficRows(chip);
    // The page signed in as the reader and the server job as the writer: each row names its client's account.
    const accounts = { page: reader, node: writer } as const;
    for (const source of ['page', 'node'] as const) {
      const account = accounts[source];
      await expectRow(rows, 'auth.signInWithEmailAndPassword', source, 'Production succeeded', account);
      await expectRow(rows, 'firestore.getDoc', source, 'Production succeeded', account);
      await expectRow(rows, 'firestore.getDoc', source, 'Production denied', account);
      await expectRow(rows, 'firestore.onSnapshot', source, 'Production succeeded', account);
      await expectRow(rows, 'firestore.setDoc', source, 'Production succeeded', account);
    }
  });

  await app.step('the chip\'s Listeners view lists the page\'s live listener with its deliveries, and Overview outlines what it changed', async () => {
    const chip = await openChip(page);
    await chip.locator('[data-chip-tab=listeners]').click();
    // The page's one listener, the open rooms query: one delivery on the row for each time its callback ran.
    const listener = chip.locator('[data-listener-rows] [data-listener-row]').filter({ hasText: 'rooms' });
    const shown = await eventually(
      async () => ({
        callbacks: await page.evaluate(() => deliveryCount()),
        rows: await listener.evaluateAll((rows) => rows.map((row) => ({
          fact: row.querySelector('.listener-fact')?.textContent ?? '',
          text: row.textContent ?? '',
        }))),
      }),
      ({ callbacks, rows }) => rows.length === 1 && callbacks >= 2 && /(\d+) deliver(?:y|ies)/.exec(rows[0]!.fact)?.[1] === String(callbacks),
      'a Listeners row for the open rooms listener with one delivery per callback',
    );
    const row = shown.rows[0]!;
    assert.match(row.text, /Firestore collection/, `the listener names what it listens to: ${row.text}`);
    await chip.locator('[data-listener-mode=overview]').click();
    // The listener's callback rewrote #rooms, so Overview draws its box there, badged with the query.
    const badge = page.locator('[data-pyric-listener-overlay] [data-pyric-listener-badge]').filter({ hasText: 'rooms (query)' });
    await badge.first().waitFor({ state: 'attached', timeout: 20_000 });
    const box = await page.locator('[data-pyric-listener-overlay] [data-pyric-listener-box]').first().boundingBox();
    const rooms = await page.locator('#rooms').boundingBox();
    assert.ok(box && rooms, 'the outline and #rooms are both on the page');
    assert.deepEqual([box.x, box.y, box.width, box.height].map(Math.round), [rooms.x, rooms.y, rooms.width, rooms.height].map(Math.round), 'the outline sits on #rooms');
    await chip.locator('[data-listener-mode=overview]').click();
  });

  await app.step('each call the page makes that live mode refuses throws its refusal and sends nothing', async () => {
    const outcomes = await sendsNothing(app, replay, async () => ({
      functions: await page.evaluate(() => refused.functions()),
      sdkPackage: await page.evaluate(() => refused.sdkPackage()),
      namedDatabase: await page.evaluate(() => refused.namedDatabase()),
      cacheBusted: await page.evaluate(() => refused.cacheBusted('t')),
      trailingAmpersand: await page.evaluate(() => refused.cacheBusted('amp')),
      encodedQueryName: await page.evaluate(() => refused.cacheBusted('encodedName')),
      absolutePath: await page.evaluate((root) => refused.cacheBusted('absolute', root), realpathSync(app.dir)),
      absolutePathQuery: await page.evaluate((root) => refused.cacheBusted('absoluteQuery', root), realpathSync(app.dir)),
      idPath: await page.evaluate((root) => refused.cacheBusted('id', root), realpathSync(app.dir)),
      idPathQuery: await page.evaluate((root) => refused.cacheBusted('idQuery', root), realpathSync(app.dir)),
    }));
    assert.match(outcomes.functions, new RegExp(`^${REFUSED}: @pyric/live: firebase/functions \\(Cloud Functions\\) is refused in live mode`));
    assert.match(outcomes.sdkPackage, new RegExp(`^${REFUSED}: @pyric/live: @firebase/firestore \\(a Firebase SDK package; apps import firebase/firestore\\) is refused in live mode`));
    assert.match(outcomes.namedDatabase, new RegExp(`^${REFUSED}: @pyric/live: getFirestore with the database "reports" is refused in live mode, from a page`));
    // The SDK file the rows loaded, imported again under another URL Vite would serve it at: a second, unwrapped copy.
    const bustedForms = [outcomes.cacheBusted, outcomes.trailingAmpersand, outcomes.encodedQueryName, outcomes.absolutePath, outcomes.absolutePathQuery, outcomes.idPath, outcomes.idPathQuery];
    for (const busted of bustedForms) {
      assert.match(busted, new RegExp(`^${REFUSED}: @pyric/live: @firebase/firestore \\(a Firebase SDK package; apps import firebase/firestore\\) is refused in live mode`));
      assert.match(busted, /under another URL, which gives the page a second copy of the SDK without the live rows' wrapper/);
    }
  });

  await app.step('each call the server job makes that live mode refuses throws its refusal and sends nothing', async () => {
    const run = await sendsNothing(app, replay, () => app.command('node', ['--import', '@pyric/live/register', 'refusals.mjs'], { timeoutMs: 60_000 }));
    assert.equal(run.code, 0, run.output);
    const outcomes = resultOf(run.output) as Record<string, string>;
    assert.match(outcomes.functions!, new RegExp(`^${REFUSED}: @pyric/live: firebase/functions \\(Cloud Functions\\) is refused in live mode`));
    assert.match(outcomes.admin!, new RegExp(`^${REFUSED}: @pyric/live: firebase-admin/firestore \\(the Admin SDK\\) is refused in live mode`));
    assert.match(outcomes.namedDatabase!, new RegExp(`^${REFUSED}: @pyric/live: getFirestore with the database "reports" is refused in live mode, from a Node process`));
    // Google's server Firestore client stops at import, and a raw request to a live row host never opens a socket.
    assert.match(outcomes.cloudFirestore!, /^PYRIC_REAL_SDK_STOPPED: @pyric\/live\/register: stopped loading @google-cloud\/firestore/);
    assert.match(outcomes.cloudFirestore!, /only the installed Firebase SDK reaches production, through @pyric\/live's rows/);
    assert.match(outcomes.httpsRequest!, /^PYRIC_GUARD_BLOCKED: pyric net-guard blocked socket egress to firestore\.googleapis\.com \(Cloud Firestore\): in live mode only the installed Firebase SDK, wrapped by @pyric\/live's rows, reaches this host/);
    assert.match(run.output, /@pyric\/live\/register: net-guard BLOCK firestore\.googleapis\.com \(Cloud Firestore\) via socket/);
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
    const result = resultOf(run.output) as { uid: string; billedDocuments: number };
    assert.equal(result.uid, writer);
    const hosting = await app.page(`${live.url}/`);
    const chip = await openChip(hosting);
    assert.equal(await chip.locator('.panel-header [data-chip-live]').textContent(), project);
    const expected = { reads: 1, writes: 1, deliveries: result.billedDocuments };
    await eventually(() => billed(live.url), (count) => JSON.stringify(count) === JSON.stringify(expected), 'the billed count');
    const rows = await trafficRows(chip);
    await expectRow(rows, 'firestore.getDoc', 'node', 'Production succeeded', writer);
    await expectRow(rows, 'firestore.getDoc', 'node', 'Production denied', writer);
    await expectRow(rows, 'firestore.setDoc', 'node', 'Production succeeded', writer);
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
