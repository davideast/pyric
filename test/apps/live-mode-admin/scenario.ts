/**
 * Live mode serves and observes the Admin SDK in a Node server job, through
 * the packed packages. The notes app runs `vite dev` with `pyricLive()`, and
 * its server job (`server.mjs`) runs under `node --import @pyric/live/register`.
 * The job manages a user, checks ID tokens, and reads and writes notes in
 * Firestore, the Realtime Database and Cloud Storage with firebase-admin: the
 * calls capture A (Admin) recorded against production, plus a count query.
 *
 * Every call gets the answer production gave, and the live host's event
 * stream (`/__pyric/capture`) holds one Admin event per call, marked as
 * having bypassed Security Rules, with production's outcome, its path and its
 * bucket, and no token, email or password. The health report bills the
 * Firestore calls by the documents each read or wrote. An ID token a pyric
 * sandbox issued is refused by name, and `firebase-admin/security-rules`,
 * which no row serves, loads unobserved, with its line (ADR 0022, amendment
 * 2026-11-07).
 *
 * Live mode refuses Admin calls to another project before any request: a
 * job whose `GOOGLE_CLOUD_PROJECT` names one stops at start, and a job whose
 * Admin app names one has its first call and its count query refused.
 *
 * Node 22's require() never reaches the register's hooks, so there the job's
 * firebase-admin import is refused, naming Node 23. CI runs this app on Node
 * 24 as well.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * capture A (Admin). The job reaches it through firebase-admin's own emulator
 * variables. Like every app scenario this runs offline.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scenario, sleep, type App, type ExpectedCrash } from '../driver.ts';

const PROJECT = 'demo-live-admin';
const EMAIL = 'admin-capture@example.com';
const PASSWORD = 'notes-password';
const LIVE_REFUSED = 'PYRIC_LIVE_REFUSED';
const CAPTURE_ADMIN = fileURLToPath(new URL('../../../packages/conformance/src/capture/admin-live/recordings/capture-admin-wire.json', import.meta.url));
/** The client sign-in capture A ran is not an Admin call: the job signs no one in. */
const CLIENT_SIGN_IN = 'auth.clientSignIn';

/** Whether the `node` the app's processes run serves the Admin rows: Node 23 or later. */
const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;

export const expectedCrashes: ExpectedCrash[] = ADMIN_ROWS_ON
  ? [{
    message: /^Error: @pyric\/live: firebase-admin is refused in live mode, from a Node process: the environment variable GOOGLE_CLOUD_PROJECT names the project 'other'/,
    source: /^command \d+ \(node --import @pyric\/live\/register server\.mjs\)$/,
    reason: 'the step that starts the job with GOOGLE_CLOUD_PROJECT=other is refused at register start',
  }]
  : [{
    message: /^Error: @pyric\/live: firebase-admin\/app \(the Admin SDK\) is refused in live mode\. @pyric\/live observes firebase-admin on Node 23 or later/,
    source: /^command \d+ \(node --import @pyric\/live\/register server\.mjs\)$/,
    reason: 'on Node 22, whose require() skips the hooks, the Admin rows stay shut and the job is refused its import',
  }];

interface Replay {
  origin: string;
  grpc: string;
  /** How many requests the replay received, and how many it had no recording for. */
  traffic(): Promise<{ received: number; unmatched: number }>;
  unmatched(): Promise<unknown[]>;
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([], app.dir, { adminCapture: PROJECT }));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints?.grpc, `the replay server named no gRPC host:\n${server.output}`);
  return {
    origin: endpoints.origin,
    grpc: endpoints.grpc,
    traffic: async () => ({ received: (await receivedBy(endpoints.origin)).length, unmatched: (await unmatchedBy(endpoints.origin)).length }),
    unmatched: () => unmatchedBy(endpoints.origin),
  };
}

/** firebase-admin's own emulator variables, each at the replay, and the job's project. */
function jobEnv(replay: Replay, extra: Record<string, string> = {}): Record<string, string> {
  const host = new URL(replay.origin).host;
  return {
    NOTES_PROJECT: PROJECT,
    FIRESTORE_EMULATOR_HOST: replay.grpc,
    FIREBASE_AUTH_EMULATOR_HOST: host,
    FIREBASE_DATABASE_EMULATOR_HOST: host,
    STORAGE_EMULATOR_HOST: replay.origin,
    ...extra,
  };
}

function runJob(app: App, script: string, env: Record<string, string>) {
  return app.command('node', ['--import', '@pyric/live/register', script], { env, timeoutMs: 120_000 });
}

function resultOf<T>(output: string): T {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as T;
}

