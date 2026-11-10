/**
 * Live mode observes the app's own Cloud Storage calls, through the packed
 * packages: the files app's page on `vite dev` with `pyricLive()`, and the
 * same client code as its server job under
 * `node --import @pyric/live/register`. On the default bucket and a second
 * one, two users sign in, a third client stays signed out, and the app runs
 * the sequence capture S recorded against production. The chip's Traffic
 * shows each call as production's, from the client that made it, with its
 * `gs://` path, production's answer and the account: ok uploads (one row per
 * resumable upload, the paused one included), reads, metadata, lists and
 * deletes, the two misses, and the denied upload, download, list and
 * signed-out upload. The host's event stream names each call's bucket, and
 * Storage calls add nothing to the billed count. The project's
 * `storage.rules` is loaded as the default bucket's local rules: each
 * default-bucket row shows what they say beside production's answer, and
 * the nested upload they have no rule for is drift. Last, the same page under
 * the sandbox (`pyric()`) shows its upload on a sandbox row under the app's
 * bucket name, not the sandbox's store key.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * capture S for this project and custom-token sign-ins. Each plane gets a
 * fresh one, since capture S's upload sessions and deletes are played once.
 * The app reaches it with the SDK's own emulator connectors (`?backend=` on
 * the page, `APP_BACKEND` for the server job). Like every app scenario this
 * runs offline, and the browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';
import { verifyObservedStorageBrowser } from './verify-observed-browser.ts';

const PROJECT = 'demo-live-storage';
const BUCKETS = { default: `${PROJECT}.firebasestorage.app`, second: `${PROJECT}-live-second` } as const;
const RUN = 'pyric_oracle/replay';
const DENIED = 'pyric_oracle_denied_storage/replay';
const SIGN_INS = 'sign-ins.json';
const BILLED_NONE = { reads: 0, writes: 0, deliveries: 0 };

declare function runApp(): Promise<unknown>;
declare function uploadNote(path: string): Promise<string>;

interface Replay {
  origin: string;
  unmatched(): Promise<unknown[]>;
  stop(): Promise<void>;
}

/** Custom-token sign-ins: `client-N` gets an anonymous ID token for `user-N`, the uid capture S's `<uid-N>` becomes. */
function signIns(format: string): Record<string, unknown> {
  const exchanges = [1, 2].flatMap((n) => {
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
      response: { status: 200, body: { kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: uid, lastLoginAt: '1793937599013', createdAt: '1793937599013' }] } },
    }];
  });
  return { format, project: PROJECT, source: 'hand-written from the Auth REST v1 wire format', exchanges };
}

