/**
 * Live mode observes the app's own Realtime Database calls, through the
 * packed packages: the items app's page on `vite dev` with `pyricLive()`, and
 * the same client code as its server job under
 * `node --import @pyric/live/register`. On the default instance and a named
 * one, two users sign in, and the app runs the sequence capture A recorded
 * against production. The chip's Traffic shows each call as production's,
 * from the client that made it, with its path, production's answer and the
 * account: ok writes, reads, a transaction and listener deliveries, and the
 * denied read and write of `/secret`. `.info/connected` makes no row and
 * reaches no server. The host's event stream names the named instance and
 * leaves the default's out, and RTDB calls add nothing to the billed count.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * capture A for this project and custom-token sign-ins. Each plane gets a
 * fresh one, since capture A's push keys and the frames other connections'
 * writes release are played once. The app reaches it with the SDK's own
 * emulator connectors (`?backend=` on the page, `APP_BACKEND` for the server
 * job). Like every app scenario this runs offline, and the browser blocks
 * every host but loopback.
 */
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const PROJECT = 'demo-live-rtdb';
const RUN = '/pyric-live-capture/replay';
const NAMED = `${PROJECT}-named`;
const SIGN_INS = 'sign-ins.json';

declare function runApp(): Promise<unknown>;

interface Received {
  rpc: string;
  as: string | null;
  message: { frame?: { t?: string; d?: { a?: string; b?: { p?: string } } } };
}

interface Replay {
  origin: string;
  received(): Promise<Received[]>;
  /** Every request the replay had no recording for, but the browser SDK's long-poll starts (see `isLongPollStart`). */
  unmatched(): Promise<unknown[]>;
  stop(): Promise<void>;
}

/** Custom-token sign-ins: `client-N` gets an anonymous ID token for `user-N`, the uid capture A's `<uid-N>` becomes. */
function signIns(format: string): Record<string, unknown> {
  const exchanges = [1, 2, 3, 4].flatMap((n) => {
    const uid = `user-${n}`;
    return [{
      kind: 'auth',
      id: `sign-in-${n}`,
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:signInWithCustomToken', body: { token: `client-${n}`, returnSecureToken: true } },
      response: { status: 200, body: { kind: 'identitytoolkit#VerifyCustomTokenResponse', idToken: { $: 'idToken', uid, provider: 'anonymous' }, refreshToken: { $: 'refreshToken' }, expiresIn: '3600', isNewUser: true } },
    }, {
      kind: 'auth',
      id: `lookup-${n}`,
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:lookup', body: { idToken: { $: 'idToken', uid } } },
      response: { status: 200, body: { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: uid, lastLoginAt: '1793907850000', createdAt: '1793907850000' }] } },
    }];
  });
  return { format, project: PROJECT, source: 'hand-written from the Auth REST v1 wire format', exchanges };
}

