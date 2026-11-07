/**
 * Live mode on the app layout #2113 reported, rebuilt from the report: npm
 * workspaces with the web app in `web/`, whose `firebase` and `vite` the
 * workspace install hoists to the repository root, and pyric, `@pyric/cli`
 * and `@pyric/live` pinned in `rules/`, a package outside the workspaces that
 * the app's own install never carries. `web/vite.config.ts` loads
 * `pyricLive()` from `rules/` with createRequire and no pass-through list.
 * The app's one Firebase init module,
 * `web/src/firebase.ts`, imports `firebase/ai`, `firebase/app`,
 * `firebase/auth`, `firebase/database`, `firebase/messaging` and
 * `firebase/storage`, and sets up every service on one app.
 *
 * The dev server starts from `web/`, as a workspace's `npm run dev` starts
 * it, and the page loads. Its calls show in the chip's Traffic as
 * production's, each once: the Realtime Database write and read, the Storage
 * upload and metadata read, and the AI Logic call, which production answers
 * 401 for a project that enforces App Check, since this app sends no App
 * Check token. Cloud Messaging is a live row too: the page gets it on the
 * same app with no list entry, nothing refuses it, and `getMessaging` makes
 * no row.
 *
 * Production is a replay server this scenario starts (`../replay/`), playing
 * RTDB capture A, Storage capture S and custom-token sign-ins, and answering
 * AI Logic from the committed observations. The page reaches it through the
 * SDK's own emulator connectors and the model's `baseUrl` (`?backend=`). Like
 * every app scenario this runs offline, and the browser blocks every host but
 * loopback.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';

const PROJECT = 'demo-live-2113';
const BUCKET = `${PROJECT}.firebasestorage.app`;
const MODEL = 'gemini-flash-lite-latest';
const SIGN_INS = 'sign-ins.json';
/** The init module's imports that live rows serve: never given a pass-through line. */
const LIVE_ROW_IMPORTS = ['firebase/app', 'firebase/auth', 'firebase/database', 'firebase/ai', 'firebase/messaging', 'firebase/storage'];

declare function runApp(): Promise<unknown>;

interface Replay {
  origin: string;
  /** Every request the replay had no recording for, but the browser SDK's long-poll starts (see `isLongPollStart`). */
  unmatched(): Promise<unknown[]>;
  stop(): Promise<void>;
}

function passThroughLine(specifier: string): string {
  return `${specifier} passes through to production: its calls are not observed and still bill.`;
}

/** Custom-token sign-ins: `client-1` gets an anonymous ID token for `user-1`, the uid both captures' `<uid-1>` becomes. */
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