/** The project's files a user's checkout has: `.firebaserc` names it, and the sign-ins recording the replay plays. */
async function writeProject(app: App): Promise<void> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' }, storage: { rules: 'storage.rules' } })}\n`);
  app.writeFile('storage.rules', LOCAL_RULES);
  app.writeFile(SIGN_INS, `${JSON.stringify(signIns(FORMAT))}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([`${app.dir}/${SIGN_INS}`], undefined, { storageCapture: PROJECT }));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints, `the replay server named no origin:\n${server.output}`);
  return { origin: endpoints.origin, unmatched: () => unmatchedBy(endpoints.origin), stop: () => server.stop() };
}

/** What capture S's sequence returns on each bucket, as production answered it. The page has no getStream. */
function expectedResults(source: 'page' | 'node'): Record<string, unknown> {
  const denied = 'storage/unauthorized';
  const missing = 'storage/object-not-found';
  const on = {
    'preflight': 0,
    'uploadBytes': 6,
    'uploadString-raw': 9,
    'uploadString-base64': 9,
    'uploadBytesResumable': 600 * 1024,
    'uploadBytesResumable-paused': 'paused and resumed',
    'getMetadata': 6,
    'getDownloadURL': true,
    'getBytes': 6,
    ...(source === 'node' ? { getStream: 6 } : {}),
    'updateMetadata': 'no-store',
    'setup-nested': 'ok',
    'list': [['a.bin', 'b64.bin'], ['big.bin'], ['nested']],
    'listAll': [['nested/two.txt'], ['nested/x']],
    'getMetadata-second-account': 6,
    'deleteObject': 'ok',
    'getMetadata-missing': missing,
    'deleteObject-missing': missing,
    'denied-upload': denied,
    'denied-getBytes': denied,
    'denied-list': denied,
    'signed-out-upload': denied,
    'cleanup': [0, 0],
  };
  return { default: on, second: on };
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
  if (!await chip.locator('[data-chip-tab=traffic]').isVisible()) await chip.locator('[data-expand]').click();
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
 * Every Storage row Traffic lists, scoped to all: the list shows the latest
 * 25, so it picks the Storage filter afresh, which follows new rows again,
 * and loads older rows until there are none.
 */
async function storageRows(chip: Locator): Promise<string[]> {
  await chip.locator('[data-chip-tab=traffic]').click();
  // Every client's requests: the From select on a live host, the All traffic switch on a sandbox host.
  const from = chip.locator('[data-traffic-from]');
  const scope = chip.locator('[data-traffic-scope]');
  await from.or(scope).first().waitFor();
  if (await from.count() > 0) await from.selectOption('all');
  else if (await scope.getAttribute('aria-checked') !== 'true') await scope.click();
  const service = chip.locator('[data-request-service]');
  await service.selectOption('');
  await service.selectOption('storage');
  const older = chip.locator('[data-request-older]');
  while (await older.count() > 0) await older.click();
  return readRows(chip);
}

/**
 * The rows capture S's sequence makes from `source` on both buckets, each
 * once however many times it ran.
 *
 * The second bucket's rows are answered from the default bucket's recording
 * with the bucket renamed (`../replay/storage-capture.ts`). No capture shows
 * production answering a second bucket the same way; the row's bucket comes
 * from the reference, which is what these rows check.
 */
function expectedRows(source: 'page' | 'node'): string[] {
  return Object.values(BUCKETS).flatMap((bucket) => {
    const row = (call: string, path: string, answer: 'succeeded' | 'denied' | 'failed', account: string) => `production ${source} storage.${call} gs://${bucket}/${path} Production ${answer} ${account}`;
    const one = (call: string, path: string, answer: 'succeeded' | 'failed' = 'succeeded') => row(call, `${RUN}/${path}`, answer, 'user-1');
    return [
      row('listAll', RUN, 'succeeded', 'user-1'),
      one('uploadBytes', 'a.bin'),
      one('uploadString', 'raw.txt'),
      one('uploadString', 'b64.bin'),
      one('uploadBytesResumable', 'big.bin'),
      one('uploadBytesResumable', 'paused.bin'),
      one('getMetadata', 'a.bin'),
      one('getDownloadURL', 'a.bin'),
      one('getBytes', 'a.bin'),
      ...(source === 'node' ? [one('getStream', 'a.bin')] : []),
      one('updateMetadata', 'a.bin'),
      one('uploadString', 'nested/x/one.txt'),
      one('uploadString', 'nested/two.txt'),
      row('list', RUN, 'succeeded', 'user-1'),
      one('listAll', 'nested'),
      row('getMetadata', `${RUN}/a.bin`, 'succeeded', 'user-2'),
      ...['a.bin', 'raw.txt', 'b64.bin', 'big.bin', 'paused.bin', 'nested/x/one.txt', 'nested/two.txt'].map((path) => one('deleteObject', path)),
      one('getMetadata', 'missing.bin', 'failed'),
      one('deleteObject', 'missing.bin', 'failed'),
      row('uploadBytes', `${DENIED}/forbidden.bin`, 'denied', 'user-2'),
      row('getBytes', `${DENIED}/forbidden.bin`, 'denied', 'user-2'),
      row('list', DENIED, 'denied', 'user-2'),
      row('uploadBytes', `${RUN}/signed-out.bin`, 'denied', 'signed out'),
    ];
  }).sort();
}

const distinct = (rows: string[]) => [...new Set(rows)].sort();

/**
 * The default bucket's local rules: signed-in users read, delete and upload
 * objects under 1 MiB directly in the run's folder. Nothing deeper matches,
 * so the local rules refuse the nested uploads production accepts.
 */