/** The project's files a user's checkout has: `.firebaserc` names it, and the sign-ins recording the replay plays. */
async function writeProject(app: App): Promise<void> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' } })}\n`);
  app.writeFile(SIGN_INS, `${JSON.stringify(signIns(FORMAT))}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([`${app.dir}/${SIGN_INS}`], undefined, { rtdbCapture: PROJECT }));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints, `the replay server named no origin:\n${server.output}`);
  return {
    origin: endpoints.origin,
    received: () => receivedBy(endpoints.origin) as Promise<Received[]>,
    unmatched: async () => (await unmatchedBy(endpoints.origin)).filter((entry) => !isLongPollStart(entry)),
    stop: () => server.stop(),
  };
}

/**
 * The browser SDK's long-poll start (`GET /.lp?start=t`). A page's SDK marks
 * its WebSocket as failed in localStorage while a connection opens, until it
 * has two answers, so a second connection opened meanwhile tries long polling
 * first. Production would answer it and upgrade; the replay serves the
 * WebSocket only, so the SDK falls back to it and every RTDB frame still
 * crosses the WebSocket the capture recorded.
 */
function isLongPollStart(entry: unknown): boolean {
  const { rpc, request } = entry as { rpc?: string; request?: { method?: string; path?: string } };
  return rpc === 'http' && request?.method === 'GET' && (request.path ?? '').startsWith('/.lp?start=t&');
}

/** What capture A's sequence returns on each instance, as production answered it. */
function expectedResults(): Record<string, unknown> {
  const on = (first: number) => ({
    uids: [`user-${first}`, `user-${first + 1}`],
    get: { n: 1, s: 'alpha' },
    runTransaction: { committed: true, value: 1 },
    onValue: [{ flag: true, n: 2, s: 'alpha' }, { flag: true, n: 3, s: 'alpha' }],
    onChildAdded: true,
    deniedRead: 'Permission denied',
    deniedWrite: 'PERMISSION_DENIED: Permission denied',
    presence: 'offline',
  });
  return { default: on(1), named: on(3) };
}

function resultOf(output: string): Record<string, unknown> {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
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

/** The chip, opened. */
async function openChip(page: Page): Promise<Locator> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  const header = chip.locator('.panel-header [data-chip-live]');
  if (await header.count() === 0) await chip.locator('[data-expand]').click();
  return chip;
}

/** A Traffic row as `<served> <source> <call> <path> <answer> <account>`. */
async function readRows(chip: Locator): Promise<string[]> {
  return chip.locator('[data-traffic-rows] [data-request-row]').evaluateAll((elements) => elements.map((element) => [
    element.querySelector('[data-traffic-row-production]') ? 'production' : 'sandbox',
    element.querySelector('[data-traffic-row-source]')?.getAttribute('data-traffic-row-source') ?? '-',
    (element.querySelector('.c1')?.textContent ?? '').split(' · ').at(-1),
    element.querySelector('.c2')?.textContent ?? '',
    element.querySelector('[data-verdict-production]')?.getAttribute('title') ?? '-',
    element.querySelector('.s2')?.textContent ?? '',
  ].join(' ')));
}

/**
 * Every RTDB row Traffic lists, scoped to all: the list shows the latest 25,
 * so it picks the RTDB filter afresh, which follows new rows again, and loads
 * older rows until there are none.
 */
async function rtdbRows(chip: Locator): Promise<string[]> {
  await chip.locator('[data-chip-tab=traffic]').click();
  await chip.locator('[data-traffic-scope=all]').click();
  const service = chip.locator('[data-request-service]');
  await service.selectOption('');
  await service.selectOption('rtdb');
  const older = chip.locator('[data-request-older]');
  while (await older.count() > 0) await older.click();
  return readRows(chip);
}

/**
 * The rows capture A's sequence makes from `source`, each once however many
 * times it ran: client one's calls and listener deliveries, client two's
 * writes and its read of the presence the onDisconnect wrote.
 */
function expectedRows(source: 'page' | 'node'): string[] {
  const row = (call: string, path: string, answer: 'succeeded' | 'denied', account: string) => `production ${source} rtdb.${call} ${path} Production ${answer} ${account}`;
  return [1, 3].flatMap((first) => {
    const one = `user-${first}`;
    const two = `user-${first + 1}`;
    return [
      row('set', `${RUN}/items/a`, 'succeeded', one),
      row('get', `${RUN}/items/a`, 'succeeded', one),
      row('update', `${RUN}/items/a`, 'succeeded', one),
      row('push', `${RUN}/list`, 'succeeded', one),
      row('runTransaction', `${RUN}/counter`, 'succeeded', one),
      row('onValue', `${RUN}/items/a`, 'succeeded', one),
      row('set', `${RUN}/items/a/n`, 'succeeded', two),
      row('onChildAdded', `${RUN}/list`, 'succeeded', one),
      row('push', `${RUN}/list`, 'succeeded', two),
      row('get', '/secret', 'denied', one),
      row('set', '/secret', 'denied', one),
      row('set', `${RUN}/presence`, 'succeeded', one),
      row('onDisconnect.set', `${RUN}/presence`, 'succeeded', one),
      row('get', `${RUN}/presence`, 'succeeded', two),
    ];
  }).sort();
}

const distinct = (rows: string[]) => [...new Set(rows)].sort();

/** The chip shows each of capture A's calls from `source` once or more, as production's, and nothing else from it. */
async function expectRows(chip: Locator, source: 'page' | 'node'): Promise<void> {
  const expected = expectedRows(source);
  const fromSource = (rows: string[]) => distinct(rows.filter((row) => row.split(' ')[1] === source));
  const rows = await eventually(() => rtdbRows(chip), (all) => JSON.stringify(fromSource(all)) === JSON.stringify(expected), `the RTDB rows from ${source}`);
  assert.deepEqual(rows.filter((row) => row.includes('.info')), [], 'no row for .info');
  // Listener rows are deliveries: two for each listener on each instance.
  const deliveries = rows.filter((row) => row.split(' ')[1] === source && / rtdb\.on(Value|ChildAdded) /.test(row));
  assert.equal(deliveries.length, 8, `two deliveries per listener per instance from ${source}:\n${deliveries.join('\n')}`);
}

interface CapturedEvent { kind?: string; service?: string; method?: string; path?: string; instance?: string; auth?: { uid?: string } | null }

/** The RTDB operations the host's event stream carried, as it wrote them to the session capture. */
function rtdbEvents(app: App): CapturedEvent[] {
  try {
    const capture = JSON.parse(app.readFile('.pyric/last-session.json')) as { events?: CapturedEvent[] };
    return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'rtdb');
  } catch {
    return [];
  }
}

/** Each RTDB data frame the replay received but stats, as `<action> <path>`. */
async function framePaths(replay: Replay): Promise<string[]> {
  const received = (await replay.received()).filter((entry) => entry.rpc === 'rtdb');
  return received.flatMap((entry) => {
    const data = entry.message.frame?.t === 'd' ? entry.message.frame.d : undefined;
    const isStats = data?.a === 's';
    return data && !isStats ? [`${data.a} ${data.b?.p ?? ''}`] : [];
  });
}

/**
 * The observed calls one plane's run sends the host: on each instance, 12
 * calls and two deliveries for each of its two listeners.
 */
const EVENTS_PER_PLANE = 2 * (12 + 4);

/** Users 3 and 4 run on the named instance, users 1 and 2 on the default. */
const NAMED_USERS = new Set(['user-3', 'user-4']);
const DEFAULT_USERS = new Set(['user-1', 'user-2']);

/**
 * The host's RTDB events once at least `atLeast` are written, checked by
 * account: every event of a named-instance user names that instance, and
 * every event of a default-instance user names none.
 */
async function expectInstances(app: App, atLeast: number): Promise<CapturedEvent[]> {
  const events = await eventually(async () => rtdbEvents(app), (all) => all.length >= atLeast, `${atLeast} RTDB events on the host`);
  const uidOf = (event: CapturedEvent) => event.auth?.uid ?? '';
  const named = events.filter((event) => NAMED_USERS.has(uidOf(event)));
  const unnamed = events.filter((event) => DEFAULT_USERS.has(uidOf(event)));
  assert.equal(named.length + unnamed.length, events.length, `every RTDB event names one of the four users:\n${JSON.stringify(events.filter((event) => !NAMED_USERS.has(uidOf(event)) && !DEFAULT_USERS.has(uidOf(event))))}`);
  assert.ok(named.length > 0 && unnamed.length > 0, 'events from both instances');
  assert.deepEqual(named.filter((event) => event.instance !== NAMED), [], `each named-instance event carries ${NAMED}`);
  assert.deepEqual(unnamed.filter((event) => 'instance' in event), [], 'each default-instance event carries no instance');
  return events;
}

/** The replay received capture A's denied read and no frame for `.info`. */
async function expectNoInfoFrames(replay: Replay): Promise<void> {
  const paths = await framePaths(replay);
  assert.ok(paths.some((path) => path === 'g /secret'), `the replay received the denied read:\n${paths.join('\n')}`);
  assert.deepEqual(paths.filter((path) => path.includes('.info')), []);
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

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

export default scenario(async (app) => {
  await writeProject(app);
  const pageReplay = await app.step('start the replay server that plays capture A for the page', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const page = await app.step('the page runs capture A\'s sequence on the default and the named instance, as four users', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(pageReplay.origin)}`);
    const status = () => opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    await eventually(status, (text) => text === 'Ready', 'the page loads its client code').catch((error: Error) => {
      throw new Error(`${error.message}\nconsole:\n${app.browserLog.join('\n')}`);
    });
    assert.deepEqual(await opened.evaluate(() => runApp()), expectedResults());
    return opened;
  });

  await app.step('production answered every frame from capture A, and the page sent nothing for .info', async () => {
    assert.deepEqual(await pageReplay.unmatched(), []);
    await expectNoInfoFrames(pageReplay);
  });

  const chip = await app.step('the chip shows each page call as production\'s, with its path, answer and account', async () => {
    const opened = await openChip(page);
    assert.equal(await opened.locator('.panel-header [data-chip-live]').textContent(), PROJECT);
    await expectRows(opened, 'page');
    return opened;
  });

  await app.step('the host\'s event stream names the named instance and leaves the default\'s out', async () => {
    await expectInstances(app, EVENTS_PER_PLANE);
  });

  await app.step('RTDB calls add nothing to the billed count', async () => {
    assert.deepEqual(await billed(host.url), { reads: 0, writes: 0, deliveries: 0 });
  });

  await pageReplay.stop();
  const nodeReplay = await app.step('start a fresh replay server for the server job', () => startReplay(app));

  await app.step('the server job under @pyric/live/register runs the same sequence, reporting to the dev server', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'client.js'], { env: { APP_BACKEND: nodeReplay.origin }, timeoutMs: 120_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    assert.doesNotMatch(run.output, /net-guard BLOCK/);
    assert.deepEqual(resultOf(run.output), expectedResults());
    assert.deepEqual(await nodeReplay.unmatched(), []);
    await expectNoInfoFrames(nodeReplay);
  });

  await app.step('the chip shows each server job call as production\'s, from Server (client SDK)', async () => {
    await expectRows(chip, 'node');
    const label = await chip.locator('[data-traffic-row-source=node]').first().textContent();
    assert.equal(label, 'Server (client SDK)');
    assert.deepEqual(await billed(host.url), { reads: 0, writes: 0, deliveries: 0 });
  });

  await app.step('the server job\'s events on the host name the named instance and leave the default\'s out too', async () => {
    await expectInstances(app, EVENTS_PER_PLANE * 2);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    assert.deepEqual(await nodeReplay.unmatched(), []);
    await page.close();
    await host.process.stop();
    await nodeReplay.stop();
  });
});
