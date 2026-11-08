// An app that uses Firebase AI Logic the way pyric's AI Logic guide shows,
// with the modular firebase SDK through the Vite plugin, on the plugin's
// default plane (the SharedWorker) in Chromium:
//
// - With App Check initialized before getAI (the debug provider under
//   import.meta.env.DEV), generateContent answers and generateContentStream
//   delivers its reply in chunks.
// - Without App Check, the same calls get the 401 an enforced project returns
//   (observations/app-check/app-check-ai-gate-wire.json, #1300), and the
//   dev server terminal prints pyric's hint (#1535).
// - Every request the page makes goes to the local machine. Playwright's
//   routes don't see a SharedWorker's requests, so the scenario watches the
//   browser over its own CDP connection, auto-attached to every page and
//   worker target, and records each request and WebSocket. A control
//   SharedWorker asks for an outside host at the end, which proves the watch
//   sees worker requests; the resolver rules stop that request on the machine.
//   The scenario waits until the watch records a worker's requests before it
//   drives that worker (#2154).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { guardContext, launchScenarioBrowser, scenario, type App } from '../driver.ts';

declare function runWithAppCheck(): Promise<Record<string, unknown>>;
declare function runWithoutAppCheck(): Promise<Record<string, unknown>>;
declare function openEgressControl(): void;
declare function runEgressControl(url: string): Promise<string>;

const OBSERVATIONS = join(import.meta.dirname, '..', '..', '..', 'packages', 'conformance', 'observations', 'app-check');
const MODEL = 'gemini-flash-lite-latest';
const ANSWER = 'The report is ready for review.';
const CHUNKS = ['Requests stay ', 'on this machine, ', 'chunk by chunk.'];
const HINT = /Call initializeAppCheck\(app, \{ provider \}\) before getAI\(app\)\./;
const CONTROL_URL = 'https://egress-control.invalid/ai-app-check-stays-local';
const PYRIC_WORKER_PATH = '/__pyric/sdk/worker.js';
const CONTROL_WORKER_PATH = '/control-worker.js';
/** How long a worker may take to start before the watch gives up on it. */
const WORKER_START_MS = 10_000;
/** How long the watch may take to report a request the page already heard back from. */
const REQUEST_REPORT_MS = 5_000;

interface GateCapture { behavior: { noHeader: { httpStatus: number; messageText: string } } }

function gateCapture(): GateCapture['behavior']['noHeader'] {
  const file = join(OBSERVATIONS, 'app-check-ai-gate-wire.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as GateCapture).behavior.noHeader;
}

/** The AIError the Firebase SDK throws for AI Logic's 401. A stream's URL carries `?alt=sse`, as the SDK builds it (#1640). */
function refusal(op: string) {
  const gate = gateCapture();
  const isStream = op === 'streamGenerateContent';
  const query = isStream ? '?alt=sse' : '';
  return {
    ok: false,
    name: 'FirebaseError',
    code: 'fetch-error',
    status: gate.httpStatus,
    statusText: 'Unauthorized',
    message: `AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/models/${MODEL}:${op}${query}: [${gate.httpStatus} Unauthorized] ${gate.messageText} (AI/fetch-error)`,
  };
}

/** One request or WebSocket a browser target made, as CDP reported it. */
interface Seen { targetType: string; kind: 'request' | 'websocket'; url: string }

interface CdpMessage { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; error?: unknown }

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Schemes that never touch the network. */
const NO_NETWORK_SCHEMES = new Set(['data:', 'blob:', 'about:', 'chrome:', 'chrome-extension:', 'devtools:']);

function isOnMachine(url: string): boolean {
  const parsed = new URL(url);
  return NO_NETWORK_SCHEMES.has(parsed.protocol) || LOCAL_HOSTS.has(parsed.hostname);
}

interface TargetInfo { type: string; url: string }

/** A step waiting for the watch to record a worker's requests. */
interface WorkerWaiter { path: string; resolve: () => void }

/** A step waiting for the watch to report a request to `url`. */
interface RequestWaiter { url: string; resolve: () => void }

/** Resolves with `promise`, or rejects with `message` after `ms`. */
function within<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), ms);
  });
  return Promise.race([promise, gaveUp]).finally(() => clearTimeout(timer));
}

/**
 * A CDP client on the browser's debugging port. It auto-attaches to every
 * target and records every request and WebSocket once Network is enabled on
 * the target.
 *
 * It can't hold a SharedWorker until then. The worker starts paused for each
 * auto-attached client, but Playwright detaches from every SharedWorker as
 * soon as it attaches, and that detach lets the worker run, before this
 * client has enabled Network. A request the worker sends in that window is
 * never reported (#2154). So a step that needs a worker's requests waits for
 * `watching` before it asks the worker to send.
 *
 * Its events arrive on its own connection, and Chromium doesn't order them
 * against the replies Playwright gets on another one. A page can hear that a
 * worker's request failed before this client hears the request was sent
 * (#2507). So a step that checks a request the page made waits for
 * `requested` first.
 */
