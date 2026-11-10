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
 * The project's `database.rules.json` governs the default instance, so the
 * host runs each observed call there through the local rules too, and
 * Studio's Traffic opens each one's rules inspector in place: a listener
 * delivery the local rules would allow, an update a rule above it checks
 * against stored siblings the host does not hold, and the denied read of
 * `/secret`, which the local rules would allow, worded as what the local
 * rules would do under production's answer. The chip's rows show the same
 * verdicts: the item set is allowed, the list push the rules have no write
 * rule for is drift, and the denied `/secret` write agrees.
 *
 * The values production answered stay on the host, in memory only. The
 * host's session data route (`/__pyric/live/session-data`) holds each
 * instance's tree as the run left it, under the instance's name: the item
 * after the second user's write, both pushed list entries and the presence
 * the onDisconnect wrote. It holds no Firestore document and nothing from the
 * denied `/secret`, and `.pyric/state/hosted` holds none of those values.
 * Studio's RTDB surface on the live host shows one pill per instance, and
 * each instance's tree read-only, with the values the run observed.
 *
 * Nothing reaches the sandbox until the developer asks. `pyric sandbox
 * seed-from-live` without `--confirm` refuses and writes nothing; with it,
 * it names both instances and `.pyric/state/hosted` holds the trees, with
 * `.pyric/` in `.gitignore`. `--out` exports a seed file. Once the dev
 * server's config switches from `pyricLive()` to `pyric({ hosted: true })`,
 * `pyric database get` reads each instance's seeded tree from that sandbox.
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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { scenario, sessionHeaders, sleep, type App } from '../driver.ts';

const PROJECT = 'demo-live-rtdb';
const RUN = '/pyric-live-capture/replay';
const NAMED = `${PROJECT}-named`;
/** The default instance's name, as the SDK's `getDatabase(app)` reaches it. */
const DEFAULT_INSTANCE = `${PROJECT}-default-rtdb`;
const SIGN_INS = 'sign-ins.json';
const HOSTED_STATE = '.pyric/state/hosted';

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

/**
 * The default instance's local rules: signed-in users read and write under the
 * run folder; an item must keep its `n`, which a partial update can only be
 * checked against with the stored item; the list has no write rule, so the
 * pushes production accepts are drift; and signed-in users may read
 * `/secret`, which production denies, so that read is drift too.
 */
const DATABASE_RULES = {
  rules: {
    '.read': false,
    '.write': false,
    'pyric-live-capture': {
      replay: {
        $node: {
          '.read': 'auth != null',
          '.write': 'auth != null',
        },
        items: {
          $id: {
            '.read': 'auth != null',
            '.write': 'auth != null',
            '.validate': "newData.hasChildren(['n'])",
          },
        },
        presence: {
          '.read': 'auth != null',
          '.write': 'auth != null',
          '.validate': "!root.child('pyric-live-capture/replay/frozen').exists()",
        },
        list: {
          '.read': 'auth != null',
        },
      },
    },
    secret: {
      '.read': 'auth != null',
    },
  },
};

/** The project's files a user's checkout has: `.firebaserc` names it, its database rules, and the sign-ins recording the replay plays. */
async function writeProject(app: App): Promise<void> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('database.rules.json', `${JSON.stringify(DATABASE_RULES, null, 2)}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' }, database: { rules: 'database.rules.json' } })}\n`);
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
    element.getAttribute('data-traffic-row-call') ?? '',
    element.querySelector('.c2')?.textContent ?? '',
    element.querySelector('[data-verdict-production]')?.getAttribute('title') ?? '-',
    element.getAttribute('data-traffic-row-identity') ?? '',
  ].join(' ')));
}

/**
 * Every RTDB row Traffic lists, scoped to all: the list shows the latest 25,
 * so it picks the RTDB filter afresh, which follows new rows again, and loads
 * older rows until there are none.
 */
