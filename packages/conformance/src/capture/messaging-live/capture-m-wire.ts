#!/usr/bin/env bun
/**
 * Capture M (issue #2114, Messaging M-1): every request the real
 * `firebase/messaging` SDK sends to Firebase Installations and FCM
 * registrations, and every push it is handed, for one fixed sequence against
 * production, for the live-mode Messaging replay.
 *
 * Sequence, in headed Chromium on a fresh profile, driving the messaging-web
 * harness app (`../messaging-web/app/main.ts` and `sw.ts`, unchanged):
 *   getToken                 the page's first getToken: Installations create, registrations create
 *   getToken-again           no request expected; recorded as such
 *   onMessage                a foreground message sent with firebase-admin
 *   onBackgroundMessage      a background message, the page navigated away
 *   getToken-reload          the page reloaded; no request expected
 *   deleteToken              registrations delete
 *   getToken-after-delete    a new token
 *   deleteToken-again        that token deleted
 *   delete-deleted-token     one registrations DELETE of the deleted token
 *   denied-malformed-key     an app whose API key is malformed
 *   denied-referrer          an API key restricted by HTTP referrer, so localhost is blocked
 *   denied-other-api-only    an API key restricted to one API that is neither Installations nor registrations
 *   installations-only-key-allowed an API key restricted to the Installations API: production
 *                            lets Installations create and registrations create through and mints a token
 *   cleanup                  the run's installations deleted and read back
 *
 * A page init script wraps `fetch` before the SDK loads and keeps every
 * request to the two hosts; the browser's network layer adds the response
 * headers the page cannot read, and Resource Timing adds what the page's
 * observer will see. A `push` listener added ahead of the SDK's in the
 * service worker keeps each push's `event.data.json()`. Only key sets, header
 * names, the headers the SDK and CORS read, response bodies and the test
 * values the run sent are kept. FIDs, refresh and auth tokens, registration
 * tokens, push endpoints and keys become numbered placeholders; the project,
 * app id and sender id become fixed placeholders; API keys, the VAPID key
 * and every credential are never written. The file is written only when no
 * token-shaped string remains.
 *
 * Safety: the three restricted API keys carry the run id in their display
 * names and are created together, so they share one propagation wait; the
 * run lists keys by the run id before (none may exist) and after (none may
 * remain), deletes all three, and reads each back as deleted. The recording
 * is written only when every case reaches its expected answer. Every
 * installation the run made is deleted and read back, and every token it
 * minted is deleted and read back through a dry-run send. Cleanup runs on any
 * failure and on SIGINT; the recording is written only when it held. Refuses
 * to run in CI.
 *
 * Inert unless PYRIC_MESSAGING_FIREBASE_CONFIG and PYRIC_MESSAGING_VAPID_KEY
 * are set. The credential is the oracle credential through Application
 * Default Credentials, on PYRIC_MESSAGING_PROJECT_ID (or PYRIC_ORACLE_PROJECT_ID).
 *
 *   bun run packages/conformance/src/capture/messaging-live/capture-m-wire.ts
 *   bun run packages/conformance/src/capture/messaging-live/capture-m-wire.ts --cleanup <run id>
 *
 * `--cleanup <run id>` runs only the cleanup of an earlier run: it deletes the
 * keys carrying that run id and, from that run's browser profile, its tokens
 * and installations, and reads each back. The run prints its real run id and
 * that command before it creates anything, and appends both to
 * `pyric-capture-m-run-ids.log` in the OS temp folder; the recording reads `<run>`.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { oracleAppOptions, oracleServiceAccountEmail } from '../../oracle-credential.ts';
import { resolvedAdminVersion, resolvedFirebaseVersion } from '../../package-version.ts';
import { messagingWebProjectProblems } from '../messaging-web/project-checks.ts';
import {
  allHeld,
  announceRunId,
  apiKeysRest,
  captureIsInert,
  cleanupCaptureRun,
  CONFIG_VARIABLE,
  exchangeApi,
  KEY_RESTRICTIONS,
  loadCaptureCredential,
  missingVariables,
  newRunId,
  pause,
  payloadShape,
  recordExchange,
  redactLine,
  Redactor,
  runWithCaptureCleanup,
  SecretCollector,
  VAPID_VARIABLE,
  withTimeout,
  writeMessagingRecording,
  type ClientReadBack,
  type CreatedKey,
  type KeyRestriction,
  type RawExchange,
} from './live-capture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_APP = join(HERE, '..', 'messaging-web', 'app');
const OUT = join(HERE, 'recordings', 'capture-m-wire.json');
const PORT = 4873;
const ORIGIN = `http://localhost:${PORT}`;

const OPERATIONS = [
  'getToken', 'getToken-again', 'onMessage', 'onBackgroundMessage', 'getToken-reload', 'deleteToken',
  'getToken-after-delete', 'deleteToken-again', 'delete-deleted-token',
  'denied-malformed-key', 'denied-referrer', 'denied-other-api-only', 'installations-only-key-allowed', 'cleanup',
] as const;
type Operation = (typeof OPERATIONS)[number];

/** API key restrictions can take minutes to reach every server; the denials wait this long after the keys exist. */
const KEY_PROPAGATION_MS = 5 * 60_000;
const DENIAL_ATTEMPTS = 6;
const DENIAL_RETRY_MS = 60_000;
const DELIVERY_TIMEOUT_MS = 60_000;
/** Deleting a registration reaches the send plane asynchronously; the dry-run read-back polls this long. */
const TOKEN_READBACK_MS = 5 * 60_000;
const MALFORMED_API_KEY = 'pyric-capture-m-malformed-api-key';
const SOURCE = 'pyric-capture-m';
type Channel = 'bundled' | 'chrome';

