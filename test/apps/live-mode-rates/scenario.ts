/**
 * Live mode measures what production billed or moved for each call, through
 * the packed packages: the bookings app's page on `vite dev` with
 * `pyricLive()`, and its server job under `node --import @pyric/live/register`.
 * The page lists three bookings, reads a room, listens to the open rooms and
 * opens one, reads an item from the Realtime Database, uploads and downloads
 * a file, and asks AI Logic for content; the server job lists the bookings.
 *
 * Each call's event in the host's capture (`/__pyric/capture`) carries
 * production's sizes as the measurement both planes share
 * (`measureObservedUsage`) reads them from the SDK's own answer: three reads
 * for the query, one for the read, one write, the item's JSON bytes, the
 * uploaded and downloaded bytes, and the AI call's tokens. The host's health
 * report (`/__pyric/health`) bills reads by those sizes, so the query counts
 * three. The chip's Rates view, which reads the same events, opens.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * `live-mode-traffic.json` and `live-mode-rates.json` for Firestore and Auth,
 * capture A for the Realtime Database, capture S for Storage, and the AI Logic
 * observations, all for one project. The app reaches it with the SDK's own
 * emulator connectors (`?backend=` on the page, `BOOKINGS_FIRESTORE_HOST` for
 * the server job). Like every app scenario this runs offline, and the browser
 * blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const FIXTURES = ['live-mode-traffic.json', 'live-mode-rates.json'].map((name) => fileURLToPath(new URL(`../replay/fixtures/${name}`, import.meta.url)));
const PROJECT = 'demo-live-traffic';
const SIGN_INS = 'sign-ins.json';
const BOOKINGS = ['b1', 'b2', 'b3'];
/** The item capture A's get returns, and its JSON size: what an RTDB `get` moved. */
const ITEM = { n: 1, s: 'alpha' };
const ITEM_BYTES = Buffer.byteLength(JSON.stringify(ITEM));
/** The file capture S's uploadBytes sends and getBytes reads back. */
const FILE_BYTES = 6;
/** The tokens the AI Logic observation reports for generateContent. */
const AI_TOTAL_TOKENS = 11;

declare function signIn(): Promise<string[]>;
declare function listBookings(): Promise<unknown>;
declare function readLobby(): Promise<unknown>;
declare function listenToOpenRooms(): Promise<string[]>;
declare function openGarden(): Promise<string>;
declare function readItem(): Promise<unknown>;
declare function uploadFile(): Promise<unknown>;
declare function downloadFile(): Promise<unknown>;
declare function askAssistant(): Promise<unknown>;
declare function openRooms(): string[];
declare function billedDocumentCount(): number;

interface Replay {
  origin: string;
  grpc: string;
  unmatched(): Promise<unknown[]>;
}

/** Custom-token sign-ins: `client-1` gets an anonymous ID token for `user-1`, the uid captures A and S name `<uid-1>` as. */
function signIns(format: string): Record<string, unknown> {
  const uid = 'user-1';
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
  }];
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
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const recordings = [...FIXTURES, `${app.dir}/${SIGN_INS}`];
  const server = app.commandProcess('node', replayServerArgs(recordings, app.dir, { rtdbCapture: PROJECT, storageCapture: PROJECT, ai: true }));
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
 * does not serve: the SDK falls back to the WebSocket capture A recorded.
 */
function isLongPollStart(entry: unknown): boolean {
  const { rpc, request } = entry as { rpc?: string; request?: { method?: string; path?: string } };
  return rpc === 'http' && request?.method === 'GET' && (request.path ?? '').startsWith('/.lp?start=t&');
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

async function hostJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  return await response.json() as T;
}

type Usage = Record<string, number>;