/** The answers production gave capture A's Admin calls, by case. */
function recordedAnswers(): Record<string, string> {
  const { results } = JSON.parse(readFileSync(CAPTURE_ADMIN, 'utf8')) as { results: Record<string, string> };
  return Object.fromEntries(Object.entries(results).filter(([op]) => op !== CLIENT_SIGN_IN));
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
  instance?: string;
  caller?: { kind?: string };
  detail?: { sdk?: string; bucket?: string };
  rulesDisposition?: { kind?: string; reason?: string };
  production?: { outcome?: { status?: string; code?: string } };
}

/** The host's Admin events, from `/__pyric/capture` with the session token `/__pyric/init.json` hands a loopback client. */
async function adminEvents(base: string): Promise<CapturedEvent[]> {
  const { sessionToken } = await hostJson<{ sessionToken: string }>(`${base}/__pyric/init.json`);
  const response = await fetch(`${base}/__pyric/capture`, { headers: { 'x-pyric-session-token': sessionToken } });
  if (response.status === 404) return [];
  assert.equal(response.status, 200, `/__pyric/capture answered ${response.status}`);
  const capture = await response.json() as { events?: CapturedEvent[] };
  return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.detail?.sdk === 'admin');
}

/** One line per Admin event: `<service> <method> <path> <outcome>`, in the order the job made them. */
function eventLine(event: CapturedEvent): string {
  const outcome = event.production?.outcome;
  const answer = outcome?.status === 'ok' ? 'ok' : `${outcome?.status} ${outcome?.code}`;
  return `${event.service} ${event.method} ${event.path ?? '-'} ${answer}`;
}

const RUN = 'pyric_oracle/replay';
const NOTES = `${RUN}/notes`;
const NOTE = `${RUN}/note.txt`;
/**
 * Each Admin call the job makes and production's answer, in order, as the
 * event stream holds them. A listener makes one event per delivery, and the
 * refused sandbox token makes none.
 */
const ADMIN_EVENTS: string[] = [
  'auth Auth.createUser - ok',
  'auth Auth.verifyIdToken - ok',
  'auth Auth.verifyIdToken - ok',
  'auth Auth.getUser - ok',
  'auth Auth.getUserByEmail - ok',
  'auth Auth.setCustomUserClaims - ok',
  'auth Auth.updateUser - ok',
  'auth Auth.revokeRefreshTokens - ok',
  'auth Auth.verifyIdToken - error auth/id-token-revoked',
  'auth Auth.deleteUser - ok',
  'auth Auth.getUser - error auth/user-not-found',
  `firestore DocumentReference.set ${NOTES}/a ok`,
  `firestore DocumentReference.get ${NOTES}/a ok`,
  `firestore DocumentReference.get ${NOTES}/missing ok`,
  `firestore DocumentReference.update ${NOTES}/a ok`,
  `firestore DocumentReference.update ${NOTES}/missing error not-found`,
  `firestore DocumentReference.create ${NOTES}/a error already-exists`,
  `firestore CollectionReference.add ${NOTES} ok`,
  `firestore Query.get ${NOTES} ok`,
  `firestore AggregateQuery.get ${NOTES} ok`,
  'firestore Firestore.getAll - ok',
  'firestore WriteBatch.commit - ok',
  'firestore Firestore.runTransaction - ok',
  `firestore Query.onSnapshot ${NOTES} ok`,
  `firestore Query.onSnapshot ${NOTES} ok`,
  `firestore DocumentReference.set ${NOTES}/d ok`,
  `firestore DocumentReference.delete ${NOTES}/a ok`,
  `rtdb Reference.set /${RUN} ok`,
  `rtdb Query.get /${RUN} ok`,
  `rtdb Reference.update /${RUN} ok`,
  `rtdb Reference.push /${RUN}/list ok`,
  `rtdb Reference.transaction /${RUN}/counter ok`,
  `rtdb Query.on /${RUN}/watch ok`,
  `rtdb Query.on /${RUN}/watch ok`,
  `rtdb Reference.set /${RUN}/watch ok`,
  `rtdb Query.once /${RUN}/missing ok`,
  `rtdb Reference.remove /${RUN} ok`,
  `storage File.save ${NOTE} ok`,
  `storage File.getMetadata ${NOTE} ok`,
  `storage File.exists ${NOTE} ok`,
  `storage File.download ${NOTE} ok`,
  'storage Bucket.getFiles - ok',
  `storage File.setMetadata ${NOTE} ok`,
  `storage File.download ${RUN}/missing.txt error storage/object-not-found`,
  `storage File.delete ${NOTE} ok`,
];
/**
 * What the health report bills for the Firestore calls: a read per document
 * each get, query and getAll returned (a missing document and the count
 * query bill one), a write per document each write, batch and delete
 * changed (the transaction bills one), and a delivery per document each
 * listener snapshot carried.
 */
const BILLED = { reads: 7, writes: 8, deliveries: 4 };

