/**
 * A full-stack app in live mode, through the packed packages: the notes
 * app's page on `vite dev` with `pyricLive()`, and its API server
 * (`server.mjs`) under `node --import @pyric/live/register`, behind the
 * page's `server.proxy` at `/api`. The page signs in, reads its own note, and
 * saves a note with `POST /api/notes`, sending its ID token. The server
 * checks the token with firebase-admin, then writes the note to Firestore,
 * fans it out to the Realtime Database and keeps a copy in Cloud Storage.
 *
 * The live host's event stream (`/__pyric/capture`) holds the page's calls,
 * which Security Rules judged in production, and the server's Admin calls,
 * marked as bypassing Security Rules, all as the one account the page signed
 * in as. The host's health report lists the Admin SDK as observed, names the
 * API server as a backend in the same mode and project, and bills the Admin
 * write. An ID token a pyric sandbox issued is refused by the server's token
 * check, by name, and sends nothing.
 *
 * Production is a replay server this scenario starts (`../replay/`): the
 * page's sign-in and read from a recording the scenario writes, and the
 * server's calls from capture A (Admin). The page reaches it with the SDK's
 * emulator connectors (`?backend=`), and the server with firebase-admin's own
 * emulator variables. Under `FIREBASE_AUTH_EMULATOR_HOST`, firebase-admin
 * accepts only an unsigned ID token, as the Auth emulator issues one, so the
 * replay mints the page's token unsigned.
 *
 * Node 22's require() never reaches the register's hooks, so there the API
 * server's firebase-admin import is refused, naming Node 23, and the
 * scenario stops after that step. CI runs this app on Node 24 as well. Like
 * every app scenario this runs offline, and the browser blocks every host
 * but loopback.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { scenario, sleep, type App, type ExpectedCrash } from '../driver.ts';

const PROJECT = 'demo-live-full-stack';
/** The account capture A's Admin calls name `<uid-1>`, and the one the page signs in as. */
const UID = 'user-1';
const EMAIL = 'admin-capture@example.com';
const PASSWORD = 'notes-password';
const CLIENT_RECORDING = 'page-recording.json';
const RUN = 'pyric_oracle/replay';
const OWN_NOTE = { title: 'First note' };
const DOCUMENTS = `projects/${PROJECT}/databases/(default)/documents`;

/** Whether the `node` the app's processes run serves the Admin rows: Node 23 or later. */
const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;

export const expectedCrashes: ExpectedCrash[] = ADMIN_ROWS_ON ? [] : [{
  message: /^Error: @pyric\/live: firebase-admin\/app \(the Admin SDK\) is refused in live mode\. @pyric\/live observes firebase-admin on Node 23 or later/,
  source: /^process \d+ \(node --import @pyric\/live\/register server\.mjs\)$/,
  reason: 'on Node 22, whose require() skips the hooks, the Admin rows stay shut and the API server is refused its import',
}];

declare function signIn(): Promise<string>;
declare function readOwnNote(): Promise<unknown>;
declare function saveNote(): Promise<{ status: number; body: unknown }>;

/** The page's sign-in, its account lookup and the read of its own note, as production answered them. */
function pageRecording(format: string): Record<string, unknown> {
  const idToken = { $: 'idToken', uid: UID, email: EMAIL, provider: 'password', unsigned: true };
  const targetIds = [{ $: 'targetId' }];
  return {
    format,
    project: PROJECT,
    source: 'hand-written from the firebase 12.12.0 SDK wire format: Auth REST v1, and a Firestore Listen as a page sends it over WebChannel',
    exchanges: [{
      kind: 'auth',
      id: 'sign-in',
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:signInWithPassword', body: { returnSecureToken: true, email: EMAIL, password: { $: 'any' }, clientType: 'CLIENT_TYPE_WEB' } },
      response: { status: 200, body: { kind: 'identitytoolkit#VerifyPasswordResponse', localId: UID, email: EMAIL, displayName: '', idToken, registered: true, refreshToken: { $: 'refreshToken' }, expiresIn: '3600' } },
    }, {
      kind: 'auth',
      id: 'lookup',
      request: { method: 'POST', host: 'identitytoolkit.googleapis.com', path: '/v1/accounts:lookup', body: { idToken: { $: 'idToken', uid: UID } } },
      response: { status: 200, body: { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: UID, email: EMAIL, emailVerified: false, lastLoginAt: '1793520000000', createdAt: '1793520000000' }] } },
    }, {
      kind: 'listen',
      id: 'read-own-note',
      as: UID,
      target: { documents: { documents: [`${DOCUMENTS}/owners/${UID}`] } },
      batches: [{
        messages: [
          { targetChange: { targetChangeType: 'ADD', targetIds } },
          { documentChange: { document: { name: `${DOCUMENTS}/owners/${UID}`, fields: { title: { stringValue: OWN_NOTE.title } }, createTime: '2026-11-01T08:00:00.000000Z', updateTime: '2026-11-01T08:00:00.000000Z' }, targetIds } },
          { targetChange: { targetChangeType: 'CURRENT', targetIds, resumeToken: { $: 'resumeToken' }, readTime: { $: 'readTime' } } },
          { targetChange: { targetChangeType: 'NO_CHANGE', resumeToken: { $: 'resumeToken' }, readTime: { $: 'readTime' } } },
        ],
      }],
    }],
  };
}

