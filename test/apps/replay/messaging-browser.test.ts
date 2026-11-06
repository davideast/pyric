/**
 * Capture M replays in Chromium: the real `firebase/messaging` on a page and
 * the real `firebase/messaging/sw` in its module service worker, with no live
 * mode, against a replay process serving capture M (`startReplayProcess` with
 * `messagingCapture`). The scenario browser blocks every host but loopback,
 * and `messaging-browser.ts` relays the two Messaging hosts to the replay.
 *
 * getToken (with a VAPID key) mints the replay's token and deleteToken
 * deletes it; a push in capture M's shape reaches onMessage on the visible
 * page, and onBackgroundMessage once the page has navigated away; each denied
 * app's getToken rejects with the Installations error capture M recorded; and
 * the replay lists nothing in `unmatched`. The push subscription and the push
 * itself are the one part that is not production's path: Chromium has no push
 * service here, so the stand-in subscribes and CDP delivers (D2).
 *
 * The converter's own answers are checked in process first: a registration
 * under a FIS token the replay never minted, and a delete of a deleted token.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/messaging-browser.test.ts'`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { guardContext, launchScenarioBrowser } from '../driver.ts';
import type { JsonObject } from './format.ts';
import { deliverPush, installPushStandIn, reportOnline, routeMessagingTo } from './messaging-browser.ts';
import {
  CAPTURE_M_API_KEYS,
  CAPTURE_M_SENDER_ID,
  CAPTURE_M_VAPID_KEY,
  captureMPush,
  loadCaptureM,
  readCaptureM,
  type CaptureMApp,
} from './messaging-capture.ts';
import type { MessagingReceived } from './messaging.ts';
import { receivedBy, startReplayProcess, unmatchedBy, type ReplayProcess } from './process.ts';
import { startReplayServer } from './server.ts';

const PROJECT = 'demo-replay-messaging-m';
const TIMEOUT_MS = 60_000;
const NO_RECORDING = 'pyric_replay_no_recording';
const DENIED_APPS = ['malformed-key', 'referrer-blocked', 'other-api-only'] as const satisfies readonly CaptureMApp[];

/** The browser ESM build of a `firebase/*` entry, as a bundler for a page or a service worker picks it. */
function firebaseBrowserEntry(specifier: string): string {
  return join(dirname(createRequire(import.meta.url).resolve(specifier)), 'esm', 'index.esm.js');
}

function appConfig(app: CaptureMApp): JsonObject {
  return { apiKey: CAPTURE_M_API_KEYS[app], projectId: PROJECT, messagingSenderId: CAPTURE_M_SENDER_ID, appId: `1:${CAPTURE_M_SENDER_ID}:web:replay-${app}` };
}

const APP = JSON.stringify(firebaseBrowserEntry('firebase/app'));
const CONFIGS = JSON.stringify(Object.fromEntries(Object.keys(CAPTURE_M_API_KEYS).map((app) => [app, appConfig(app as CaptureMApp)])));

/** The page: two or more apps on one project, the SDK's own calls, and what onMessage received. */
const PAGE_ENTRY = `
import { initializeApp } from ${APP};
import { deleteToken, getMessaging, getToken, onMessage } from ${JSON.stringify(firebaseBrowserEntry('firebase/messaging'))};
const configs = ${CONFIGS};
const registration = await navigator.serviceWorker.register('/sw.js', { type: 'module', scope: '/' });
await navigator.serviceWorker.ready;
const messagingOf = (app) => getMessaging(initializeApp(configs[app], app));
const main = messagingOf('main');
const foreground = [];
onMessage(main, (payload) => foreground.push(payload));
const options = { vapidKey: ${JSON.stringify(CAPTURE_M_VAPID_KEY)}, serviceWorkerRegistration: registration };
const settle = (call) => call.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code, message: error.message, customData: error.customData }));
window.messagingTest = {
  getToken: (app) => settle(getToken(app === 'main' ? main : messagingOf(app), options)),
  deleteToken: () => settle(deleteToken(main)),
  foreground,
};
`;

/** The module service worker: the SDK's push handler, and a report of each onBackgroundMessage delivery. */
const WORKER_ENTRY = `
import { initializeApp } from ${APP};
import { getMessaging, onBackgroundMessage } from ${JSON.stringify(firebaseBrowserEntry('firebase/messaging/sw'))};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
const messaging = getMessaging(initializeApp(${JSON.stringify(appConfig('main'))}));
onBackgroundMessage(messaging, (payload) => fetch('/__test/background', { method: 'POST', body: JSON.stringify(payload) }));
`;