interface BilledCount {
  reads: number;
  writes: number;
  deliveries: number;
}

async function billed(url: string): Promise<BilledCount | undefined> {
  const health = await hostJson<{ live?: { billed?: BilledCount } }>(`${url}/__pyric/health`);
  return health.live?.billed;
}

/** The job's output and the host's events never hold its token, email or password. */
function assertNoSecrets(text: string): void {
  for (const secret of [EMAIL, PASSWORD, 'pyric-sandbox', 'eyJ']) assert.ok(!text.includes(secret), `the events hold ${secret}`);
}

export default scenario(async (app) => {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  const replay = await app.step('start the replay server that plays capture A (Admin) as production for the project', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  if (!ADMIN_ROWS_ON) {
    await app.step(`on Node ${NODE_VERSION}, the job's firebase-admin import is refused, naming Node 23`, async () => {
      const run = await runJob(app, 'server.mjs', jobEnv(replay));
      assert.notEqual(run.code, 0, run.output);
      assert.match(run.output, /@pyric\/live\/register: firebase-admin is refused in this process\. @pyric\/live observes firebase-admin on Node 23 or later/);
      assert.deepEqual(await replay.traffic(), { received: 0, unmatched: 0 });
      await host.process.stop();
    });
    return;
  }

  const job = await app.step('the server job under @pyric/live/register gets the answer production gave each Admin call', async () => {
    const run = await runJob(app, 'server.mjs', jobEnv(replay));
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: firebase-admin is observed for the Firebase project ${PROJECT}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    const { results, sandboxRefusal, counted } = resultOf<{ results: Record<string, string>; sandboxRefusal: string | null; counted: number | null }>(run.output);
    const { 'securityRules.import': securityRules, ...adminResults } = results;
    assert.deepEqual(adminResults, recordedAnswers());
    assert.equal(counted, 2, 'the count query counts the two notes');
    assert.equal(sandboxRefusal, 'PYRIC_MODE_MISMATCH', 'a sandbox ID token is refused by name');
    assert.equal(securityRules, 'ok', 'firebase-admin/security-rules loads unobserved');
    assert.match(run.output, /@pyric\/live\/register: firebase-admin\/security-rules loads unobserved\./);
    assert.deepEqual(await replay.unmatched(), []);
    return run;
  });

  await app.step('the event stream holds one Admin event per call, marked as bypassing Security Rules, with no token, email or password', async () => {
    const events = await eventually(() => adminEvents(host.url), (all) => all.length >= ADMIN_EVENTS.length, 'the Admin events');
    assert.deepEqual(events.map(eventLine), ADMIN_EVENTS);
    for (const event of events) {
      assert.equal(event.caller?.kind, 'node');
      assert.deepEqual(event.rulesDisposition, { kind: 'bypassed', reason: 'admin' });
      assert.equal(event.instance, undefined, 'every RTDB call went to the project\'s default instance');
    }
    const storage = events.filter((event) => event.service === 'storage');
    assert.ok(storage.length > 0);
    for (const event of storage) assert.equal(event.detail?.bucket, `${PROJECT}.firebasestorage.app`);
    assertNoSecrets(JSON.stringify(events));
    assertNoSecrets(job.output);
  });

  await app.step('the health report bills each Firestore read and write by its documents', async () => {
    await eventually(() => billed(host.url), (count) => JSON.stringify(count) === JSON.stringify(BILLED), 'the billed count');
  });

  await app.step('a job whose GOOGLE_CLOUD_PROJECT names another project stops at start, and sends nothing', async () => {
    const before = await replay.traffic();
    const run = await runJob(app, 'server.mjs', jobEnv(replay, { GOOGLE_CLOUD_PROJECT: 'other' }));
    assert.notEqual(run.code, 0, run.output);
    assert.match(run.output, /GOOGLE_CLOUD_PROJECT names the project 'other', and this live host serves 'demo-live-admin'/);
    assert.deepEqual(await replay.traffic(), before);
  });

  await app.step('a job whose Admin app names another project has its first call and its count query refused, and sends nothing', async () => {
    const before = await replay.traffic();
    const run = await runJob(app, 'wrong-project.mjs', jobEnv(replay));
    assert.equal(run.code, 0, run.output);
    assert.deepEqual(resultOf(run.output), {
      'firestore.get': LIVE_REFUSED,
      'firestore.count': LIVE_REFUSED,
      'auth.getUser': LIVE_REFUSED,
      'rtdb.get': LIVE_REFUSED,
      'storage.exists': LIVE_REFUSED,
    });
    assert.deepEqual(await replay.traffic(), before);
    assert.deepEqual(await replay.unmatched(), []);
  });

  await app.step('stop the dev server', async () => {
    await host.process.stop();
  });
});