/** The project's files at the repository root: `.firebaserc` names it, and the sign-ins recording the replay plays. */
async function writeProject(app: App): Promise<void> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'web/dist' } })}\n`);
  app.writeFile(SIGN_INS, `${JSON.stringify(signIns(FORMAT))}\n`);
}

/**
 * The browser SDK's long-poll start (`GET /.lp?start=t`), which the replay
 * does not serve: the SDK falls back to the WebSocket the capture recorded
 * (see `../live-mode-rtdb/scenario.ts`).
 */
function isLongPollStart(entry: unknown): boolean {
  const { rpc, request } = entry as { rpc?: string; request?: { method?: string; path?: string } };
  return rpc === 'http' && request?.method === 'GET' && (request.path ?? '').startsWith('/.lp?start=t&');
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([`${app.dir}/${SIGN_INS}`], undefined, { rtdbCapture: PROJECT, storageCapture: PROJECT, ai: true }));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints, `the replay server named no origin:\n${server.output}`);
  return {
    origin: endpoints.origin,
    unmatched: async () => (await unmatchedBy(endpoints.origin)).filter((entry) => !isLongPollStart(entry)),
    stop: () => server.stop(),
  };
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

/** Starts `vite dev` from web/, as the workspace's dev script does, and waits until it serves. */
async function startViteDev(app: App) {
  const port = await app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const vite = app.commandProcess('node', ['../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: 'web' });
  await vite.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
  const serves = () => fetch(`${url}/__pyric/init.json`).then((response) => response.ok, () => false);
  await eventually(serves, (ok) => ok, `${url}/__pyric/init.json answers`, 60_000);
  return { url, vite };
}

/** The chip, opened. */
async function openChip(page: Page): Promise<Locator> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  if (!await chip.locator('[data-chip-tab=traffic]').isVisible()) await chip.locator('[data-expand]').click();
  return chip;
}

/**
 * Every Traffic row for `service` (every service for ''), scoped to all, as
 * `<served> <source> <call> <target> <answer> <account>`: an AI row's target
 * is its requested and routed model. The list shows the latest 25, so it
 * picks the filter afresh, which follows new rows again, and loads older
 * rows until there are none.
 */
async function rows(chip: Locator, service: string): Promise<string[]> {
  await chip.locator('[data-chip-tab=traffic]').click();
  // On a live host the scope is the From select: every client's requests.
  await chip.locator('[data-traffic-from]').selectOption('all');
  const filter = chip.locator('[data-request-service]');
  await filter.selectOption(service === '' ? 'rtdb' : '');
  await filter.selectOption(service);
  const older = chip.locator('[data-request-older]');
  while (await older.count() > 0) await older.click();
  return chip.locator('[data-traffic-rows] [data-request-row]').evaluateAll((elements) => elements.map((element) => {
    const models = [...element.querySelectorAll('.c2 .ai-model-pair span')].map((span) => span.textContent);
    return [
      element.querySelector('[data-traffic-row-production]') ? 'production' : 'sandbox',
      element.querySelector('[data-traffic-row-source]')?.getAttribute('data-traffic-row-source') ?? '-',
      (element.querySelector('.c1')?.textContent ?? '').split(' · ').at(-1),
      models.length > 0 ? models.join(' ') : element.querySelector('.c2')?.textContent ?? '',
      element.querySelector('[data-verdict-production]')?.getAttribute('title') ?? '-',
      element.querySelector('.s2')?.textContent ?? '',
    ].join(' ');
  }));
}

const row = (call: string, target: string, answer: 'succeeded' | 'failed') => `production page ${call} ${target} Production ${answer} user-1`;

/** The rows the page's calls make, by service, each once. */
const EXPECTED_ROWS: Record<string, string[]> = {
  rtdb: [
    row('rtdb.get', '/pyric-live-capture/replay/items/a', 'succeeded'),
    row('rtdb.set', '/pyric-live-capture/replay/items/a', 'succeeded'),
  ],
  storage: [
    row('storage.getMetadata', `gs://${BUCKET}/pyric_oracle/replay/a.bin`, 'succeeded'),
    row('storage.uploadBytes', `gs://${BUCKET}/pyric_oracle/replay/a.bin`, 'succeeded'),
  ],
  ai: [row('ai.generateContent', `Requested ${MODEL} Routed to Not reported`, 'failed')],
};

/** What the page's calls return, as production answered them. */
const EXPECTED_RESULT = { uid: 'user-1', get: { n: 1, s: 'alpha' }, uploadBytes: 6, getMetadata: 6, generateContent: 'http 401' };