/** A live call's event, as the host's capture holds it. */
interface CapturedEvent {
  kind?: string;
  service?: string;
  method?: string;
  caller?: { kind?: string };
  production?: { outcome?: { status?: string }; usage?: Usage; billedDocuments?: number };
  observation?: { ai?: { usageSource?: string; totalTokens?: number } };
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

/** One line per live call from `caller`: `<service>.<method> <production's usage>`, sorted. Deliveries and sign-ins carry none. */
function usageLines(events: CapturedEvent[], caller: 'page' | 'node'): string[] {
  return events
    .filter((event) => event.caller?.kind === caller && event.production?.usage !== undefined)
    .map((event) => `${event.service}.${event.method} ${JSON.stringify(event.production?.usage)}`)
    .sort();
}

const PAGE_USAGE = [
  `firestore.getDocs ${JSON.stringify({ documentReads: BOOKINGS.length })}`,
  `firestore.getDoc ${JSON.stringify({ documentReads: 1 })}`,
  `firestore.setDoc ${JSON.stringify({ documentWrites: 1 })}`,
  `rtdb.get ${JSON.stringify({ payloadBytes: ITEM_BYTES })}`,
  `storage.uploadBytes ${JSON.stringify({ uploadedBytes: FILE_BYTES })}`,
  `storage.getBytes ${JSON.stringify({ downloadedBytes: FILE_BYTES })}`,
].sort();
const NODE_USAGE = [`firestore.getDocs ${JSON.stringify({ documentReads: BOOKINGS.length })}`];

interface BilledCount {
  reads: number;
  writes: number;
  deliveries: number;
}

/** The host's billed-call count, as its health report carries it. */
async function billed(url: string): Promise<BilledCount | undefined> {
  const health = await hostJson<{ live?: { billed?: BilledCount } }>(`${url}/__pyric/health`);
  return health.live?.billed;
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

/** The chip's Traffic view switched to Rates, and the Firestore service's rates opened: each control visible and clickable. */
async function openRates(page: Page): Promise<void> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  if (!await chip.locator('[data-chip-tab=traffic]').isVisible()) await chip.locator('[data-expand]').click();
  await chip.locator('[data-chip-tab=traffic]').click();
  const rates = chip.locator('[data-traffic-display=rates]');
  await rates.waitFor({ state: 'visible', timeout: 20_000 });
  await rates.click();
  const firestore = chip.locator('[data-inspect-rates=firestore]').first();
  await firestore.waitFor({ state: 'visible', timeout: 20_000 });
  await firestore.click();
}

export default scenario(async (app) => {
  await writeProject(app);
  const replay = await app.step('start the replay server that plays production for the project', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const { page, deliveries } = await app.step('the page lists, reads, listens, writes, reads an item, moves a file and asks AI Logic', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
    const status = await opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.equal(status, 'Ready', `the page's module did not load\nconsole:\n${app.browserLog.join('\n')}`);
    assert.deepEqual(await opened.evaluate(() => signIn()), ['user-reader', 'user-1']);
    assert.deepEqual(await opened.evaluate(() => listBookings()), BOOKINGS);
    assert.deepEqual(await opened.evaluate(() => readLobby()), { name: 'Lobby', open: true, seats: 12 });
    assert.deepEqual(await opened.evaluate(() => listenToOpenRooms()), ['lobby']);
    assert.equal(await opened.evaluate(() => openGarden()), 'written');
    await eventually(() => opened.evaluate(() => openRooms()), (rooms) => rooms.includes('garden'), 'the listener lists the garden');
    assert.deepEqual(await opened.evaluate(() => readItem()), ITEM);
    assert.equal(await opened.evaluate(() => uploadFile()), FILE_BYTES);
    assert.equal(await opened.evaluate(() => downloadFile()), FILE_BYTES);
    assert.deepEqual(await opened.evaluate(() => askAssistant()), { text: 'pyric', totalTokenCount: AI_TOTAL_TOKENS });
    assert.deepEqual(await replay.unmatched(), []);
    return { page: opened, deliveries: await opened.evaluate(() => billedDocumentCount()) };
  });

  await app.step('the capture holds each page call with production\'s usage, and the AI call with its tokens', async () => {
    const pageAi = (all: CapturedEvent[]): CapturedEvent[] => all.filter((event) => event.caller?.kind === 'page' && event.service === 'ai');
    // The AI call is the page's last and carries no usage, so wait for its
    // event as well as the usage lines; it can reach the capture after them.
    const events = await eventually(
      () => liveEvents(host.url),
      (all) => usageLines(all, 'page').length >= PAGE_USAGE.length && pageAi(all).length >= 1,
      'the page\'s measured calls and its AI call',
    );
    assert.deepEqual(usageLines(events, 'page'), PAGE_USAGE);
    const ai = pageAi(events);
    assert.equal(ai.length, 1, `one AI event:\n${JSON.stringify(ai)}`);
    assert.equal(ai[0]!.observation?.ai?.usageSource, 'backend');
    assert.equal(ai[0]!.observation?.ai?.totalTokens, AI_TOTAL_TOKENS);
    // A listener's deliveries carry the documents production billed, not usage.
    const delivered = events.filter((event) => event.caller?.kind === 'page' && event.method === 'onSnapshot')
      .reduce((sum, event) => sum + (event.production?.billedDocuments ?? 0), 0);
    assert.equal(delivered, deliveries);
  });

  await app.step('the health report bills the query as three reads, the read as one, and the write as one', async () => {
    const expected = { reads: BOOKINGS.length + 1, writes: 1, deliveries };
    await eventually(() => billed(host.url), (count) => JSON.stringify(count) === JSON.stringify(expected), 'the billed count');
  });

  await app.step('the server job under @pyric/live/register lists the bookings, reporting to the dev server', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: { BOOKINGS_FIRESTORE_HOST: replay.grpc }, timeoutMs: 90_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    assert.deepEqual(resultOf(run.output), { bookings: BOOKINGS });
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('the capture holds the server job\'s query with its usage, and the health report adds its three reads', async () => {
    const events = await eventually(() => liveEvents(host.url), (all) => usageLines(all, 'node').length >= NODE_USAGE.length, 'the server job\'s measured call');
    assert.deepEqual(usageLines(events, 'node'), NODE_USAGE);
    const expected = { reads: 2 * BOOKINGS.length + 1, writes: 1, deliveries };
    await eventually(() => billed(host.url), (count) => JSON.stringify(count) === JSON.stringify(expected), 'the billed count');
  });

  await app.step('the chip\'s Rates control and the Firestore rates it lists are visible and clickable', async () => {
    await openRates(page);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    await page.close();
    await host.process.stop();
  });
});