class RequestWatch {
  readonly seen: Seen[] = [];
  readonly targetTypes = new Set<string>();
  private nextId = 0;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private readonly sessionTypes = new Map<string, string>();
  private readonly watchedPaths = new Set<string>();
  private readonly waiters: WorkerWaiter[] = [];
  private readonly requestWaiters: RequestWaiter[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.receive(JSON.parse(String(event.data)) as CdpMessage));
  }

  static async open(port: number): Promise<RequestWatch> {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not open ${version.webSocketDebuggerUrl}`)), { once: true });
    });
    const watch = new RequestWatch(socket);
    await watch.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return watch;
  }

  close(): void {
    this.socket.close();
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpMessage> {
    this.nextId += 1;
    const id = this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  private receive(message: CdpMessage): void {
    if (message.id !== undefined) {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      void this.watchTarget(message.params as { sessionId: string; targetInfo: TargetInfo });
      return;
    }
    this.record(message);
  }

  private record(message: CdpMessage): void {
    const targetType = this.sessionTypes.get(message.sessionId ?? '') ?? 'browser';
    if (message.method === 'Network.requestWillBeSent') {
      const request = (message.params as { request: { url: string } }).request;
      this.seen.push({ targetType, kind: 'request', url: request.url });
      for (const waiter of this.requestWaiters.filter((entry) => entry.url === request.url)) waiter.resolve();
    }
    if (message.method === 'Network.webSocketCreated') {
      this.seen.push({ targetType, kind: 'websocket', url: (message.params as { url: string }).url });
    }
  }

  /**
   * Resolves once Network is enabled on a SharedWorker whose script is at
   * `path`, so every request it sends from then on is recorded.
   */
  watching(path: string): Promise<void> {
    if (this.watchedPaths.has(path)) return Promise.resolve();
    const recorded = new Promise<void>((resolve) => this.waiters.push({ path, resolve }));
    return within(recorded, WORKER_START_MS, () => `no SharedWorker at ${path} started within ${WORKER_START_MS / 1000}s; targets: ${[...this.targetTypes].join(', ')}`);
  }

  /** Resolves once the watch has recorded a request to `url`. */
  requested(url: string): Promise<void> {
    if (this.seen.some((entry) => entry.kind === 'request' && entry.url === url)) return Promise.resolve();
    const recorded = new Promise<void>((resolve) => this.requestWaiters.push({ url, resolve }));
    return within(recorded, REQUEST_REPORT_MS, () => `the watch saw no request to ${url} within ${REQUEST_REPORT_MS / 1000}s; seen:\n${JSON.stringify(this.seen, null, 2)}`);
  }

  private markWatched(targetInfo: TargetInfo): void {
    if (targetInfo.type !== 'shared_worker') return;
    const path = new URL(targetInfo.url).pathname;
    this.watchedPaths.add(path);
    for (const waiter of this.waiters.filter((entry) => entry.path === path)) waiter.resolve();
  }

  /** Enables Network on a new target and its children, then lets it run. */
  private async watchTarget({ sessionId, targetInfo }: { sessionId: string; targetInfo: TargetInfo }): Promise<void> {
    this.sessionTypes.set(sessionId, targetInfo.type);
    this.targetTypes.add(targetInfo.type);
    await this.send('Network.enable', {}, sessionId);
    this.markWatched(targetInfo);
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  /** Requests and WebSockets to any host but the local machine's. */
  offMachine(): Seen[] {
    return this.seen.filter((entry) => !isOnMachine(entry.url));
  }
}

async function openPage(app: App, page: Page, url: string): Promise<void> {
  page.on('console', (message) => (app.browserLog as string[]).push(`[console.${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => (app.browserLog as string[]).push(`[pageerror] ${error.message}`));
  await page.goto(url);
  await page.waitForFunction(() => 'runWithAppCheck' in window);
}

export default scenario(async (app) => {
  const host = await app.step('start the dev server on the default plane', () => app.devServer());

  const debuggingPort = await app.freePort();
  const browser = await launchScenarioBrowser({ args: [`--remote-debugging-port=${debuggingPort}`] });
  try {
    const watch = await app.step('watch every request the browser makes, from pages and workers', () => RequestWatch.open(debuggingPort));
    const context = await browser.newContext();
    await guardContext(context, app.browserLog as string[]);
    await app.watchCrashes(context);
    const page = await context.newPage();
    await app.step('open the page', () => openPage(app, page, host.url));
    await app.step('the watch records the SharedWorker\'s requests', () => watch.watching(PYRIC_WORKER_PATH));

    await app.step('with App Check, generateContent answers and generateContentStream streams', async () => {
      const result = await page.evaluate(() => runWithAppCheck());
      assert.deepEqual(result, {
        generateContent: { ok: true, text: ANSWER },
        generateContentStream: { ok: true, chunks: CHUNKS, text: CHUNKS.join('') },
      });
    });

    await app.step('without App Check, the same calls get production\'s 401 and the terminal prints the hint', async () => {
      const since = host.process.mark();
      const result = await page.evaluate(() => runWithoutAppCheck());
      assert.deepEqual(result, {
        generateContent: refusal('generateContent'),
        generateContentStream: refusal('streamGenerateContent'),
      });
      await host.process.waitForLog(HINT, { since });
    });

    await app.step('every request the page and its workers made went to the local machine', () => {
      assert.ok(watch.targetTypes.has('shared_worker'), `the watch attached to no SharedWorker; targets: ${[...watch.targetTypes].join(', ')}`);
      assert.ok(watch.seen.some((entry) => entry.targetType === 'shared_worker'), `no SharedWorker request was seen:\n${JSON.stringify(watch.seen, null, 2)}`);
      assert.deepEqual(watch.offMachine(), []);
      assert.deepEqual(app.browserLog.filter((line) => line.startsWith('[blocked external')), []);
    });

    await app.step('the watch sees a SharedWorker request to an outside host, and it stays on the machine', async () => {
      await page.evaluate(() => openEgressControl());
      await watch.watching(CONTROL_WORKER_PATH);
      const outcome = await page.evaluate((url) => runEgressControl(url), CONTROL_URL);
      await watch.requested(CONTROL_URL);
      assert.equal(outcome, 'failed');
      assert.deepEqual(watch.offMachine(), [{ targetType: 'shared_worker', kind: 'request', url: CONTROL_URL }]);
    });
    watch.close();
  } finally {
    await browser.close();
  }
});