/** The page's requests, decoded, for the modules Vite serves at `/@id/__x00__pyric-live:<specifier>`: the live rows. */
function rowModulesIn(requested: string[]): string[] {
  const prefix = '/@id/__x00__pyric-live:';
  return requested.map((url) => decodeURIComponent(new URL(url).pathname)).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  await writeProject(app);

  await app.step('the workspace install hoists the web app\'s firebase and vite to the root, and pyric installs only in rules/', async () => {
    assert.ok(lstatSync(join(app.dir, 'node_modules', 'web')).isSymbolicLink(), 'npm links the web workspace into the root install');
    assert.equal(realpathSync(join(app.dir, 'node_modules', 'web')), realpathSync(join(app.dir, 'web')));
    for (const name of ['firebase', 'vite']) assert.ok(existsSync(join(app.dir, 'node_modules', name)), `${name} is hoisted to the root`);
    await app.installProject('rules');
    for (const dir of ['node_modules', 'web/node_modules']) {
      for (const name of ['pyric', '@pyric']) assert.equal(existsSync(join(app.dir, dir, name)), false, `${dir} has no ${name}`);
    }
    assert.ok(existsSync(join(app.dir, 'rules', 'node_modules', '@pyric', 'live')), 'rules/ has @pyric/live');
  });

  const replay = await app.step('start the replay server that plays the captures and the sign-ins and answers AI Logic', () => startReplay(app));

  const host = await app.step('vite dev from web/ starts in live mode with pyricLive() from rules/, and passes nothing through', async () => {
    const started = await startViteDev(app);
    for (const specifier of LIVE_ROW_IMPORTS) {
      assert.ok(!started.vite.output.includes(passThroughLine(specifier)), `${specifier} got a pass-through line:\n${started.vite.output}`);
    }
    const health = await (await fetch(`${started.url}/__pyric/health`)).json() as { live?: { passThrough?: string[] } };
    assert.ok(health.live, 'the dev server reports live status');
    assert.equal(health.live.passThrough, undefined, 'the health report lists no pass-through import');
    return started;
  });

  const { page, chip } = await app.step('the page loads the init module: database, ai, storage and messaging are live rows', async () => {
    const requested: string[] = [];
    (await app.browser()).on('request', (request) => requested.push(request.url()));
    const opened = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
    await opened.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
    const status = await opened.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.equal(status, 'Ready', `the page did not load\nconsole:\n${app.browserLog.join('\n')}`);
    assert.deepEqual(app.browserLog.filter((line) => line.includes('PYRIC_LIVE_REFUSED')), []);
    const served = rowModulesIn(requested);
    for (const specifier of ['firebase/database', 'firebase/ai', 'firebase/storage', 'firebase/messaging']) {
      assert.ok(served.includes(specifier), `the page's ${specifier} is not the live row module:\n${served.join('\n')}`);
    }
    const openedChip = await openChip(opened);
    await openedChip.locator('.panel-header [data-chip-live]').waitFor({ timeout: 20_000 });
    const health = await (await fetch(`${host.url}/__pyric/health`)).json() as { live?: { projectId?: string; passThrough?: string[] } };
    assert.equal(health.live?.projectId, PROJECT);
    assert.equal(health.live?.passThrough, undefined, 'the health report lists no pass-through import');
    return { page: opened, chip: openedChip };
  });

  await app.step('the page\'s calls reach production, which answers each one from a recording', async () => {
    assert.deepEqual(await page.evaluate(() => runApp()), EXPECTED_RESULT);
    assert.deepEqual(await replay.unmatched(), []);
  });

  for (const [service, expected] of Object.entries(EXPECTED_ROWS)) {
    await app.step(`the chip's Traffic shows the page's ${service} calls as production's, each once`, async () => {
      await eventually(() => rows(chip, service), (listed) => JSON.stringify([...listed].sort()) === JSON.stringify(expected), `the ${service} rows`);
    });
  }

  await app.step('getMessaging makes no row: Traffic lists only the auth, rtdb, storage and ai calls', async () => {
    const all = await rows(chip, '');
    const services = new Set(all.map((listed) => listed.split(' ')[2]?.split('.')[0]));
    assert.deepEqual([...services].filter((service) => !['auth', 'rtdb', 'storage', 'ai'].includes(service ?? '')), [], all.join('\n'));
    for (const expected of Object.values(EXPECTED_ROWS).flat()) assert.ok(all.includes(expected), `${expected} is in the unfiltered list:\n${all.join('\n')}`);
  });

  await app.step('nothing reached any host but loopback, and production had a recording for every request', async () => {
    assert.deepEqual(blockedLines(app), []);
    assert.deepEqual(await replay.unmatched(), []);
    await page.close();
    await host.vite.stop();
    await replay.stop();
  });
});
