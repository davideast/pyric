/**
 * Live mode observes the app's own Cloud Messaging calls, through the packed
 * packages: the alerts app's page on `vite dev` with `pyricLive()`, its
 * module service worker served through the same plugin, and the worker file
 * under `node --import @pyric/live/register`. The page asks for a token twice
 * (the second is answered from the SDK's IndexedDB, with no request), hears a
 * foreground message, navigates away so its service worker hears a
 * background one, comes back, deletes the token, and asks for a token on an
 * app whose API key production refuses. The chip's Traffic shows each call
 * and delivery as production's, from the realm that made it, with the
 * Installations and FCM registrations requests each call made and
 * production's answer, and nothing for `isSupported` or the second getToken.
 * The FID registration calls, `register` and `onRegistered`, throw live
 * mode's refusal, send no request and make no row.
 * The host's event stream carries each call's requests and no token, key or
 * payload text, and Messaging adds nothing to the billed count. In Node the
 * worker file loads both Messaging entries with no refusal and sends no row.
 *
 * Production is a replay server this scenario starts (`../replay/`), serving
 * capture M for this project. The browser relays the Installations and
 * registrations hosts to it (`../replay/messaging-browser.ts`), so the SDK's
 * own `fetch` still sends each request. The push service is the one part
 * that is not production's path: Chromium has no push service here, so a
 * stand-in subscribes and CDP delivers each push to the real service worker
 * (D2 in the Messaging plan). The browser is Chromium's own headless mode,
 * since the headless shell reads notification permission as denied, and it
 * reports itself online, since the offline namespace makes Installations
 * refuse every call. Like every app scenario this runs offline, and the
 * browser blocks every host but loopback.
 */
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { guardContext, launchScenarioBrowser, scenario, sleep, type App, type DevServer } from '../driver.ts';

const PROJECT = 'demo-live-messaging';
const BILLED_NONE = 'Billed calls: 0 reads, 0 writes, 0 documents delivered to listeners';
const LAST_BACKGROUND = '/last-background-message';

interface Settled { ok: boolean; value?: unknown; code?: string; message?: string }

interface Alerts {
  isSupported(): Promise<boolean>;
  getToken(): Promise<Settled>;
  deleteToken(): Promise<Settled>;
  getTokenWithBadKey(): Promise<Settled>;
  register(): Promise<Settled>;
  onRegistered(): Promise<Settled>;
  foreground: unknown[];
}

declare const alerts: Alerts;

interface Replay {
  origin: string;
  unmatched(): Promise<unknown[]>;
  messagingReceived(): Promise<unknown[]>;
  stop(): Promise<void>;
}

/** The project's files a user's checkout has: `.firebaserc` names it. */
function writeProject(app: App): void {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  app.writeFile('firebase.json', `${JSON.stringify({ hosting: { public: 'public' } })}\n`);
}

async function startReplay(app: App): Promise<Replay> {
  const { replayServerArgs, endpointsIn, receivedBy, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([], undefined, { messagingCapture: PROJECT }));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints, `the replay server named no origin:\n${server.output}`);
  const messagingReceived = async () => (await receivedBy(endpoints.origin)).flatMap((entry) => ('rpc' in entry && entry.rpc === 'messaging' ? [entry.message] : []));
  return { origin: endpoints.origin, unmatched: () => unmatchedBy(endpoints.origin), messagingReceived, stop: () => server.stop() };
}

/**
 * Makes `Date.now()` in every page of `context` never go back. Under load
 * this machine's wall clock can step back about 2 s, and
 * `@firebase/installations` reads an auth token made after `Date.now()` as
 * invalid (`now < creationTime`) and asks for a new one, which capture M
 * holds no answer for. A user's clock can step back too, but the scenario is
 * not about that. The floor lives in `localStorage`, as the push stand-in's
 * subscription does, so it outlives the trip to about:blank and the reload.
 * It is not Playwright's fake clock, which could move `performance.now()`
 * against the Resource Timing window the live row reads. The service worker
 * needs none: in this flow it never calls Installations (delivery metrics
 * export is off), and init scripts do not reach it.
 */