/**
 * Bundles `source` for the browser in a `bun build` process of its own.
 * `Bun.build` inside the test process fails to read `@firebase/app`'s ESM
 * build ("Unexpected reading file") when this file runs after the other
 * `test/apps` and replay tests in one `bun test` process, as CI runs them.
 */
function bundle(directory: string, name: string, source: string): string {
  const entry = join(directory, `${name}.entry.js`);
  const outfile = join(directory, `${name}.js`);
  writeFileSync(entry, source);
  const build = spawnSync(process.execPath, ['build', entry, '--target=browser', '--format=esm', `--outfile=${outfile}`], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`bundling ${name} failed (${build.status}):\n${build.stdout}${build.stderr}`);
  return readFileSync(outfile, 'utf8');
}

/** Serves the page and its worker on loopback, and records each background delivery the worker reports. */
function startAppServer(page: string, worker: string, background: JsonObject[]): Promise<Server> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/__test/background') {
      let body = '';
      request.on('data', (part: Buffer) => { body += part.toString(); });
      request.on('end', () => {
        background.push(JSON.parse(body) as JsonObject);
        response.writeHead(204).end();
      });
      return;
    }
    const scripts: Record<string, string> = { '/page.js': page, '/sw.js': worker };
    const script = scripts[path];
    if (script !== undefined) return void response.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
    if (path === '/') return void response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>messaging replay</title><script type="module" src="/page.js"></script>');
    response.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The capture M answer each denied app's getToken rejected with. */
function capturedDenial(app: CaptureMApp): JsonObject {
  const call = readCaptureM().calls.find((entry) => entry.app === app && entry.call === 'getToken');
  if (!call?.error) throw new Error(`capture M has no denied getToken for ${app}`);
  return call.error;
}

