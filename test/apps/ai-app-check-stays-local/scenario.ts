// An app that uses Firebase AI Logic the way pyric's AI Logic guide shows,
// with the modular firebase SDK through the Vite plugin, on the plugin's
// default plane (the SharedWorker) in Chromium:
//
// - With App Check initialized before getAI (the debug provider under
//   import.meta.env.DEV), generateContent answers and generateContentStream
//   delivers its reply in chunks.
// - Without App Check, the same calls get the 403 production returns from
//   November 2, 2026 (the app-check-ai-gate-wire capture, noHeader), and the
//   dev server terminal prints pyric's hint (#1535).
// - Every request the page makes goes to the local machine. Playwright's
//   routes don't see a SharedWorker's requests, so the scenario watches the
//   browser over its own CDP connection, attached to every page and worker
//   target before it runs, and records each request and WebSocket. A control
//   SharedWorker asks for an outside host at the end, which proves the watch
//   sees worker requests; the resolver rules stop that request on the machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { guardContext, launchScenarioBrowser, scenario, type App } from '../driver.ts';

declare function runWithAppCheck(): Promise<Record<string, unknown>>;
declare function runWithoutAppCheck(): Promise<Record<string, unknown>>;
declare function runEgressControl(url: string): Promise<string>;

const OBSERVATIONS = join(import.meta.dirname, '..', '..', '..', 'packages', 'conformance', 'observations', 'app-check');
const MODEL = 'gemini-flash-lite-latest';
const ANSWER = 'The report is ready for review.';
const CHUNKS = ['Requests stay ', 'on this machine, ', 'chunk by chunk.'];
const HINT = /Call initializeAppCheck\(app, \{ provider \}\) before getAI\(app\)\./;
const CONTROL_URL = 'https://egress-control.invalid/ai-app-check-stays-local';

interface GateCapture { behavior: { noHeader: { httpStatus: number; messageText: string } } }

function gateCapture(): GateCapture['behavior']['noHeader'] {
  const file = join(OBSERVATIONS, 'app-check-ai-gate-wire.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as GateCapture).behavior.noHeader;
}

/** The AIError the Firebase SDK throws for AI Logic's 403. A stream's URL carries `?alt=sse`, as the SDK builds it (#1640). */
function refusal(op: string) {
  const gate = gateCapture();
  const isStream = op === 'streamGenerateContent';
  const query = isStream ? '?alt=sse' : '';
  return {
    ok: false,
    name: 'FirebaseError',
    code: 'fetch-error',
    status: gate.httpStatus,
    statusText: 'Forbidden',
    message: `AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/sandbox/models/${MODEL}:${op}${query}: [${gate.httpStatus} Forbidden] ${gate.messageText} (AI/fetch-error)`,
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

/**
 * A CDP client on the browser's debugging port. It auto-attaches to every
 * target, pausing each until Network is enabled on it, so a worker's first
 * request is recorded too, and records every request and WebSocket.
 */
class RequestWatch {
  readonly seen: Seen[] = [];
  readonly targetTypes = new Set<string>();
  private nextId = 0;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private readonly sessionTypes = new Map<string, string>();

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
      void this.watchTarget(message.params as { sessionId: string; targetInfo: { type: string } });
      return;
    }
    this.record(message);
  }

  private record(message: CdpMessage): void {
    const targetType = this.sessionTypes.get(message.sessionId ?? '') ?? 'browser';
    if (message.method === 'Network.requestWillBeSent') {
      const request = (message.params as { request: { url: string } }).request;
      this.seen.push({ targetType, kind: 'request', url: request.url });
    }
    if (message.method === 'Network.webSocketCreated') {
      this.seen.push({ targetType, kind: 'websocket', url: (message.params as { url: string }).url });
    }
  }

  /** Enables Network on a new target and its children, then lets it run. */
  private async watchTarget({ sessionId, targetInfo }: { sessionId: string; targetInfo: { type: string } }): Promise<void> {
    this.sessionTypes.set(sessionId, targetInfo.type);
    this.targetTypes.add(targetInfo.type);
    await this.send('Network.enable', {}, sessionId);
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
    const page = await context.newPage();
    await app.step('open the page', () => openPage(app, page, host.url));

    await app.step('with App Check, generateContent answers and generateContentStream streams', async () => {
      const result = await page.evaluate(() => runWithAppCheck());
      assert.deepEqual(result, {
        generateContent: { ok: true, text: ANSWER },
        generateContentStream: { ok: true, chunks: CHUNKS, text: CHUNKS.join('') },
      });
    });

    await app.step('without App Check, the same calls get production\'s 403 and the terminal prints the hint', async () => {
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
      const outcome = await page.evaluate((url) => runEgressControl(url), CONTROL_URL);
      assert.equal(outcome, 'failed');
      assert.deepEqual(watch.offMachine(), [{ targetType: 'shared_worker', kind: 'request', url: CONTROL_URL }]);
    });
    watch.close();
  } finally {
    await browser.close();
  }
});