async function neverStepBack(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const STORED = 'pyric-scenario-clock-floor';
    const realNow = Date.now.bind(Date);
    const read = () => {
      try {
        return Number(localStorage.getItem(STORED)) || 0;
      } catch {
        return 0;
      }
    };
    let floor = read();
    Date.now = () => {
      const now = Math.max(realNow(), floor);
      if (now === floor) return now;
      floor = now;
      try {
        localStorage.setItem(STORED, String(now));
      } catch {
        // An opaque origin such as about:blank has no storage; the app's origin keeps the floor.
      }
      return now;
    };
  });
}

/**
 * The scenario's own Chromium: its own headless mode, with every host but
 * loopback blocked, the two Messaging hosts relayed to the replay, the push
 * stand-in, `navigator.onLine` true, and notifications granted to the app.
 */
async function openBrowser(app: App, replay: Replay, host: DevServer): Promise<{ browser: Browser; context: BrowserContext }> {
  const { installPushStandIn, reportOnline, routeMessagingTo } = await import('../replay/messaging-browser.ts');
  const browser = await launchScenarioBrowser({ channel: 'chromium' });
  const context = await browser.newContext();
  await guardContext(context, app.browserLog as string[]);
  await app.watchCrashes(context);
  await routeMessagingTo(context, replay.origin);
  await installPushStandIn(context);
  await reportOnline(context);
  await neverStepBack(context);
  await context.grantPermissions(['notifications'], { origin: host.url });
  return { browser, context };
}

/** A page of `context`, logged as the driver logs its own pages. */
async function newPage(app: App, context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const log = app.browserLog as string[];
  page.on('console', (message) => log.push(`[page console.${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => log.push(`[page error] ${error.stack || `${error.name}: ${error.message}`}`));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    log.push(`[page response ${response.status()}] ${response.request().method()} ${response.url()}`);
    app.noteErrorResponse(response.status(), response.request().method(), response.url());
  });
  return page;
}

/** Opens the app and waits for its page code, failing with the status line and the console when it does not load. */
async function openApp(app: App, page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'Starting', undefined, { timeout: 30_000 });
  const status = await page.evaluate(() => document.querySelector('#status')?.textContent ?? '');
  assert.equal(status, 'Ready', `the page's code did not load\nconsole:\n${app.browserLog.join('\n')}`);
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

/** The background message the service worker's handler kept, read in the worker itself, or null before it ran. */
async function lastBackgroundMessage(context: BrowserContext): Promise<unknown> {
  const worker = context.serviceWorkers()[0];
  if (worker === undefined) return null;
  return worker.evaluate(async (key) => {
    const kept = await (await caches.open('alerts')).match(key);
    return kept ? kept.json() : null;
  }, LAST_BACKGROUND);
}

/** Received calls with the FID or token a path names replaced, for a failure message. */
function withoutIds(received: unknown[]): unknown[] {
  return received.map((entry) => {
    const path = (entry as { path?: unknown }).path;
    if (typeof path !== 'string') return entry;
    return { ...(entry as object), path: path.replace(/\/(installations|registrations)\/[^/]+/, '/$1/<id>') };
  });
}

/**
 * The Installations entries the SDK keeps in IndexedDB, as their statuses and
 * times only (no FID or token), and the page's `Date.now()`, for a failed
 * deleteToken's message. Read before the call: a refused token request
 * overwrites the entry.
 */
async function installationEntries(page: Page): Promise<unknown> {
  return page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('firebase-installations-database');
    open.onerror = () => resolve(`open failed: ${String(open.error)}`);
    open.onsuccess = () => {
      const db = open.result;
      const store = db.transaction(db.objectStoreNames[0]!).objectStore(db.objectStoreNames[0]!);
      const all = store.getAll();
      all.onsuccess = () => resolve({ now: Date.now(), entries: (all.result as Array<{ registrationStatus: number; authToken?: { requestStatus: number; creationTime?: number; expiresIn?: number; requestTime?: number } }>).map((entry) => ({ registrationStatus: entry.registrationStatus, authToken: { requestStatus: entry.authToken?.requestStatus, creationTime: entry.authToken?.creationTime, expiresIn: entry.authToken?.expiresIn, requestTime: entry.authToken?.requestTime } })) });
      all.onerror = () => resolve(`getAll failed: ${String(all.error)}`);
    };
  }));
}