// ─── Env ──────────────────────────────────────────────────────────────────

const redactor = new Redactor();
const say = (line: string) => console.log(redactLine(redactor, line));
const complain = (line: string) => console.error(redactLine(redactor, line));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

if (process.env.CI) {
  console.error('[capture-m] refusing: capture M reaches production and never runs in CI.');
  process.exit(1);
}
const cleanupFlag = process.argv.indexOf('--cleanup');
const cleanupOnlyRun = cleanupFlag === -1 ? null : process.argv[cleanupFlag + 1] ?? '';
if (cleanupOnlyRun === '') {
  console.error('[capture-m] --cleanup needs the run id the capture printed.');
  process.exit(1);
}
if (captureIsInert(process.env)) {
  console.log(`[capture-m] inert: set ${CONFIG_VARIABLE} and ${VAPID_VARIABLE} (the messaging-web harness project) to capture.`);
  process.exit(0);
}
const missing = missingVariables(process.env);
if (missing.length > 0) {
  console.error(`[capture-m] missing: ${missing.join(', ')}`);
  process.exit(1);
}

const webConfig = JSON.parse(process.env[CONFIG_VARIABLE]!) as Record<string, string>;
const vapidKey = process.env[VAPID_VARIABLE]!;
redactor.add(webConfig.apiKey, '<api-key>');
redactor.add(webConfig.appId, '<app-id>');
redactor.add(vapidKey, '<vapid-key>');
redactor.add(webConfig.projectId, '<project>');
redactor.add(webConfig.messagingSenderId, '<sender-id>');
redactor.add(webConfig.authDomain, '<auth-domain>');
redactor.add(webConfig.storageBucket, '<storage-bucket>');
redactor.add(webConfig.measurementId, '<measurement-id>');

const sa = await loadCaptureCredential(process.env).catch((error: unknown) => {
  complain(`[capture-m] the credential did not load: ${messageOf(error)}`);
  process.exit(1);
});
const projectId = sa.project_id;
redactor.add(projectId, '<project>');
redactor.add(oracleServiceAccountEmail(sa), '<account>');
const problems = messagingWebProjectProblems(webConfig, vapidKey, projectId);
if (problems.length > 0) {
  for (const problem of problems) complain(`[capture-m] ${problem}`);
  process.exit(1);
}

const runId = cleanupOnlyRun ?? newRunId();
redactor.add(runId, '<run>');
const keys = apiKeysRest(sa, projectId);
const collector = new SecretCollector(redactor);
const admin: App = initializeApp(oracleAppOptions(sa), `capture-m-${runId}`);

// ─── The app: the harness's page and service worker, plus the capture's tools ─

/** Ahead of the SDK's own listener: the push as the service worker receives it, before the SDK reads it. */
const PUSH_RECORDER = `self.addEventListener('push', (event) => {
  let payload = null, error = null;
  try { payload = event.data ? event.data.json() : null; } catch (e) { error = String(e); }
  event.waitUntil(fetch('/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'push', data: { payload, error } }) }).catch(() => {}));
});`;

/** Before any page script: keep every fetch to the two hosts, and hand them over on `take()`. */
const FETCH_RECORDER = `(() => {
  const HOSTS = ['firebaseinstallations.googleapis.com', 'fcmregistrations.googleapis.com'];
  const realFetch = window.fetch.bind(window);
  const records = [];
  const watched = (url) => { try { return HOSTS.includes(new URL(url, location.href).hostname); } catch { return false; } };
  window.fetch = async function (input, init) {
    const request = new Request(input, init);
    if (!watched(request.url)) return realFetch(input, init);
    const entry = { method: request.method, url: request.url, requestHeaders: Object.fromEntries(request.headers), requestBody: init && typeof init.body === 'string' ? init.body : null, status: null, responseBody: null };
    records.push(entry);
    try {
      const response = await realFetch(input, init);
      entry.status = response.status;
      entry.responseBody = await response.clone().text();
      return response;
    } catch (e) {
      entry.fetchError = String(e);
      throw e;
    }
  };
  window.__captureM = {
    take() {
      const exchanges = records.splice(0);
      const timing = performance.getEntriesByType('resource').filter((e) => watched(e.name)).map((e) => ({
        url: e.name, initiatorType: e.initiatorType, responseStatus: typeof e.responseStatus === 'number' ? e.responseStatus : null,
        transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, nextHopProtocol: e.nextHopProtocol,
      }));
      performance.clearResourceTimings();
      return { exchanges, timing };
    },
  };
})();`;