interface Replay {
  origin: string;
  grpc: string;
  /** How many requests the replay received. */
  received(): Promise<number>;
  unmatched(): Promise<unknown[]>;
}

async function startReplay(app: App): Promise<Replay> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile(CLIENT_RECORDING, `${JSON.stringify(pageRecording(FORMAT))}\n`);
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([`${app.dir}/${CLIENT_RECORDING}`], app.dir, { adminCapture: PROJECT }));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints?.grpc, `the replay server named no gRPC host:\n${server.output}`);
  return {
    origin: endpoints.origin,
    grpc: endpoints.grpc,
    received: async () => (await receivedBy(endpoints.origin)).length,
    unmatched: () => unmatchedBy(endpoints.origin),
  };
}

/** The API server's environment: its port, its project, and firebase-admin's own emulator variables, each at the replay. */
function serverEnv(replay: Replay, port: number): Record<string, string> {
  const host = new URL(replay.origin).host;
  return {
    NOTES_API_PORT: String(port),
    NOTES_PROJECT: PROJECT,
    FIRESTORE_EMULATOR_HOST: replay.grpc,
    FIREBASE_AUTH_EMULATOR_HOST: host,
    FIREBASE_DATABASE_EMULATOR_HOST: host,
    STORAGE_EMULATOR_HOST: replay.origin,
  };
}

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