async function rtdbRows(chip: Locator): Promise<string[]> {
  await chip.locator('[data-chip-tab=traffic]').click();
  // On a live host the scope is the From select: every client's requests.
  await chip.locator('[data-traffic-from]').selectOption('all');
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

/** What a row's detail says about the local rules, and whether the row carries the drift marker. */
interface LocalReading {
  detail: string;
  drift: boolean;
}

function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** The first `source` row for `call` on `path` by `account`, its drift marker, and the text of its detail. */
async function localReading(chip: Locator, source: 'page' | 'node', call: string, path: string, account: string): Promise<LocalReading> {
  await rtdbRows(chip);
  const row = chip.locator(`[data-traffic-rows] [data-request-row][data-traffic-row-call="rtdb.${call}"][data-traffic-row-identity="${account}"]`)
    .filter({ has: chip.page().locator(`[data-traffic-row-source="${source}"]`) })
    .filter({ has: chip.page().locator('.c2', { hasText: exactly(path) }) })
    .first();
  const drift = await row.locator('[data-traffic-row-drift]').count() > 0;
  await row.click();
  const detail = await chip.locator('[data-traffic-detail]').textContent() ?? '';
  await chip.locator('[data-request-back]').click();
  return { detail, drift };
}

/** Each default-instance row from `source` reads the local rules' verdict, and the push they refuse is drift. */
async function expectLocalVerdicts(chip: Locator, source: 'page' | 'node'): Promise<void> {
  const set = await localReading(chip, source, 'set', `${RUN}/items/a`, 'user-1');
  assert.match(set.detail, /Local rules allowed this request\./, set.detail);
  assert.equal(set.drift, false);
  const update = await localReading(chip, source, 'update', `${RUN}/items/a`, 'user-1');
  assert.match(update.detail, /Local rules allowed this request\./, update.detail);
  assert.equal(update.drift, false);
  const presence = await localReading(chip, source, 'set', `${RUN}/presence`, 'user-1');
  assert.match(presence.detail, /Needs the stored data in production to evaluate against local rules\./, presence.detail);
  assert.equal(presence.drift, false);
  const push = await localReading(chip, source, 'push', `${RUN}/list`, 'user-1');
  assert.match(push.detail, /Local rules did not allow this request\./, push.detail);
  assert.match(push.detail, /The local rules file differs from the deployed rules/, push.detail);
  assert.equal(push.drift, true, 'the push the local rules refuse is drift');
  const secret = await localReading(chip, source, 'set', '/secret', 'user-1');
  assert.match(secret.detail, /Local rules did not allow this request\./, secret.detail);
  assert.equal(secret.drift, false, 'production denied it too');
}

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

interface CapturedEvent {
  id?: string;
  kind?: string;
  service?: string;
  method?: string;
  path?: string;
  instance?: string;
  auth?: { uid?: string } | null;
  production?: { local?: { result?: string; drift?: boolean } };
}

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

/** Studio's stylesheet names its web fonts, which the offline browser blocks; no app call goes to these hosts. */
const STUDIO_FONT_HOSTS = /\bhttps:\/\/(?:use\.typekit\.net|fonts\.googleapis\.com)\//;

/** The page user's first event for `method` on `path` on the default instance, with the local verdict `result`. */
function defaultEvent(events: CapturedEvent[], method: string, path: string, result: string): CapturedEvent {
  const event = events.find((candidate) => candidate.method === method
    && candidate.path?.replace(/^\/?/, '/') === path
    && candidate.instance === undefined
    && candidate.production?.local?.result === result);
  assert.ok(event?.id, `a default-instance ${method} ${path} with a local ${result}:\n${JSON.stringify(events.filter((candidate) => candidate.method === method), null, 1)}`);
  return event;
}

/** Studio's Traffic, deep-linked to one event's rules inspector, and the inspector once it shows. */
async function inspect(app: App, url: string, id: string): Promise<{ studio: Page; inspector: Locator }> {
  const studio = await app.page(`${url}/__pyric/ui/traffic/?inspect=${encodeURIComponent(id)}`);
  const inspector = studio.locator('[data-pyric-ui="traffic-live-rules-inspector"]');
  await inspector.waitFor({ timeout: 30_000 }).catch((error: Error) => {
    throw new Error(`${error.message}\nconsole:\n${app.browserLog.join('\n')}`);
  });
  return { studio, inspector };
}

interface BilledCount {
  reads: number;
  writes: number;
  deliveries: number;
}

/** The host's billed-call count, as its health report carries it. */
async function billed(app: App, url: string): Promise<BilledCount | undefined> {
  const health = await (await fetch(`${url}/__pyric/health`, { headers: sessionHeaders(app, url) })).json() as { live?: { billed?: BilledCount } };
  return health.live?.billed;
}

/** The host's in-memory session data, as `GET /__pyric/live/session-data` answers it. */
interface SessionData {
  revision: number;
  projectId: string | null;
  firestore: Record<string, unknown>;
  rtdb: Record<string, unknown>;
  defaultRtdbInstance: string | null;
  stats: { firestoreDocs: number; rtdbInstances: number; byteEstimate: number; truncated: boolean; droppedCount: number };
  skips?: Record<string, number>;
}

async function sessionData(app: App, url: string): Promise<SessionData> {
  const response = await fetch(`${url}/__pyric/live/session-data`, { headers: sessionHeaders(app, url) });
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  assert.ok(response.status === 200 && type.includes('application/json'), `GET /__pyric/live/session-data answered ${response.status} ${type}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as SessionData;
}

/**
 * What an instance's tree holds once capture A's sequence ran on it `runs`
 * times, from what production answered the page (`expectedResults`): the
 * item as the listener last delivered it, after the second user's write; the
 * presence the second user read once the onDisconnect fired; and both list
 * entries of each run, under the push keys each client made.
 */
function expectedRun(runs = 1): { item: unknown; presence: unknown; list: unknown[] } {
  const on = expectedResults().default as { onValue: unknown[]; presence: unknown };
  const list = Array.from({ length: runs }, () => [{ v: 1 }, { v: 2 }]).flat();
  return { item: on.onValue.at(-1), presence: on.presence, list };
}

const sortedJson = (values: unknown[]) => values.map((value) => JSON.stringify(value)).sort();

/** The run folder of one instance's tree, checked against what `runs` runs observed, and nothing from `/secret`. */
function expectObservedTree(tree: unknown, instance: string, runs = 1): Record<string, unknown> {
  const root = tree as Record<string, unknown> | null;
  assert.ok(root !== null && typeof root === 'object', `${instance}: no tree: ${JSON.stringify(tree)}`);
  assert.deepEqual(Object.keys(root), ['pyric-live-capture'], `${instance}: the tree holds only the run folder, nothing from /secret: ${JSON.stringify(root)}`);
  const run = (root['pyric-live-capture'] as { replay?: Record<string, unknown> }).replay;
  assert.ok(run, `${instance}: no ${RUN}: ${JSON.stringify(root)}`);
  const expected = expectedRun(runs);
  assert.deepEqual(run.items, { a: expected.item }, `${instance}: ${RUN}/items`);
  assert.equal(run.presence, expected.presence, `${instance}: ${RUN}/presence`);
  assert.deepEqual(sortedJson(Object.values((run.list ?? {}) as Record<string, unknown>)), sortedJson(expected.list), `${instance}: ${RUN}/list`);
  return run;
}

/** Every file under `.pyric/state/hosted` (the SQLite database, its journal, object files), as text. */
function hostedStateText(app: App): string {
  const root = join(app.dir, HOSTED_STATE);
  if (!existsSync(root)) return '';
  const texts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else texts.push(readFileSync(path, 'latin1'));
    }
  };
  walk(root);
  return texts.join('\n');
}

/** The values only production's answers carry, as JSON writes them: the item's string and the presence. */
function observedMarkers(): string[] {
  const { item, presence } = expectedRun();
  return [JSON.stringify((item as { s: string }).s), JSON.stringify(presence)];
}

/** Each observed RTDB instance pill Studio's RTDB surface shows, as `<instance> <observed>`. */
async function instancePills(studio: Page): Promise<string[]> {
  return studio.locator('[data-rtdb-instance-bar] [data-rtdb-instance]').evaluateAll((elements) => elements.map((element) =>
    `${element.getAttribute('data-rtdb-instance')} ${element.getAttribute('data-rtdb-instance-observed')}`));
}

/** The leaf rows of Studio's RTDB tree, as `key: value`. */
async function treeLeaves(studio: Page): Promise<string[]> {
  return studio.locator('[data-pyric-ui="rtdb-tree"] [data-rtdb-node][data-rtdb-kind=leaf] > [data-rtdb-row]').evaluateAll((rows) => rows.map((row) =>
    `${row.querySelector('[data-rtdb-key]')?.textContent ?? ''}: ${row.querySelector('[data-rtdb-value]')?.textContent ?? ''}`).sort());
}

/** The value `pyric database get` printed as `{ exists, value }`, after the lines naming the sandbox and the read. */
function printedValue(output: string): unknown {
  const start = output.search(/^\{/m);
  assert.ok(start >= 0, `no value in:\n${output}`);
  let read: { exists?: boolean; value?: unknown };
  try {
    read = JSON.parse(output.slice(start).trim()) as { exists?: boolean; value?: unknown };
  } catch {
    throw new Error(`pyric database get printed no JSON value:\n${output}`);
  }
  assert.equal(read.exists, true, output);
  return read.value;
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
    await opened.locator('.panel-header [data-chip-live]').waitFor({ timeout: 20_000 });
    const health = await (await fetch(`${host.url}/__pyric/health`, { headers: sessionHeaders(app, host.url) })).json() as { live?: { projectId?: string } };
    assert.equal(health.live?.projectId, PROJECT);
    await expectRows(opened, 'page');
    return opened;
  });

  await app.step('each default-instance page row reads the local rules\' verdict, and the push they refuse is drift', async () => {
    await expectLocalVerdicts(chip, 'page');
  });

  await app.step('the host\'s event stream names the named instance and leaves the default\'s out', async () => {
    await expectInstances(app, EVENTS_PER_PLANE);
  });

  await app.step('RTDB calls add nothing to the billed count', async () => {
    assert.deepEqual(await billed(app, host.url), { reads: 0, writes: 0, deliveries: 0 });
  });

  const blockedBeforeStudio = blockedLines(app).length;
  await app.step('Studio\'s Traffic opens the local rules inspector in place for live RTDB calls on the default instance', async () => {
    const events = rtdbEvents(app);
    const listener = defaultEvent(events, 'onValue', `${RUN}/items/a`, 'allow');
    const updated = defaultEvent(events, 'update', `${RUN}/items/a`, 'allow');
    assert.equal(updated.production?.local?.drift, undefined);
    const write = defaultEvent(events, 'set', `${RUN}/presence`, 'unevaluated');
    const drift = defaultEvent(events, 'get', '/secret', 'allow');
    assert.equal(drift.production?.local?.drift, true, 'the local rules allow the read production denied');

    const delivery = await inspect(app, host.url, listener.id!);
    const deliveryText = await delivery.inspector.textContent() ?? '';
    assert.match(deliveryText, /production ok/);
    assert.match(deliveryText, new RegExp(`Local rules would allow listen on ${RUN}/items/a`));
    assert.match(deliveryText, /items\/\$id/);
    assert.equal(await delivery.inspector.locator('[data-pyric-badge-kind=allow]').textContent(), 'local rules would allow');
    await delivery.studio.close();

    const unevaluated = await inspect(app, host.url, write.id!);
    assert.equal(await unevaluated.inspector.getAttribute('data-live-unevaluated'), '');
    assert.equal(await unevaluated.inspector.locator('[data-live-need="stored-document"]').count(), 1);
    assert.equal(
      await unevaluated.inspector.locator('[data-missing-path="/pyric-live-capture/replay/frozen"]').count(),
      1,
    );
    assert.match(
      await unevaluated.inspector.textContent() ?? '',
      /Matched rule — paused on uncaptured path \/pyric-live-capture\/replay\/frozen/,
    );
    await unevaluated.studio.close();

    const denied = await inspect(app, host.url, drift.id!);
    const deniedText = await denied.inspector.textContent() ?? '';
    assert.match(deniedText, /production denied/);
    // The row's detail carries the drift sentence beside the local rules view.
    assert.equal(await denied.studio.locator('[data-pyric-ui="traffic-row-detail"] [data-drift-reason]').count(), 1);
    assert.match(deniedText, /Local rules would allow get on \/secret; production's answer above is what happened\./);
    await denied.studio.close();
    const studioBlocked = blockedLines(app).slice(blockedBeforeStudio);
    assert.deepEqual(studioBlocked.filter((line) => !STUDIO_FONT_HOSTS.test(line)), [], 'Studio requested nothing off loopback but its fonts');
  });
  const blockedAfterStudio = blockedLines(app).length;

  await app.step('the host holds each instance\'s observed tree in memory, by instance name, with no Firestore document and nothing from /secret', async () => {
    const data = await eventually(() => sessionData(app, host.url), (value) => Object.keys(value.rtdb).length === 2, 'both instances in the session data');
    assert.equal(data.projectId, PROJECT);
    assert.deepEqual(Object.keys(data.rtdb).sort(), [DEFAULT_INSTANCE, NAMED].sort());
    assert.equal(data.defaultRtdbInstance, DEFAULT_INSTANCE);
    for (const instance of [DEFAULT_INSTANCE, NAMED]) expectObservedTree(data.rtdb[instance], instance);
    assert.deepEqual(data.firestore, {});
    assert.equal(data.stats.firestoreDocs, 0);
    assert.equal(data.stats.rtdbInstances, 2);
    assert.equal(data.stats.truncated, false);
    assert.doesNotMatch(JSON.stringify(data.rtdb), /secret/);
  });

  await app.step('.pyric/state/hosted holds none of the observed values', () => {
    const text = hostedStateText(app);
    for (const marker of observedMarkers()) assert.ok(!text.includes(marker), `${HOSTED_STATE} holds ${marker} before any seeding`);
  });

  const blockedBeforePills = blockedLines(app).length;
  await app.step('Studio\'s RTDB surface shows one pill per observed instance and each tree read-only, with the observed values', async () => {
    const studio = await app.page(`${host.url}/__pyric/ui/rtdb${RUN}/items/a`);
    await studio.locator('[data-pyric-ui="rtdb-live-observed"]').waitFor({ timeout: 30_000 });
    await eventually(() => instancePills(studio), (pills) => pills.length === 2, 'two instance pills');
    assert.deepEqual((await instancePills(studio)).sort(), [`${DEFAULT_INSTANCE} true`, `${NAMED} true`].sort());
    const { item } = expectedRun() as { item: Record<string, unknown> };
    const leaves = Object.entries(item).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).sort();
    for (const instance of [DEFAULT_INSTANCE, NAMED]) {
      const pill = studio.locator(`[data-rtdb-instance-bar] [data-rtdb-instance="${instance}"]`);
      await pill.click();
      await eventually(() => pill.getAttribute('aria-selected'), (selected) => selected === 'true', `${instance} selected`);
      const tree = studio.locator('[data-pyric-ui="rtdb-tree"]');
      await eventually(() => treeLeaves(studio), (rows) => JSON.stringify(rows) === JSON.stringify(leaves), `${instance}'s ${RUN}/items/a in Studio`);
      assert.equal(await tree.getAttribute('data-rtdb-readonly'), '', `${instance}'s tree is read-only`);
      assert.equal(await tree.locator('[data-rtdb-actions], button[data-rtdb-value]').count(), 0, `${instance}'s tree offers no edit`);
    }
    await studio.close();
    const studioBlocked = blockedLines(app).slice(blockedBeforePills);
    assert.deepEqual(studioBlocked.filter((line) => !STUDIO_FONT_HOSTS.test(line)), [], 'Studio requested nothing off loopback but its fonts');
  });
  const blockedAfterPills = blockedLines(app).length;

  await pageReplay.stop();
  const nodeReplay = await app.step('start a fresh replay server for the server job', () => startReplay(app));

  await app.step('the server job under @pyric/live/register runs the same sequence, reporting to the dev server', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'client.js'], { env: { APP_BACKEND: nodeReplay.origin }, timeoutMs: 120_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    assert.deepEqual(resultOf(run.output), expectedResults());
    assert.deepEqual(await nodeReplay.unmatched(), []);
    await expectNoInfoFrames(nodeReplay);
  });

  await app.step('the chip shows each server job call as production\'s, from a Node process', async () => {
    await expectRows(chip, 'node');
    assert.ok(await chip.locator('[data-traffic-row-source=node]').count() > 0, 'the server job\'s rows carry the node source');
    assert.deepEqual(await billed(app, host.url), { reads: 0, writes: 0, deliveries: 0 });
  });

  await app.step('the server job\'s events on the host name the named instance and leave the default\'s out too', async () => {
    await expectInstances(app, EVENTS_PER_PLANE * 2);
  });

  await app.step('pyric sandbox seed-from-live without --confirm refuses and writes nothing', async () => {
    const run = await app.pyric(['sandbox', 'seed-from-live']);
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.output, /--confirm/, run.output);
    const text = hostedStateText(app);
    for (const marker of observedMarkers()) assert.ok(!text.includes(marker), `${HOSTED_STATE} holds ${marker} after a refused seed`);
  });

  const seeded = await app.step('pyric sandbox seed-from-live --confirm seeds .pyric/state/hosted with both instances\' trees', async () => {
    // The server job ran the sequence again, so each list holds both runs' entries.
    const observed = await sessionData(app, host.url);
    for (const instance of [DEFAULT_INSTANCE, NAMED]) expectObservedTree(observed.rtdb[instance], instance, 2);
    const run = await app.pyric(['sandbox', 'seed-from-live', '--confirm']);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(DEFAULT_INSTANCE), run.output);
    assert.match(run.output, new RegExp(NAMED), run.output);
    const text = hostedStateText(app);
    for (const marker of observedMarkers()) assert.ok(text.includes(marker), `${HOSTED_STATE} holds no ${marker} after seeding`);
    assert.ok(app.readFile('.gitignore').split(/\r?\n/).some((line) => /^\/?\.pyric\/?$/.test(line.trim())), `.gitignore names .pyric/:\n${app.readFile('.gitignore')}`);
    return observed;
  });

  await app.step('pyric sandbox seed-from-live --out exports a seed file with the observed trees', async () => {
    const run = await app.pyric(['sandbox', 'seed-from-live', '--out', 'seed.json']);
    assert.equal(run.code, 0, run.output);
    const seed = JSON.parse(app.readFile('seed.json')) as { firestore?: unknown; database?: unknown };
    assert.deepEqual(seed.firestore, {});
    expectObservedTree(seed.database, `seed.json's database (${DEFAULT_INSTANCE})`, 2);
    // A seed file's `database` is one instance; the export names any instance it left out.
    assert.match(run.output, new RegExp(`not exported:[^\\n]*${NAMED}`), `the export names ${NAMED}, which a seed file's database does not hold:\n${run.output}`);
  });

  await app.step('nothing reached any host but loopback', async () => {
    const blocked = blockedLines(app);
    // Only the two Studio pages' font requests were blocked; the app's calls stayed on loopback.
    assert.deepEqual([...blocked.slice(0, blockedBeforeStudio), ...blocked.slice(blockedAfterStudio, blockedBeforePills), ...blocked.slice(blockedAfterPills)], []);
    assert.deepEqual(await nodeReplay.unmatched(), []);
    await page.close();
    await host.process.stop();
    await nodeReplay.stop();
  });

  const sandbox = await app.step('with pyric({ hosted: true }) in place of pyricLive(), the dev server serves the seeded sandbox', async () => {
    app.writeFile('vite.config.js', 'import { defineConfig } from "vite";\nimport { pyric } from "@pyric/cli/vite";\n\nexport default defineConfig({\n  plugins: [pyric({ hosted: true })],\n});\n');
    // The project names its two instances, as a project with a named instance
    // does, each under its `database.rules.json`. The seeded item keeps its `n`.
    app.writeFile('firebase.json', `${JSON.stringify({
      hosting: { public: 'public' },
      database: [{ instance: DEFAULT_INSTANCE, rules: 'database.rules.json' }, { instance: NAMED, rules: 'database.rules.json' }],
    })}\n`);
    return app.devServer({ name: 'hosted dev server' });
  });

  await app.step('pyric database get reads each instance\'s seeded tree, as the live host observed it', async () => {
    for (const instance of [DEFAULT_INSTANCE, NAMED]) {
      const run = await app.pyric(['database', 'get', '--instance', instance, '--path', RUN]);
      assert.equal(run.code, 0, run.output);
      const observed = (seeded.rtdb[instance] as Record<string, { replay: unknown }>)['pyric-live-capture'].replay;
      assert.deepEqual(printedValue(run.output), observed, `${instance}:\n${run.output}`);
      expectObservedTree({ 'pyric-live-capture': { replay: printedValue(run.output) } }, `${instance} in the sandbox`, 2);
    }
    await sandbox.process.stop();
  });
});