/** The capture's own page helpers: getToken and deleteToken as another app, and the cleanup's requests. */
const TOOLS_SOURCE = `
import { getApps, initializeApp } from 'firebase/app';
import { deleteToken, getMessaging, getToken } from 'firebase/messaging';
import { getInstallations, getToken as getInstallationsToken } from 'firebase/installations';
declare const __CONFIG__: Record<string, string>;
declare const __VAPID__: string;
const INSTALLATIONS = 'https://firebaseinstallations.googleapis.com/v1/projects/' + __CONFIG__.projectId + '/installations';
const REGISTRATIONS = 'https://fcmregistrations.googleapis.com/v1/projects/' + __CONFIG__.projectId + '/registrations';
function appNamed(name: string, apiKey?: string) {
  return getApps().find((app) => app.name === name) ?? initializeApp({ ...__CONFIG__, apiKey: apiKey ?? __CONFIG__.apiKey }, name);
}
async function registration() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) throw new Error('no service worker registration at /');
  return reg;
}
function describe(e: unknown) {
  const error = e as { code?: string; message?: string; customData?: unknown };
  return { code: error?.code ?? null, message: String(error?.message ?? e), customData: error?.customData ?? null };
}
function readAll(dbName: string, store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let fresh = false;
    const open = indexedDB.open(dbName);
    open.onupgradeneeded = () => { fresh = true; open.transaction?.abort(); };
    open.onerror = () => (fresh ? resolve([]) : reject(open.error));
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); resolve([]); return; }
      const all = db.transaction(store).objectStore(store).getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  });
}
function clearStore(dbName: string, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName);
    open.onupgradeneeded = () => open.transaction?.abort();
    open.onerror = () => resolve();
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); resolve(); return; }
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-goog-api-key': __CONFIG__.apiKey };
(window as unknown as { __captureMTools: unknown }).__captureMTools = {
  async getTokenAs(name: string, apiKey: string) {
    try {
      const token = await getToken(getMessaging(appNamed(name, apiKey)), { vapidKey: __VAPID__, serviceWorkerRegistration: await registration() });
      return { ok: true, token };
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  },
  async deleteTokenAs(name: string, apiKey: string) {
    try {
      await deleteToken(getMessaging(appNamed(name, apiKey)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  },
  /** The SDK's registrations DELETE, with the default app's installation auth. */
  async deleteRegistration(token: string) {
    const auth = await getInstallationsToken(getInstallations(appNamed('[DEFAULT]')));
    const response = await fetch(REGISTRATIONS + '/' + token, { method: 'DELETE', headers: { ...jsonHeaders, 'x-goog-firebase-installations-auth': 'FIS ' + auth } });
    return response.status;
  },
  async storedTokens() {
    const rows = (await readAll('firebase-messaging-database', 'firebase-messaging-store')) as Array<{ token?: string }>;
    return rows.map((row) => row.token).filter((token): token is string => typeof token === 'string');
  },
  async clearStoredTokens() {
    await clearStore('firebase-messaging-database', 'firebase-messaging-store');
  },
  async storedInstallations() {
    const rows = (await readAll('firebase-installations-database', 'firebase-installations-store')) as Array<{ fid?: string; refreshToken?: string }>;
    return rows.filter((row) => row.fid && row.refreshToken).map((row) => ({ fid: row.fid, refreshToken: row.refreshToken }));
  },
  /** The SDK's Installations DELETE. */
  async deleteInstallation(fid: string, refreshToken: string) {
    const response = await fetch(INSTALLATIONS + '/' + fid, { method: 'DELETE', headers: { ...jsonHeaders, Authorization: 'FIS_v2 ' + refreshToken } });
    return response.status;
  },
  /** The SDK's generateAuthToken: a deleted installation no longer gets one. */
  async generateAuthToken(fid: string, refreshToken: string) {
    const response = await fetch(INSTALLATIONS + '/' + fid + '/authTokens:generate', {
      method: 'POST',
      headers: { ...jsonHeaders, Authorization: 'FIS_v2 ' + refreshToken },
      body: JSON.stringify({ installation: { sdkVersion: 'w:0.6.24', appId: __CONFIG__.appId } }),
    });
    return response.status;
  },
  async unsubscribePush() {
    const subscription = await (await registration()).pushManager.getSubscription();
    return subscription ? subscription.unsubscribe() : true;
  },
};
`;

const toolsEntry: Bun.BunPlugin = {
  name: 'capture-m-tools',
  setup(build) {
    build.onResolve({ filter: /^capture-m-tools$/ }, () => ({ path: 'capture-m-tools', namespace: 'capture-m' }));
    build.onLoad({ filter: /.*/, namespace: 'capture-m' }, () => ({ contents: TOOLS_SOURCE, loader: 'ts', resolveDir: HERE }));
  },
};

async function bundle(entry: string, options: { banner?: string; plugin?: boolean }): Promise<string> {
  const built = await Bun.build({
    entrypoints: [entry],
    define: {
      __CONFIG__: JSON.stringify(webConfig),
      __VAPID__: JSON.stringify(vapidKey),
      __BUILD__: JSON.stringify(runId),
    },
    target: 'browser',
    format: 'esm',
    ...(options.banner ? { banner: options.banner } : {}),
    ...(options.plugin ? { plugins: [toolsEntry] } : {}),
  });
  if (!built.success) throw new Error(`bundle ${entry} failed: ${built.logs.map(String).join('\n')}`);
  return built.outputs[0]!.text();
}