/** The chip, opened. */
async function openChip(page: Page): Promise<Locator> {
  const chip = page.locator('[data-pyric-runtime-chip-host]');
  await chip.waitFor({ state: 'attached', timeout: 30_000 });
  if (!await chip.locator('[data-chip-tab=traffic]').isVisible()) await chip.locator('[data-expand]').click();
  return chip;
}

interface Row {
  id: string;
  /** `<served> <source> <call> | <requests> | <answer> | <account>`. */
  text: string;
}

/**
 * Every Messaging row Traffic lists, scoped to all. The service filter has no
 * Messaging option yet, so it lists every service, loads older rows until
 * there are none, and keeps the rows whose call is a Messaging one.
 */
async function messagingRows(chip: Locator): Promise<Row[]> {
  await chip.locator('[data-chip-tab=traffic]').click();
  await chip.locator('[data-traffic-scope=all]').click();
  const service = chip.locator('[data-request-service]');
  await service.selectOption('storage');
  await service.selectOption('');
  const older = chip.locator('[data-request-older]');
  while (await older.count() > 0) await older.click();
  const rows = await chip.locator('[data-traffic-rows] [data-request-row]').evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-request-row') ?? '',
    text: [
      [
        element.querySelector('[data-traffic-row-production]') ? 'production' : 'sandbox',
        element.querySelector('[data-traffic-row-source]')?.textContent ?? '-',
        (element.querySelector('.c1')?.textContent ?? '').split(' · ').at(-1),
      ].join(' '),
      element.querySelector('.c2')?.textContent ?? '',
      element.querySelector('[data-verdict-production]')?.getAttribute('title') ?? '-',
      element.querySelector('.s2')?.textContent ?? '',
    ].join(' | '),
  })));
  return rows.filter((row) => / messaging\./.test(row.text.split(' | ')[0] ?? ''));
}

/**
 * The rows the page's sequence makes, sorted: the first getToken with the
 * Installations create and registrations create it sent, the foreground and
 * background deliveries, the deleteToken with its registrations delete, and
 * the bad-key getToken with the Installations create production refused
 * (capture M: 400 INVALID_ARGUMENT, which reads failed, not denied). The
 * second and third getToken and `isSupported` sent no request, and the
 * refused `register` and `onRegistered` never ran: none makes a row.
 */
function expectedRows(): string[] {
  const row = (source: string, call: string, requests: string, answer: 'succeeded' | 'failed') => `production ${source} messaging.${call} | ${requests} | Production ${answer} | signed out`;
  return [
    row('This page', 'getToken', 'Installations create, 200; registrations create, 200', 'succeeded'),
    row('This page', 'onMessage', '', 'succeeded'),
    row('Service worker', 'onBackgroundMessage', '', 'succeeded'),
    row('This page', 'deleteToken', 'Registrations delete, 200', 'succeeded'),
    row('This page', 'getToken', 'Installations create, 400', 'failed'),
  ].sort();
}

/** A row's outcome, as its detail reads it. */
async function outcomeOf(chip: Locator, id: string): Promise<string> {
  await chip.locator(`[data-traffic-rows] [data-request-row="${id}"]`).click();
  const detail = chip.locator('[data-traffic-detail]');
  await detail.waitFor({ state: 'visible', timeout: 10_000 });
  const outcome = await detail.evaluate((element) => {
    const facts = [...element.querySelectorAll('.request-fact')].map((fact) => [fact.querySelector('dt')?.textContent ?? '', fact.querySelector('dd')?.textContent ?? '']);
    return facts.find(([label]) => label === 'Outcome')?.[1] ?? '';
  });
  await chip.locator('[data-request-back]').click();
  return outcome;
}

interface CapturedEvent { kind?: string; service?: string; method?: string; detail?: { requests?: unknown } }