const LOCAL_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /${RUN}/{file} {
      allow read, delete: if request.auth != null;
      allow create: if request.auth != null && request.resource.size < 1024 * 1024;
    }
  }
}
`;

/** What a row's detail says about the local rules, and whether the row carries the drift marker. */
interface LocalReading {
  detail: string;
  drift: boolean;
}

/** The first `source` row for `call` on `gs://<default bucket>/<path>` by `account`, its drift marker, and the text of its detail. */
async function localReading(chip: Locator, source: 'page' | 'node', call: string, path: string, account: string): Promise<LocalReading> {
  await storageRows(chip);
  const target = `gs://${BUCKETS.default}/${path}`;
  const row = chip.locator(`[data-traffic-rows] [data-request-row][data-traffic-row-call="storage.${call}"][data-traffic-row-identity="${account}"]`)
    .filter({ has: chip.page().locator(`[data-traffic-row-source="${source}"]`) })
    .filter({ has: chip.page().locator('.c2', { hasText: target }) })
    .filter({ hasNot: chip.page().locator('.c2', { hasText: `${target}/` }) })
    .first();
  const drift = await row.locator('[data-traffic-row-drift]').count() > 0;
  await row.click();
  const detail = await chip.locator('[data-traffic-detail]').textContent() ?? '';
  await chip.locator('[data-request-back]').click();
  return { detail, drift };
}

/** Each default-bucket upload from `source` reads the local rules' verdict, and the nested upload they refuse is drift. */
async function expectLocalVerdicts(chip: Locator, source: 'page' | 'node'): Promise<void> {
  const upload = await localReading(chip, source, 'uploadBytes', `${RUN}/a.bin`, 'user-1');
  assert.match(upload.detail, /Local rules allowed this request\./, upload.detail);
  assert.match(upload.detail, /Line 6/, upload.detail);
  assert.equal(upload.drift, false);
  const nested = await localReading(chip, source, 'uploadString', `${RUN}/nested/two.txt`, 'user-1');
  assert.match(nested.detail, /Local rules did not allow this request\./, nested.detail);
  assert.match(nested.detail, /The local rules file differs from the deployed rules/, nested.detail);
  assert.equal(nested.drift, true, 'the upload the local rules refuse is drift');
  const signedOut = await localReading(chip, source, 'uploadBytes', `${RUN}/signed-out.bin`, 'signed out');
  assert.match(signedOut.detail, /Local rules did not allow this request\./, signedOut.detail);
  assert.equal(signedOut.drift, false, 'production denied it too');
}

/** The chip shows each of capture S's calls from `source` once or more, as production's, and nothing else from it. */
async function expectRows(chip: Locator, source: 'page' | 'node'): Promise<void> {
  const expected = expectedRows(source);
  const fromSource = (rows: string[]) => distinct(rows.filter((row) => row.split(' ')[1] === source));
  const rows = await eventually(() => storageRows(chip), (all) => JSON.stringify(fromSource(all)) === JSON.stringify(expected), `the Storage rows from ${source}`);
  // One row per upload task, however many chunks it sent.
  const resumable = rows.filter((row) => row.split(' ')[1] === source && row.includes(' storage.uploadBytesResumable '));
  assert.equal(resumable.length, 4, `one row per resumable upload on each bucket from ${source}:\n${resumable.join('\n')}`);
}

interface CapturedEvent {
  kind?: string;
  service?: string;
  method?: string;
  path?: string;
  detail?: { bucket?: string };
  production?: { local?: { result?: string; drift?: boolean } };
}

/** The Storage operations the host's event stream carried, as it wrote them to the session capture. */
function storageEvents(app: App): CapturedEvent[] {
  try {
    const capture = JSON.parse(app.readFile('.pyric/last-session.json')) as { events?: CapturedEvent[] };
    return (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'storage');
  } catch {
    return [];
  }
}

/** Observed calls one plane's run sends the host on each bucket: the page's 31, and getStream too on the server job's. */
const CALLS_PER_BUCKET = { page: 31, node: 32 } as const;