const bundles = new Map<string, string>([
  ['/main.js', await bundle(join(HARNESS_APP, 'main.ts'), {})],
  ['/firebase-messaging-sw.js', await bundle(join(HARNESS_APP, 'sw.ts'), { banner: PUSH_RECORDER })],
  ['/tools.js', await bundle('capture-m-tools', { plugin: true })],
]);
const PAGE_BODY = '<p id="status"></p><p><button id="send-fg">foreground</button><button id="send-bg">background</button></p><p id="token"></p><ul id="log"></ul>';
const MAIN_HTML = `<!doctype html><meta charset="utf-8"><title>capture m</title><body>${PAGE_BODY}<script type="module" src="/tools.js"></script><script type="module" src="/main.js"></script>`;
const TOOLS_HTML = `<!doctype html><meta charset="utf-8"><title>capture m tools</title><body>${PAGE_BODY}<script type="module" src="/tools.js"></script>`;

interface Capture { kind: string; data: Record<string, unknown>; at: number }
const captures: Capture[] = [];

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/') return new Response(MAIN_HTML, { headers: { 'content-type': 'text/html' } });
    if (pathname === '/tools') return new Response(TOOLS_HTML, { headers: { 'content-type': 'text/html' } });
    const code = bundles.get(pathname);
    if (code !== undefined) return new Response(code, { headers: { 'content-type': 'text/javascript', 'Service-Worker-Allowed': '/' } });
    if (pathname === '/capture' && req.method === 'POST') {
      const body = (await req.json()) as { kind: string; data: Record<string, unknown> };
      captures.push({ ...body, at: Date.now() });
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
});

// ─── The browser ──────────────────────────────────────────────────────────

interface NetworkHeaders { method: string; url: string; headers: Record<string, string>; used: boolean }

interface BrowserRun {
  channel: Channel;
  context: BrowserContext;
  page: Page;
  network: NetworkHeaders[];
}

const rawExchanges: RawExchange[] = [];
const timings: Array<Record<string, unknown> & { op: string }> = [];
const mintedTokens = new Set<string>();
/** FIDs and refresh tokens from every Installations create the run saw, for the cleanup. */
const createdInstallations = new Map<string, string>();
let current: BrowserRun | null = null;

async function loadChromium(): Promise<typeof import('@playwright/test').chromium> {
  const mod = await import('@playwright/test');
  return mod.chromium;
}

function profileDir(channel: Channel): string {
  return join(process.env.TMPDIR ?? tmpdir(), `pyric-capture-m-${runId}-${channel}`);
}

async function launch(channel: Channel): Promise<BrowserRun> {
  const chromium = await loadChromium();
  // A persistent profile: Chrome disables web push in incognito, which every
  // other Playwright context is. Headed: push arrives over the browser's GCM
  // channel. Occlusion flags stripped so a hidden page reports hidden.
  const context = await chromium.launchPersistentContext(profileDir(channel), {
    headless: false,
    ...(channel === 'chrome' ? { channel: 'chrome' } : {}),
    ignoreDefaultArgs: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  });
  await context.grantPermissions(['notifications'], { origin: ORIGIN });
  await context.addInitScript(FETCH_RECORDER);
  const page = context.pages()[0] ?? (await context.newPage());
  // Playwright's grantPermissions has no 'push'; grant the descriptor over CDP before the app loads.
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Browser.setPermission', { permission: { name: 'push', userVisibleOnly: true }, setting: 'granted', origin: ORIGIN } as never);
  } catch (e) {
    complain(`[capture-m] the CDP push grant failed in ${channel} Chromium (${messageOf(e).slice(0, 120)}); continuing`);
  }
  const network: NetworkHeaders[] = [];
  page.on('response', (response) => {
    const request = response.request();
    if (!exchangeApi(request.url())) return;
    void response.allHeaders().then((headers) => network.push({ method: request.method(), url: request.url(), headers, used: false }));
  });
  page.on('pageerror', (error) => complain(`[capture-m] page error: ${error.message}`));
  return { channel, context, page, network };
}

interface Taken {
  exchanges: Array<Omit<RawExchange, 'op' | 'responseHeaders'>>;
  timing: Array<Record<string, unknown> & { url: string }>;
}

/** Hand over every exchange the page made since the last take, labeled `op`. */
async function take(run: BrowserRun, op: string): Promise<RawExchange[]> {
  await pause(500);
  const taken = (await run.page.evaluate('window.__captureM.take()')) as Taken;
  const out = taken.exchanges.map((e) => ({ ...e, op, responseHeaders: null }));
  for (const exchange of out) {
    collector.exchange(exchange);
    noteInstallation(exchange);
  }
  rawExchanges.push(...out);
  for (const entry of taken.timing) timings.push({ ...entry, op });
  return out;
}

function noteInstallation(exchange: RawExchange): void {
  if (exchangeApi(exchange.url) !== 'installations' || exchange.method !== 'POST' || exchange.status !== 200) return;
  if (exchange.url.endsWith('/authTokens:generate')) return;
  try {
    const body = JSON.parse(exchange.responseBody ?? '') as { fid?: string; refreshToken?: string };
    if (body.fid && body.refreshToken) createdInstallations.set(body.fid, body.refreshToken);
  } catch {
    // Not JSON: nothing was created.
  }
}