describe('the converter', () => {
  const REGISTRATIONS = `/fcmregistrations.googleapis.com/v1/projects/${PROJECT}/registrations`;
  const INSTALLATIONS = `/firebaseinstallations.googleapis.com/v1/projects/${PROJECT}/installations`;
  const headers = (fis: string) => ({ 'content-type': 'application/json', 'x-goog-api-key': CAPTURE_M_API_KEYS.main, 'x-goog-firebase-installations-auth': `FIS ${fis}` });
  const web = { applicationPubKey: CAPTURE_M_VAPID_KEY, auth: 'a', endpoint: 'e', origin: 'o', p256dh: 'p' };

  test('converts only the SDK\'s own exchanges, never the capture script\'s delete-deleted-token or cleanup requests', () => {
    const recording = loadCaptureM(PROJECT);
    const capture = readCaptureM();
    const sdkExchanges = capture.exchanges.filter((exchange) => exchange.op !== 'delete-deleted-token' && exchange.op !== 'cleanup');
    expect(recording.exchanges).toHaveLength(sdkExchanges.length);
    expect(JSON.stringify(recording)).not.toContain('<');
  });

  test('a registration under a FIS token the replay never minted fails closed (capture M holds no 401), and a delete of a deleted token answers 200 as captured', async () => {
    const server = await startReplayServer([loadCaptureM(PROJECT)]);
    try {
      const unminted = await fetch(`${server.origin}${REGISTRATIONS}`, { method: 'POST', headers: headers('never-minted'), body: JSON.stringify({ web }) });
      expect(unminted.status).toBe(400);
      expect(((await unminted.json()) as { error: { message: string } }).error.message).toStartWith(NO_RECORDING);
      expect(server.unmatched).toHaveLength(1);

      const installation = { appId: 'a', authVersion: 'FIS_v2', fid: 'cReplayFid0123456789ab', sdkVersion: 'w:0.6.24' };
      const created = await fetch(`${server.origin}${INSTALLATIONS}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': CAPTURE_M_API_KEYS.main, 'x-firebase-client': 'h' }, body: JSON.stringify(installation) });
      const fis = ((await created.json()) as { authToken: { token: string } }).authToken.token;
      const registered = await fetch(`${server.origin}${REGISTRATIONS}`, { method: 'POST', headers: headers(fis), body: JSON.stringify({ web }) });
      const token = ((await registered.json()) as { token: string }).token;
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        statuses.push((await fetch(`${server.origin}${REGISTRATIONS}/${token}`, { method: 'DELETE', headers: headers(fis) })).status);
      }
      const captured = readCaptureM().exchanges.find((exchange) => exchange.op === 'delete-deleted-token')!;
      expect(statuses).toEqual([200, captured.status]);
      expect(server.unmatched).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('firebase/messaging in Chromium against capture M', () => {
  const blocked: string[] = [];
  const background: JsonObject[] = [];
  let replay: ReplayProcess;
  let directory: string;
  let appServer: Server;
  let appOrigin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  const call = <T>(name: 'getToken' | 'deleteToken', app?: CaptureMApp) =>
    page.evaluate(([method, which]) => (window as unknown as { messagingTest: Record<string, (app?: string) => Promise<unknown>> }).messagingTest[method]!(which), [name, app] as const) as Promise<T>;
  const messagingReceived = async () => (await receivedBy(replay.origin)).filter((entry): entry is MessagingReceived => entry.rpc === 'messaging').map((entry) => entry.message);
  const openApp = async () => {
    await page.goto(`${appOrigin}/`);
    await page.waitForFunction(() => 'messagingTest' in window);
  };

  beforeAll(async () => {
    replay = await startReplayProcess([], undefined, { messagingCapture: PROJECT });
    directory = mkdtempSync(join(tmpdir(), 'pyric-messaging-browser-'));
    appServer = await startAppServer(bundle(directory, 'page', PAGE_ENTRY), bundle(directory, 'sw', WORKER_ENTRY), background);
    appOrigin = `http://localhost:${(appServer.address() as AddressInfo).port}`;
    // The headless shell reports `Notification.permission` as denied even once
    // granted, which getToken refuses; Chromium's own headless mode keeps the grant.
    browser = await launchScenarioBrowser({ channel: 'chromium' });
    context = await browser.newContext();
    await guardContext(context, blocked);
    await routeMessagingTo(context, replay.origin);
    await installPushStandIn(context);
    await reportOnline(context);
    await context.grantPermissions(['notifications'], { origin: appOrigin });
    page = await context.newPage();
    await openApp();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => appServer?.close(resolve));
    await replay?.stop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test('getToken mints the replay\'s registration token through an Installations create and a registrations create', async () => {
    const result = await call<{ ok: boolean; value: string }>('getToken', 'main');
    expect(result).toMatchObject({ ok: true });
    expect(result.value).toStartWith('replay-fcmToken-');
    expect(await messagingReceived()).toEqual([
      { api: 'installations', method: 'POST', path: `/v1/projects/${PROJECT}/installations` },
      { api: 'registrations', method: 'POST', path: `/v1/projects/${PROJECT}/registrations` },
    ]);
  }, TIMEOUT_MS);

  test('a push in capture M\'s shape reaches onMessage on the visible page', async () => {
    const push = captureMPush('foreground');
    await deliverPush(page, push.pushData);
    const delivered = await waitFor(() => page.evaluate(() => (window as unknown as { messagingTest: { foreground: JsonObject[] } }).messagingTest.foreground[0]), 'onMessage');
    expect(delivered).toEqual(push.delivered);
  }, TIMEOUT_MS);

  test('deleteToken deletes the token getToken minted', async () => {
    const minted = (await call<{ value: string }>('getToken', 'main')).value;
    const result = await call<{ ok: boolean; value: boolean }>('deleteToken');
    expect(result).toEqual({ ok: true, value: true });
    expect((await messagingReceived()).at(-1)).toEqual({ api: 'registrations', method: 'DELETE', path: `/v1/projects/${PROJECT}/registrations/${minted}` });
  }, TIMEOUT_MS);

  test('a push reaches onBackgroundMessage in the service worker once the page has navigated away', async () => {
    await page.goto('about:blank');
    const push = captureMPush('background');
    await deliverPush(page, push.pushData, appOrigin);
    const delivered = await waitFor(() => background[0], 'onBackgroundMessage');
    expect(delivered).toEqual(push.delivered);
    await openApp();
  }, TIMEOUT_MS);

  for (const app of DENIED_APPS) {
    test(`the ${app} app's getToken rejects with the Installations error capture M recorded`, async () => {
      const result = await call<JsonObject>('getToken', app);
      const denial = capturedDenial(app);
      expect(result).toEqual({ ok: false, code: denial.code!, message: denial.message!, customData: denial.customData! });
    }, TIMEOUT_MS);
  }

  test('the replay answered every request and nothing left loopback', async () => {
    expect(await unmatchedBy(replay.origin)).toEqual([]);
    expect(blocked).toEqual([]);
  });
});