/** The host's session capture as written, and its Messaging operations. */
function sessionCapture(app: App): { text: string; events: CapturedEvent[] } {
  try {
    const text = app.readFile('.pyric/last-session.json');
    const capture = JSON.parse(text) as { events?: CapturedEvent[] };
    return { text, events: (capture.events ?? []).filter((event) => event.kind === 'operation' && event.service === 'messaging') };
  } catch {
    return { text: '', events: [] };
  }
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external'));
}

export default scenario(async (app) => {
  const { CAPTURE_M_PUSH_SUBSCRIPTION, CAPTURE_M_VAPID_KEY, captureMPush } = await import('../replay/messaging-capture.ts');
  const { deliverPush } = await import('../replay/messaging-browser.ts');
  writeProject(app);
  const replay = await app.step('start the replay server that serves capture M', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive(): the dev server is the live host', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`));
    return started;
  });

  const { browser, context } = await openBrowser(app, replay, host);
  try {
    const page = await app.step('the page loads firebase/messaging and registers its module service worker, which loads firebase/messaging/sw', async () => {
      const opened = await newPage(app, context);
      await openApp(app, opened, host.url);
      return opened;
    });

    const token = await app.step('isSupported answers from the browser, getToken mints a token, and a second getToken returns it from IndexedDB', async () => {
      assert.equal(await page.evaluate(() => alerts.isSupported()), true);
      const first = await page.evaluate(() => alerts.getToken());
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.match(String(first.value), /^replay-fcmToken-/);
      assert.deepEqual(await page.evaluate(() => alerts.getToken()), first);
      return String(first.value);
    });

    await app.step('register and onRegistered throw live mode\'s refusal before the SDK runs, and no request reaches the replay', async () => {
      const before = await replay.messagingReceived();
      for (const call of ['register', 'onRegistered'] as const) {
        const result = await page.evaluate((name) => alerts[name](), call);
        assert.equal(result.ok, false, `${call}: ${JSON.stringify(result)}`);
        assert.equal(result.code, 'PYRIC_LIVE_REFUSED', `${call}: ${JSON.stringify(result)}`);
        assert.match(result.message ?? '', new RegExp(`\\b${call}\\b`), `${call}'s refusal names the call`);
      }
      assert.deepEqual(await replay.messagingReceived(), before);
    });

    await app.step('a foreground push reaches onMessage on the visible page', async () => {
      const push = captureMPush('foreground');
      await deliverPush(page, push.pushData);
      // As JSON: the SDK leaves keys the push did not carry, such as collapseKey, undefined.
      const delivered = await eventually(() => page.evaluate(() => JSON.parse(JSON.stringify(alerts.foreground)) as unknown[]), (all) => all.length > 0, 'onMessage');
      assert.deepEqual(delivered, [push.delivered]);
    });

    await app.step('with the page navigated away, a push reaches onBackgroundMessage in the service worker', async () => {
      await page.goto('about:blank');
      const push = captureMPush('background');
      await deliverPush(page, push.pushData, host.url);
      const delivered = await eventually(() => lastBackgroundMessage(context), (kept) => kept !== null, 'onBackgroundMessage');
      assert.deepEqual(delivered, push.delivered);
      await openApp(app, page, host.url);
    });

    await app.step('back on the app, getToken returns the stored token, deleteToken deletes it, and the bad-key app\'s getToken fails with production\'s Installations error', async () => {
      // deleteToken takes no registration: the reloaded page's getToken hands the SDK its worker, from IndexedDB with no request.
      assert.deepEqual(await page.evaluate(() => alerts.getToken()), { ok: true, value: token });
      const entries = await installationEntries(page);
      const deleted = await page.evaluate(() => alerts.deleteToken());
      const why = deleted.ok ? '' : `; the replay received ${JSON.stringify(withoutIds(await replay.messagingReceived()))}; installations before ${JSON.stringify(entries)}`;
      assert.deepEqual(deleted, { ok: true, value: true }, `deleteToken: ${JSON.stringify(deleted)}${why}`);
      assert.deepEqual(await page.evaluate(() => alerts.getTokenWithBadKey()), { ok: false, code: 'installations/request-failed' });
      const path = (tail: string) => `/v1/projects/${PROJECT}/${tail}`;
      assert.deepEqual(await replay.messagingReceived(), [
        { api: 'installations', method: 'POST', path: path('installations') },
        { api: 'registrations', method: 'POST', path: path('registrations') },
        { api: 'registrations', method: 'DELETE', path: path(`registrations/${token}`) },
        { api: 'installations', method: 'POST', path: path('installations') },
      ]);
      assert.deepEqual(await replay.unmatched(), []);
    });

    const chip = await app.step('the chip shows each call and delivery as production\'s, from the realm that made it, with its requests and answer', async () => {
      const opened = await openChip(page);
      assert.equal(await opened.locator('.panel-header [data-chip-live]').textContent(), `Live: ${PROJECT}`);
      const expected = expectedRows();
      const texts = (rows: Row[]) => rows.map((row) => row.text).sort();
      const rows = await eventually(() => messagingRows(opened), (all) => JSON.stringify(texts(all)) === JSON.stringify(expected), 'the Messaging rows');
      const outcomes: string[] = [];
      for (const row of rows) outcomes.push(`${row.text.split(' | ')[0]}: ${await outcomeOf(opened, row.id)}`);
      assert.deepEqual(outcomes.sort(), [
        'production Service worker messaging.onBackgroundMessage: Succeeded in production',
        'production This page messaging.deleteToken: Succeeded in production',
        'production This page messaging.getToken: Failed in production (invalid_argument)',
        'production This page messaging.getToken: Succeeded in production',
        'production This page messaging.onMessage: Succeeded in production',
      ]);
      return opened;
    });

    const eventCount = await app.step('the host\'s event stream carries each call\'s requests, and no token, key, subscription or payload text', async () => {
      const capture = await eventually(async () => sessionCapture(app), (read) => read.events.length >= expectedRows().length, 'the Messaging events on the host');
      assert.equal(capture.events.length, expectedRows().length, `one event per observed call:\n${JSON.stringify(capture.events, null, 1)}`);
      const calls = capture.events.filter((event) => event.method === 'getToken' || event.method === 'deleteToken');
      assert.equal(calls.length, 3);
      for (const call of calls) assert.ok(Array.isArray(call.detail?.requests) && call.detail.requests.length > 0, `detail.requests on ${JSON.stringify(call)}`);
      const secrets = [token, CAPTURE_M_VAPID_KEY, CAPTURE_M_PUSH_SUBSCRIPTION.endpoint, CAPTURE_M_PUSH_SUBSCRIPTION.p256dh, CAPTURE_M_PUSH_SUBSCRIPTION.auth, 'replay-api-key', 'replay-malformed-key', 'pyric-capture-m', 'foreground delivery capture', 'background delivery capture'];
      assert.deepEqual(secrets.filter((secret) => capture.text.includes(secret)), [], 'the event stream carries no token, key, subscription or payload text');
      return capture.events.length;
    });

    await app.step('Messaging calls add nothing to the billed count', async () => {
      assert.equal(await chip.locator('[data-chip-billed]').first().textContent(), BILLED_NONE);
    });

    await app.step('under @pyric/live/register, the worker file loads both Messaging entries with no refusal, and sends no row', async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'sw.js'], { timeoutMs: 60_000 });
      assert.equal(run.code, 0, run.output);
      assert.match(run.output, /^LOADED firebase\/messaging and firebase\/messaging\/sw$/m);
      assert.doesNotMatch(run.output, /PYRIC_LIVE_REFUSED|net-guard BLOCK/);
      // A row the process sent would reach the host before the process exits.
      await sleep(1_000);
      assert.equal(sessionCapture(app).events.length, eventCount);
    });

    await app.step('the replay answered every request, and nothing reached any host but loopback', async () => {
      assert.deepEqual(await replay.unmatched(), []);
      assert.deepEqual(blockedLines(app), []);
      await page.close();
    });
  } finally {
    await browser.close();
  }
  await host.process.stop();
  await replay.stop();
});