/** The host's Storage events once `count` are written, and no more: each names a bucket in `detail.bucket`, and both buckets appear. */
async function expectBuckets(app: App, count: number): Promise<void> {
  const events = await eventually(async () => storageEvents(app), (all) => all.length >= count, `${count} Storage events on the host`);
  assert.equal(events.length, count, `one event per observed call:\n${events.map((event) => `${event.method} ${event.detail?.bucket} ${event.path}`).join('\n')}`);
  const buckets = new Set(Object.values(BUCKETS) as string[]);
  assert.deepEqual(events.filter((event) => !buckets.has(event.detail?.bucket ?? '')), [], 'every Storage event names its bucket in detail.bucket');
  for (const bucket of buckets) assert.ok(events.some((event) => event.detail?.bucket === bucket), `an event on ${bucket}`);
}

/** `run`, or a failure naming `what` once `ms` pass without it settling. */
async function within<T>(ms: number, what: string, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms / 1000}s`)), ms); });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

/** The app's sandbox setup: `pyric()` in place of `pyricLive()`, with Storage rules that allow every call. */
function useSandbox(app: App): void {
  app.writeFile('vite.config.js', 'import { defineConfig } from "vite";\nimport { pyric } from "@pyric/cli/vite";\n\nexport default defineConfig({ plugins: [pyric()] });\n');
  app.writeFile('storage.rules', "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{path=**} { allow read, write: if true; }\n  }\n}\n");
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' }, storage: { rules: 'storage.rules' } })}\n`);
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
  const pageReplay = await app.step('start the replay server that plays capture S for the page', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const page = await app.step('the page runs capture S\'s sequence on the default and the second bucket', async () => {
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(pageReplay.origin)}`);
    const status = () => opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    await eventually(status, (text) => text === 'Ready', 'the page loads its client code').catch((error: Error) => {
      throw new Error(`${error.message}\nconsole:\n${app.browserLog.join('\n')}`);
    });
    const results = await within(60_000, 'the page\'s capture S sequence', opened.evaluate(() => runApp()));
    assert.deepEqual(results, expectedResults('page'));
    assert.deepEqual(await pageReplay.unmatched(), []);
    return opened;
  });

  const chip = await app.step('the chip shows each page call as production\'s, with its bucket, path, answer and account', async () => {
    const opened = await openChip(page);
    await opened.locator('.panel-header [data-chip-live]').waitFor({ timeout: 20_000 });
    const health = await (await fetch(`${host.url}/__pyric/health`)).json() as { live?: { projectId?: string } };
    assert.equal(health.live?.projectId, PROJECT);
    await expectRows(opened, 'page');
    return opened;
  });

  await app.step('each default-bucket page upload reads the local rules\' verdict, and the nested one they refuse is drift', async () => {
    await expectLocalVerdicts(chip, 'page');
  });

  await app.step('the host\'s event stream names each call\'s bucket in detail.bucket', async () => {
    await expectBuckets(app, 2 * CALLS_PER_BUCKET.page);
  });

  await app.step('Storage calls add nothing to the billed count', async () => {
    assert.deepEqual(await billed(host.url), BILLED_NONE);
  });

  await pageReplay.stop();
  const nodeReplay = await app.step('start a fresh replay server for the server job', () => startReplay(app));

  await app.step('the server job under @pyric/live/register runs the same sequence, getStream included, reporting to the dev server', async () => {
    const run = await app.command('node', ['--import', '@pyric/live/register', 'client.js'], { env: { APP_BACKEND: nodeReplay.origin }, timeoutMs: 120_000 });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`@pyric/live/register: live mode for the Firebase project ${PROJECT}\\.`));
    assert.match(run.output, /@pyric\/live\/register: reporting calls to the live host at /);
    assert.deepEqual(resultOf(run.output), expectedResults('node'));
    assert.deepEqual(await nodeReplay.unmatched(), []);
  });

  await app.step('the chip shows each server job call as production\'s, from a Node process', async () => {
    await expectRows(chip, 'node');
    assert.ok(await chip.locator('[data-traffic-row-source=node]').count() > 0, 'the server job\'s rows carry the node source');
    assert.deepEqual(await billed(host.url), BILLED_NONE);
    await expectBuckets(app, 2 * (CALLS_PER_BUCKET.page + CALLS_PER_BUCKET.node));
  });

  await app.step("Studio's Billable metrics and Rules subtabs count observed Storage operations and surface local Storage rules drift", async () => {
    const context = await app.browser();
    const fontHosts = /^https:\/\/(use\.typekit\.net|fonts\.googleapis\.com)\//;
    await context.route(fontHosts, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const studio = await app.page(`${host.url}/__pyric/ui/traffic?view=billable`);
    const opPanel = studio.locator('[data-pyric-billable-panel="operation"]');
    const opMetric = async (key: string) => Number(((await opPanel.locator(`[data-pyric-metric-key="${key}"] [data-pyric-metric-value]`).textContent()) ?? '0').replace(/,/g, ''));

    await studio.locator('[data-pyric-ui="traffic-billable-view"]').waitFor({ timeout: 30_000 });
    await eventually(async () => ({
      reads: await opMetric('reads'),
      writes: await opMetric('writes'),
      deletes: await opMetric('deletes'),
    }), ({ reads, writes, deletes }) => reads === 18 && writes === 56 && deletes === 28, 'exact Storage Class B reads (18), Class A uploads/lists/metadata updates (56), and deletes (28)');

    const captured = storageEvents(app);
    const expectedAllows = captured.filter((event) => event.production?.local?.result === 'allow').length;
    const expectedDenies = captured.filter((event) => event.production?.local?.result === 'deny').length;
    const expectedDrift = captured.filter((event) => event.production?.local?.drift === true).length;
    assert.ok(expectedAllows >= 20 && expectedDenies >= 6 && expectedDrift >= 2, `unexpected captured Storage verdicts: allows=${expectedAllows}, denies=${expectedDenies}, drift=${expectedDrift}`);

    await studio.getByRole('tab', { name: 'Rules' }).click();
    await studio.locator('[data-pyric-ui="traffic-rules-view"]').waitFor({ timeout: 30_000 });
    const rulesMetric = async (key: string) => Number(((await studio.locator(`[data-pyric-metric-key="${key}"] [data-pyric-metric-value]`).textContent()) ?? '0').replace(/,/g, ''));
    await eventually(async () => ({
      allows: await rulesMetric('allows'),
      denies: await rulesMetric('denies'),
    }), ({ allows, denies }) => allows === expectedAllows && denies === expectedDenies, `exact Storage advisory local rules allows (${expectedAllows}) and denies (${expectedDenies})`);
    const summary = (await studio.locator('[data-pyric-live-rules-summary]').textContent()) ?? '';
    assert.match(summary, new RegExp(`Drift with production: ${expectedDrift}\\b`), `expected Storage drift count ${expectedDrift} in "${summary}"`);
    assert.match(summary, /Denied by production: 16\b/, `expected Storage production denial count 16 in "${summary}"`);

    await studio.close();
    await context.unroute(fontHosts);
  });

  await app.step("Studio's Storage surface browses read-only observed client and Admin object metadata across buckets with verbatim metadata and zero bytes buffered, while Auth stays gated", async () => {
    await verifyObservedStorageBrowser(app, host.url, page);
  });

  await app.step('nothing reached any host but loopback', async () => {
    assert.deepEqual(blockedLines(app), []);
    await page.close();
    await host.process.stop();
    await nodeReplay.stop();
  });

  await app.step('under the sandbox, the page\'s upload shows on a sandbox row under the app\'s bucket name', async () => {
    useSandbox(app);
    const sandboxHost = await app.devServer();
    const opened = await app.page(sandboxHost.url);
    await opened.waitForFunction(() => 'uploadNote' in window);
    assert.equal(await opened.evaluate(() => uploadNote('notes/a.bin')), BUCKETS.default);
    const sandboxChip = await openChip(opened);
    // The sandbox keeps the default bucket under the store key pyric-default; the row reads the app's bucket name.
    const expected = [`sandbox page storage.create gs://${BUCKETS.default}/notes/a.bin - `];
    await eventually(() => storageRows(sandboxChip), (rows) => JSON.stringify(rows) === JSON.stringify(expected), 'the sandbox upload row');
    assert.deepEqual(blockedLines(app), []);
    await opened.close();
    await sandboxHost.process.stop();
  });
});