/** A live call's event, as the host's capture holds it. */
interface CapturedEvent {
  kind?: string;
  service?: string;
  method?: string;
  path?: string;
  caller?: { kind?: string };
  auth?: { uid?: string };
  detail?: { sdk?: string };
  rulesDisposition?: { kind?: string; reason?: string };
  production?: { outcome?: { status?: string; code?: string } };
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

function isAdmin(event: CapturedEvent): boolean {
  return event.detail?.sdk === 'admin';
}

/** One line per event: `<service> <method> <path> <outcome>`. */
function eventLine(event: CapturedEvent): string {
  const outcome = event.production?.outcome;
  const answer = outcome?.status === 'ok' ? 'ok' : `${outcome?.status} ${outcome?.code}`;
  return `${event.service} ${event.method} ${event.path ?? '-'} ${answer}`;
}

/** The API server's Admin calls for one saved note, in order, and production's answers. */
const ADMIN_EVENTS = [
  'auth Auth.verifyIdToken - ok',
  `firestore DocumentReference.set ${RUN}/notes/a ok`,
  `rtdb Reference.update /${RUN} ok`,
  `storage File.save ${RUN}/note.txt ok`,
];

interface Health {
  live?: { admin?: { mode?: string; observed?: boolean; bypassesRules?: boolean }; billed?: { reads: number; writes: number; deliveries: number } };
  proxyTargets?: Array<{ context: string; verdict: string }>;
}

/** An ID token a pyric sandbox issued: RS256 with the sandbox's key id. */
function sandboxIdToken(): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const header = segment({ alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' });
  const payload = segment({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, sub: UID, user_id: UID, iat: now, exp: now + 3600 });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** No event or log line holds the page's email, password or any token. */
function assertNoSecrets(text: string): void {
  for (const secret of [EMAIL, PASSWORD, 'eyJ']) assert.ok(!text.includes(secret), `the text holds ${secret}`);
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  const replay = await app.step('start the replay server that plays production: the page\'s recording and capture A (Admin)', () => startReplay(app));
  const apiPort = await app.freePort();

  const host = await app.step('start vite dev with pyricLive() and an /api proxy: the dev server is the live host', async () => {
    const started = await app.devServer({ env: { NOTES_API_PORT: String(apiPort) } });
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  if (!ADMIN_ROWS_ON) {
    await app.step(`on Node ${NODE_VERSION}, the API server's firebase-admin import is refused, naming Node 23`, async () => {
      const refused = app.commandProcess('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: serverEnv(replay, apiPort) });
      assert.notEqual(await refused.exited, 0, refused.output);
      assert.match(refused.output, /@pyric\/live\/register: firebase-admin is refused in this process\. @pyric\/live observes firebase-admin on Node 23 or later/);
      assert.equal(await replay.received(), 0);
      await host.process.stop();
    });
    return;
  }

  const api = await app.step('start the API server under @pyric/live/register: firebase-admin is observed', async () => {
    const started = app.commandProcess('node', ['--import', '@pyric/live/register', 'server.mjs'], { env: serverEnv(replay, apiPort) });
    await started.waitForLog(new RegExp(`notes api listening on ${apiPort}`), { timeoutMs: 60_000 });
    assert.match(started.output, new RegExp(`@pyric/live/register: firebase-admin is observed for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const page = await app.step('the page signs in, reads its own note, and saves a note through POST /api/notes with its ID token', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
    const status = await opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.equal(status, 'Ready', `the page's module did not load\nconsole:\n${app.browserLog.join('\n')}`);
    assert.equal(await opened.evaluate(() => signIn()), UID);
    assert.deepEqual(await opened.evaluate(() => readOwnNote()), OWN_NOTE);
    assert.deepEqual(await opened.evaluate(() => saveNote()), { status: 200, body: { uid: UID, saved: true } }, api.output);
    assert.deepEqual(await replay.unmatched(), []);
    return opened;
  });

  await app.step('the event stream holds the page\'s calls and the server\'s Admin calls, as one account', async () => {
    const events = await eventually(() => liveEvents(host.url), (all) => all.filter(isAdmin).length >= ADMIN_EVENTS.length, 'the Admin events');
    const pageEvents = events.filter((event) => event.caller?.kind === 'page');
    const pageCalls = pageEvents.map((event) => `${event.service} ${event.method}`);
    assert.ok(pageCalls.includes('auth signInWithEmailAndPassword'), JSON.stringify(pageCalls));
    assert.ok(pageCalls.includes('firestore getDoc'), JSON.stringify(pageCalls));
    for (const event of pageEvents) {
      assert.deepEqual(event.rulesDisposition, { kind: 'not-evaluated', reason: 'external-execution' }, eventLine(event));
      assert.equal(event.auth?.uid, UID, eventLine(event));
    }
    const admin = events.filter(isAdmin);
    assert.deepEqual(admin.map(eventLine), ADMIN_EVENTS);
    for (const event of admin) {
      assert.equal(event.caller?.kind, 'node');
      assert.deepEqual(event.rulesDisposition, { kind: 'bypassed', reason: 'admin' });
    }
    assert.equal(admin[0]!.auth?.uid, UID, 'the server\'s token check names the page\'s account');
    assertNoSecrets(JSON.stringify(events));
    assertNoSecrets(api.output);
  });

  await app.step('the health report lists the Admin SDK as observed and the API server as the same mode and project', async () => {
    const health = await hostJson<Health>(`${host.url}/__pyric/health`);
    assert.deepEqual(health.live?.admin, { mode: 'observed', observed: true, bypassesRules: true });
    await eventually(async () => (await hostJson<Health>(`${host.url}/__pyric/health`)).proxyTargets, (targets) => JSON.stringify(targets) === JSON.stringify([{ context: '/api', verdict: 'same' }]), 'the proxy targets');
  });

  await app.step('an ID token a pyric sandbox issued is refused by the server\'s token check, by name, and sends nothing', async () => {
    const before = { received: await replay.received(), admin: (await liveEvents(host.url)).filter(isAdmin).length };
    const response = await fetch(`${host.url}/api/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sandboxIdToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: 'auth/argument-error', pyricCode: 'PYRIC_MODE_MISMATCH' });
    assert.equal(await replay.received(), before.received);
    assert.equal((await liveEvents(host.url)).filter(isAdmin).length, before.admin);
  });

  await app.step('the health report bills the page\'s read and the server\'s Admin write', async () => {
    const expected = { reads: 1, writes: 1, deliveries: 0 };
    await eventually(async () => (await hostJson<Health>(`${host.url}/__pyric/health`)).live?.billed, (count) => JSON.stringify(count) === JSON.stringify(expected), 'the billed count');
  });

  await app.step('the replay had a recording for every request, and nothing reached any host but loopback', async () => {
    assert.deepEqual(await replay.unmatched(), []);
    assert.deepEqual(blockedLines(app), []);
    assert.doesNotMatch(api.output, /PYRIC_GUARD_BLOCKED/);
    await page.close();
    await api.stop();
    await host.process.stop();
  });
});