function noteToken(token: string): void {
  mintedTokens.add(token);
  collector.add(token, 'fcm-token');
}

async function waitFrom(kinds: string[], from: number, timeoutMs: number, match: (c: Capture) => boolean = () => true): Promise<Capture> {
  const start = Date.now();
  for (;;) {
    const hit = captures.slice(from).find((c) => kinds.includes(c.kind) && match(c));
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${kinds.join(' or ')}; saw ${captures.slice(from).map((c) => c.kind).join(', ') || 'nothing'}`);
    await pause(250);
  }
}

const tagOf = (c: Capture) => ((c.data.payload as { data?: { tag?: string } } | null)?.data?.tag);

async function tools<T>(run: BrowserRun, method: string, ...args: unknown[]): Promise<T> {
  return run.page.evaluate(
    ([name, values]) => (window as unknown as { __captureMTools: Record<string, (...a: unknown[]) => Promise<unknown>> }).__captureMTools[name as string]!(...(values as unknown[])),
    [method, args] as const,
  ) as Promise<T>;
}

async function openToolsPage(run: BrowserRun): Promise<void> {
  if (run.page.url() === `${ORIGIN}/tools`) return;
  await run.page.goto(`${ORIGIN}/tools`);
  await run.page.waitForFunction('typeof window.__captureMTools === "object"', undefined, { timeout: 15_000 });
}

// ─── Sends ────────────────────────────────────────────────────────────────

const SENT_VALUES = new Set<string>([SOURCE, '1']);

function message(token: string, tag: string) {
  const title = `oracle ${tag}`;
  const body = `${tag} delivery capture`;
  for (const value of [tag, title, body]) SENT_VALUES.add(value);
  return { token, notification: { title, body }, data: { source: SOURCE, tag, demo: '1' } };
}

/** Polls a dry-run send until FCM answers the token is not registered. */
async function tokenReadsBackDeleted(token: string): Promise<boolean> {
  const deadline = Date.now() + TOKEN_READBACK_MS;
  while (Date.now() < deadline) {
    try {
      await getMessaging(admin).send({ token, data: { source: SOURCE, tag: 'read-back' } }, true);
    } catch (error) {
      if ((error as { code?: string }).code === 'messaging/registration-token-not-registered') return true;
      complain(`[capture-m] token read-back: ${(error as { code?: string }).code ?? messageOf(error)}`);
    }
    await pause(10_000);
  }
  return false;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

/**
 * Delete every registration still stored and every installation the run made
 * (from the profile's IndexedDB and from the exchanges seen), unsubscribe the
 * push subscription, and read each back: an installation no longer gets an
 * auth token, and a dry-run send to each token answers not registered.
 */
async function cleanClient(run: BrowserRun): Promise<ClientReadBack> {
  await openToolsPage(run);
  let tokensDeleted = true;
  const stored = await tools<string[]>(run, 'storedTokens');
  for (const token of stored) {
    noteToken(token);
    const status = await tools<number>(run, 'deleteRegistration', token);
    if (status !== 200 && status !== 404) tokensDeleted = false;
  }
  await tools(run, 'clearStoredTokens');
  await tools(run, 'unsubscribePush');
  const fromProfile = await tools<Array<{ fid: string; refreshToken: string }>>(run, 'storedInstallations');
  for (const { fid, refreshToken } of fromProfile) createdInstallations.set(fid, refreshToken);
  let installationsDeleted = true;
  for (const [fid, refreshToken] of createdInstallations) {
    const deleted = await tools<number>(run, 'deleteInstallation', fid, refreshToken);
    const readBack = await tools<number>(run, 'generateAuthToken', fid, refreshToken);
    say(`[capture-m] installation delete ${deleted}, auth token read back ${readBack}`);
    if (![200, 404].includes(deleted) || ![401, 404].includes(readBack)) installationsDeleted = false;
  }
  await take(run, 'cleanup');
  const readBacks = await Promise.all([...mintedTokens].map((token) => tokenReadsBackDeleted(token)));
  say(`[capture-m] ${readBacks.filter(Boolean).length} of ${mintedTokens.size} tokens read back as not registered`);
  tokensDeleted &&= readBacks.every(Boolean);
  return { tokensDeleted, installationsDeleted };
}

async function cleanCurrentClient(): Promise<ClientReadBack> {
  if (!current) return { tokensDeleted: mintedTokens.size === 0, installationsDeleted: createdInstallations.size === 0 };
  return cleanClient(current);
}

async function closeBrowser(): Promise<void> {
  const run = current;
  current = null;
  if (run) await run.context.close().catch((e: unknown) => complain(`[capture-m] browser close: ${messageOf(e)}`));
}

// ─── Cleanup only ─────────────────────────────────────────────────────────

if (cleanupOnlyRun !== null) {
  console.log(`[capture-m] cleanup only, run ${runId}`);
  const result = await cleanupCaptureRun(keys, runId, [], {
    client: async () => {
      const readBacks: ClientReadBack[] = [];
      for (const channel of ['bundled', 'chrome'] as const) {
        if (!existsSync(profileDir(channel))) continue;
        current = await launch(channel);
        readBacks.push(await cleanClient(current));
        await closeBrowser();
      }
      return {
        tokensDeleted: readBacks.every((r) => r.tokensDeleted),
        installationsDeleted: readBacks.every((r) => r.installationsDeleted),
      };
    },
    log: complain,
  });
  say(`[capture-m] cleanup: ${JSON.stringify(result.invariants)}, keys left under the run id: ${result.after}`);
  server.stop();
  await deleteApp(admin);
  process.exit(allHeld(result.invariants) && result.failures.length === 0 ? 0 : 3);
}

// ─── The sequence ─────────────────────────────────────────────────────────

interface CallRecord {
  op: Operation;
  app: string;
  call: 'getToken' | 'deleteToken';
  outcome: 'ok' | 'error';
  sameAsPrevious?: boolean;
  error?: unknown;
}
interface PushRecord {
  op: Operation;
  route: 'foreground' | 'background';
  pushData: unknown;
  delivered: { to: string; payload: unknown };
}
interface DenialRecord { op: Operation; api: string; action: string; status: number; body: unknown }
interface AllowedRecord { op: Operation; installationsCreate: number; registrationsCreate: number; tokenMinted: boolean }

const calls: CallRecord[] = [];
const pushes: PushRecord[] = [];
const denials: Record<string, DenialRecord> = {};
const allowed: Record<string, AllowedRecord> = {};
let browserInfo: { channel: Channel; headless: false; chromiumMajor: string } | null = null;

/** Open the page on a fresh profile and wait for its first getToken; if this browser cannot reach the push service, try the next. */
async function firstToken(): Promise<string> {
  const reasons: string[] = [];
  for (const channel of ['bundled', 'chrome'] as const) {
    current = await launch(channel);
    const mark = captures.length;
    await current.page.goto(ORIGIN);
    const outcome = await waitFrom(['token', 'error', 'permission'], mark, 60_000, (c) => c.kind !== 'permission' || c.data.state !== 'granted')
      .catch((e: unknown) => ({ kind: 'error', data: { message: messageOf(e) }, at: Date.now() }) as Capture);
    if (outcome.kind === 'token') {
      const userAgent = (await current.page.evaluate('navigator.userAgent')) as string;
      browserInfo = { channel, headless: false, chromiumMajor: /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? 'unknown' };
      say(`[capture-m] ${channel} Chromium reached the push service`);
      return outcome.data.token as string;
    }
    reasons.push(`${channel}: ${JSON.stringify(outcome.data).slice(0, 300)}`);
    complain(`[capture-m] the first getToken failed in ${channel} Chromium: ${JSON.stringify(outcome.data).slice(0, 300)}`);
    await take(current, `getToken-failed-${channel}`);
    const clean = await cleanClient(current);
    await closeBrowser();
    if (!clean.installationsDeleted || !clean.tokensDeleted) throw new Error(`the failed ${channel} profile did not clean up: ${JSON.stringify(clean)}`);
  }
  throw new Error(`no browser minted a token: ${reasons.join('; ')}`);
}

function exchangesOf(list: RawExchange[], api: string, action: string): RawExchange[] {
  return list.filter((e) => {
    const recorded = recordExchange(e);
    return recorded.api === api && recorded.action === action;
  });
}

type Verdict = 'held' | 'retry';

/** Run one denial; retry while the key's restriction has not reached every server yet. */
async function denial(
  run: BrowserRun,
  op: Operation,
  kind: string,
  apiKey: string,
  verdict: (taken: RawExchange[]) => Verdict,
  denied: { api: string; action: string },
  attempts: number,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const app = `${kind}-${attempt}`;
    const result = await tools<{ ok: boolean; token?: string; error?: unknown }>(run, 'getTokenAs', app, apiKey);
    const taken = await take(run, `${op}-attempt-${attempt}`);
    if (result.ok && result.token) {
      noteToken(result.token);
      complain(`[capture-m] ${kind}: getToken was allowed (attempt ${attempt}); deleting that token`);
      await tools(run, 'deleteTokenAs', app, apiKey);
      await take(run, `${op}-attempt-${attempt}`);
    }
    const held = !result.ok && verdict(taken) === 'held';
    if (held) {
      for (const exchange of taken) exchange.op = op;
      const exchange = exchangesOf(taken, denied.api, denied.action).at(-1)!;
      denials[kind] = { op, api: denied.api, action: denied.action, status: exchange.status!, body: JSON.parse(exchange.responseBody ?? 'null') as unknown };
      calls.push({ op, app: kind, call: 'getToken', outcome: 'error', error: result.error });
      say(`[capture-m] ${kind}: denied with ${exchange.status} (attempt ${attempt})`);
      return;
    }
    const statuses = taken.map((e) => `${recordExchange(e).api} ${recordExchange(e).action} ${e.status}`).join(', ');
    complain(`[capture-m] ${kind}: not the expected denial yet (attempt ${attempt}): ${statuses || 'no request'}`);
    if (attempt < attempts) await pause(DENIAL_RETRY_MS);
  }
  throw new Error(`${kind}: the expected denial never held`);
}

function statusOf(taken: RawExchange[], api: string, action: string): number | null {
  return exchangesOf(taken, api, action).at(-1)?.status ?? null;
}

async function sequence(created: Record<KeyRestriction, CreatedKey>): Promise<void> {
  redactor.add(created['referrer-blocked'].keyString, '<restricted-key-1>');
  redactor.add(created['installations-only'].keyString, '<restricted-key-2>');
  redactor.add(created['other-api-only'].keyString, '<restricted-key-3>');
  const keysCreatedAt = Date.now();
  say(`[capture-m] run ${runId}: three restricted keys created`);

  const token1 = await firstToken();
  const run = current!;
  noteToken(token1);
  await waitFrom(['listening'], 0, 15_000);
  await take(run, 'getToken');
  calls.push({ op: 'getToken', app: 'main', call: 'getToken', outcome: 'ok' });

  const again = (await run.page.evaluate('window.__getTokenAgain()')) as string;
  await take(run, 'getToken-again');
  calls.push({ op: 'getToken-again', app: 'main', call: 'getToken', outcome: 'ok', sameAsPrevious: again === token1 });

  const foregroundMark = captures.length;
  await run.page.bringToFront();
  await getMessaging(admin).send(message(token1, 'foreground'));
  const onMessage = await waitFrom(['onMessage'], foregroundMark, DELIVERY_TIMEOUT_MS, (c) => tagOf(c) === 'foreground');
  const foregroundPush = await waitFrom(['push'], foregroundMark, DELIVERY_TIMEOUT_MS, (c) => tagOf(c) === 'foreground');
  pushes.push({
    op: 'onMessage',
    route: 'foreground',
    pushData: payloadShape(foregroundPush.data.payload, SENT_VALUES),
    delivered: { to: 'onMessage', payload: payloadShape(onMessage.data.payload, SENT_VALUES) },
  });
  await take(run, 'onMessage');
  say('[capture-m] foreground message delivered to onMessage');

  await run.page.goto('about:blank');
  const backgroundMark = captures.length;
  await getMessaging(admin).send(message(token1, 'background'));
  const onBackground = await waitFrom(['onBackgroundMessage'], backgroundMark, DELIVERY_TIMEOUT_MS, (c) => tagOf(c) === 'background');
  const backgroundPush = await waitFrom(['push'], backgroundMark, DELIVERY_TIMEOUT_MS, (c) => tagOf(c) === 'background');
  pushes.push({
    op: 'onBackgroundMessage',
    route: 'background',
    pushData: payloadShape(backgroundPush.data.payload, SENT_VALUES),
    delivered: { to: 'onBackgroundMessage', payload: payloadShape(onBackground.data.payload, SENT_VALUES) },
  });
  say('[capture-m] background message delivered to onBackgroundMessage');

  const reloadMark = captures.length;
  await run.page.goto(ORIGIN);
  const reloaded = await waitFrom(['token', 'error'], reloadMark, 30_000);
  if (reloaded.kind !== 'token') throw new Error(`getToken after reload failed: ${JSON.stringify(reloaded.data).slice(0, 300)}`);
  await waitFrom(['listening'], reloadMark, 15_000);
  await take(run, 'getToken-reload');
  calls.push({ op: 'getToken-reload', app: 'main', call: 'getToken', outcome: 'ok', sameAsPrevious: reloaded.data.token === token1 });

  await run.page.evaluate('window.__deleteToken()');
  await take(run, 'deleteToken');
  calls.push({ op: 'deleteToken', app: 'main', call: 'deleteToken', outcome: 'ok' });

  const token2 = (await run.page.evaluate('window.__getTokenAgain()')) as string;
  noteToken(token2);
  await take(run, 'getToken-after-delete');
  calls.push({ op: 'getToken-after-delete', app: 'main', call: 'getToken', outcome: 'ok', sameAsPrevious: token2 === token1 });

  await run.page.evaluate('window.__deleteToken()');
  await take(run, 'deleteToken-again');
  calls.push({ op: 'deleteToken-again', app: 'main', call: 'deleteToken', outcome: 'ok' });

  const again404 = await tools<number>(run, 'deleteRegistration', token2);
  await take(run, 'delete-deleted-token');
  say(`[capture-m] a DELETE of the deleted token answered ${again404}`);

  await openToolsPage(run);
  await take(run, 'tools-page');
  await denial(run, 'denied-malformed-key', 'malformed-key', MALFORMED_API_KEY,
    (taken) => ((statusOf(taken, 'installations', 'create') ?? 0) >= 400 ? 'held' : 'retry'),
    { api: 'installations', action: 'create' }, 1);

  const wait = keysCreatedAt + KEY_PROPAGATION_MS - Date.now();
  if (wait > 0) {
    say(`[capture-m] waiting ${Math.round(wait / 1000)} s for the key restrictions to propagate`);
    await pause(wait);
  }
  await denial(run, 'denied-referrer', 'referrer-blocked', created['referrer-blocked'].keyString,
    (taken) => (statusOf(taken, 'installations', 'create') === 403 ? 'held' : 'retry'),
    { api: 'installations', action: 'create' }, DENIAL_ATTEMPTS);
  await denial(run, 'denied-other-api-only', 'other-api-only', created['other-api-only'].keyString,
    (taken) => (statusOf(taken, 'installations', 'create') === 403 ? 'held' : 'retry'),
    { api: 'installations', action: 'create' }, DENIAL_ATTEMPTS);
  // After the two denials above held, the restrictions have propagated, so an allowed answer here is production's.
  await installationsOnlyKeyAllowed(run, created['installations-only'].keyString);
}

/**
 * A key restricted to the Installations API alone: production answers
 * Installations create 200 and registrations create 200 and mints a token.
 * Anything else fails the run, so nothing is written.
 */
async function installationsOnlyKeyAllowed(run: BrowserRun, apiKey: string): Promise<void> {
  const op: Operation = 'installations-only-key-allowed';
  const app = 'installations-only';
  const result = await tools<{ ok: boolean; token?: string; error?: unknown }>(run, 'getTokenAs', app, apiKey);
  if (result.ok && result.token) noteToken(result.token);
  const taken = await take(run, op);
  const installationsCreate = statusOf(taken, 'installations', 'create');
  const registrationsCreate = statusOf(taken, 'registrations', 'create');
  const tokenMinted = result.ok && typeof result.token === 'string';
  const asExpected = installationsCreate === 200 && registrationsCreate === 200 && tokenMinted;
  if (!asExpected) {
    throw new Error(`installations-only key: expected Installations create 200, registrations create 200 and a token; got ${installationsCreate}, ${registrationsCreate}, token ${tokenMinted}`);
  }
  allowed[app] = { op, installationsCreate, registrationsCreate, tokenMinted };
  calls.push({ op, app, call: 'getToken', outcome: 'ok' });
  await tools(run, 'deleteTokenAs', app, apiKey);
  await take(run, op);
  calls.push({ op, app, call: 'deleteToken', outcome: 'ok' });
  say('[capture-m] installations-only key: allowed, a token minted and deleted');
}

announceRunId(runId);
const outcome = await runWithCaptureCleanup(keys, runId, sequence, { client: cleanCurrentClient, handleSignals: true, log: complain }).catch(async (error: unknown) => {
  // The run refused before it created anything (the key list failed, or keys already carry the run id).
  complain(`[capture-m] refused before creating anything: ${messageOf(error)}`);
  server.stop();
  await deleteApp(admin);
  process.exit(1);
});
const network = current ? (current as BrowserRun).network : [];
await closeBrowser();
server.stop();
await deleteApp(admin);

say(`[capture-m] invariants ${JSON.stringify(outcome.invariants)}, keys before ${outcome.keys.before}, created ${outcome.keys.created}, after ${outcome.keys.after}`);
if (!allHeld(outcome.invariants)) {
  complain(`[capture-m] an invariant failed; nothing written. Run the cleanup with --cleanup ${runId}.`);
  process.exit(3);
}
if (outcome.error) {
  complain(`[capture-m] capture failed; nothing written: ${outcome.error.message}`);
  process.exit(1);
}

/** The browser's full response headers, paired to the page's exchanges by method and URL in order. */
for (const exchange of rawExchanges) {
  const match = network.find((n) => !n.used && n.method === exchange.method && n.url === exchange.url);
  if (match) {
    match.used = true;
    exchange.responseHeaders = match.headers;
  }
}
const kept = new Set<string>(OPERATIONS);
const exchanges = rawExchanges.filter((e) => kept.has(e.op)).map(recordExchange);
const resourceTiming = timings.filter((t) => kept.has(t.op)).map(({ url, ...rest }) => {
  const parsed = new URL(url as string);
  return { ...rest, api: exchangeApi(parsed.href), path: parsed.pathname };
});

writeMessagingRecording(OUT, {
  name: 'messaging-live-capture-m-wire',
  description: 'Every request the firebase/messaging SDK sent to Firebase Installations and FCM registrations from the page, with production\'s answers, for getToken on a fresh profile, getToken again and after a reload (no request), deleteToken, a second token minted and deleted, a DELETE of a deleted token, three denied getTokens (a malformed API key, a key restricted by HTTP referrer, a key restricted to one API that is neither Installations nor registrations), and a getToken with a key restricted to the Installations API alone, which production allowed; and each push the service worker received, before the SDK read it, for one foreground and one background message. Request headers keep their names and Content-Type, request bodies their key sets, responses their status, the headers the SDK and CORS read, every header name, and the body. Resource Timing is what the page saw for each request. Push payloads keep key sets and the values the run sent.',
  observedAt: new Date().toISOString(),
  sdkVersion: resolvedFirebaseVersion(),
  adminSdkVersion: resolvedAdminVersion(),
  browser: browserInfo,
  operations: OPERATIONS,
  placeholders: ['<project>', '<app-id>', '<sender-id>', '<api-key>', '<vapid-key>', '<run>', '<fid-N>', '<refresh-token-N>', '<fis-auth-token-N>', '<fcm-token-N>', '<push-endpoint-N>', '<push-auth-N>', '<push-p256dh-N>', '<restricted-key-N>'],
  exchanges,
  resourceTiming,
  calls,
  pushes,
  denials,
  allowed,
  apiKeys: { ...outcome.keys, restrictions: KEY_RESTRICTIONS },
  invariants: outcome.invariants,
}, redactor);
say(`[capture-m] wrote ${OUT}`);
process.exit(0);
