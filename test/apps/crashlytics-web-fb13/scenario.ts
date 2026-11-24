// End-to-end browser scenario proving real firebase@13.4.0
// (@firebase/crashlytics@0.2.0) runs against packed Pyric tarballs in Chromium:
//
// - Verifies the installed app resolved real firebase@13.4.0 and
//   @firebase/crashlytics@0.2.0 from npm alongside packed Pyric tarballs.
// - Exercises firebase/crashlytics plus all four framework subpath mirrors
//   (/react, /next-navigation, /react-router, /angular) in a real browser page.
// - Verifies structured logs, route and custom breadcrumbs, handled errors,
//   unhandled window error and unhandledrejection capture, flush(), and
//   authoritative CrashlyticsBroker state over the local HostedRuntime bridge.
// - Watches every browser page and worker target over CDP plus guardContext to
//   prove zero outbound requests to clienttelemetry.googleapis.com or any
//   other off-machine endpoint.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  guardContext,
  launchScenarioBrowser,
  scenario,
  sessionHeaders,
  type App,
  type ExpectedCrash,
} from '../driver.ts';

declare global {
  interface Window {
    crashlyticsReady?: boolean;
    runHandledAndFrameworkFlow(): Promise<{
      angularBrand: unknown;
      reactMountResult: unknown;
      nextRoutesResult: unknown;
      parameterizedRoute: string;
      matchedLeafId: string | null;
      angularRawPath: string;
      angularSafePath: string;
      externalEndpointRefused: boolean;
      mismatchedOptionsRefused: boolean;
    }>;
    triggerUnhandledErrorsAndFlush(): Promise<{ flushed: boolean }>;
  }
}

const APP_ID = '1:1340:web:fb13browser';

export const expectedCrashes: ExpectedCrash[] = [
  {
    message: /TypeError: unhandled-window-crash/,
    source: /^page http:\/\/127\.0\.0\.1:/,
    reason: 'Exercises FirebaseCrashlytics window error capture in a real browser page.',
  },
  {
    message: /URIError: unhandled-promise-crash/,
    source: /^page http:\/\/127\.0\.0\.1:/,
    reason: 'Exercises FirebaseCrashlytics unhandledrejection capture in a real browser page.',
  },
];

interface SeenRequest {
  targetType: string;
  kind: 'request' | 'websocket';
  url: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface TargetInfo {
  type: string;
  url: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const NO_NETWORK_SCHEMES = new Set([
  'data:',
  'blob:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
]);

function isOnMachine(url: string): boolean {
  const parsed = new URL(url);
  return NO_NETWORK_SCHEMES.has(parsed.protocol) || LOCAL_HOSTS.has(parsed.hostname);
}

function isTelemetryEndpoint(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname === 'clienttelemetry.googleapis.com') {
    return true;
  }
  return (
    hostname.startsWith('clienttelemetry.') &&
    hostname.endsWith('.rep.googleapis.com')
  );
}

class RequestWatch {
  readonly seen: SeenRequest[] = [];
  private nextId = 0;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private readonly sessionTypes = new Map<string, string>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      this.receive(JSON.parse(String(event.data)) as CdpMessage);
    });
  }

  static async open(port: number): Promise<RequestWatch> {
    const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
    const version = (await versionResponse.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error(`could not open ${version.webSocketDebuggerUrl}`)),
        { once: true },
      );
    });
    const watch = new RequestWatch(socket);
    await watch.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    return watch;
  }

  close(): void {
    this.socket.close();
  }

  offMachine(): SeenRequest[] {
    return this.seen.filter((entry) => !isOnMachine(entry.url));
  }

  telemetryRequests(): SeenRequest[] {
    return this.seen.filter((entry) => isTelemetryEndpoint(entry.url));
  }

  private send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpMessage> {
    this.nextId += 1;
    const id = this.nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) {
      payload.sessionId = sessionId;
    }
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  private receive(message: CdpMessage): void {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (waiter !== undefined) {
        waiter(message);
        this.pending.delete(message.id);
      }
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      const attached = message.params as { sessionId: string; targetInfo: TargetInfo };
      void this.watchTarget(attached);
      return;
    }
    const targetType = this.sessionTypes.get(message.sessionId ?? '') ?? 'browser';
    if (message.method === 'Network.requestWillBeSent') {
      const request = (message.params as { request: { url: string } }).request;
      this.seen.push({ targetType, kind: 'request', url: request.url });
    }
    if (message.method === 'Network.webSocketCreated') {
      const created = message.params as { url: string };
      this.seen.push({ targetType, kind: 'websocket', url: created.url });
    }
  }

  private async watchTarget({
    sessionId,
    targetInfo,
  }: {
    sessionId: string;
    targetInfo: TargetInfo;
  }): Promise<void> {
    this.sessionTypes.set(sessionId, targetInfo.type);
    await this.send('Network.enable', {}, sessionId);
    await this.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
}

interface BrokerReport {
  name: string;
  message: string;
  fatal: boolean;
  flushed: boolean;
  sdkPlatform: string;
  appVersion: string | null;
  region: string | null;
  attributes: Record<string, unknown>;
  breadcrumbs: Array<{ message: string; attributes?: Record<string, unknown> }>;
}

interface BrokerState {
  appVersion: string | null;
  region: string | null;
  logs: Array<{ message: string; attributes?: Record<string, unknown> }>;
  reports: BrokerReport[];
}

function resolveBridgeWsUrl(hostUrl: string, bridgeUrl: string): string {
  if (bridgeUrl.startsWith('ws://') || bridgeUrl.startsWith('wss://')) {
    return bridgeUrl;
  }
  const base = new URL(hostUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(bridgeUrl, base).toString();
}

async function readHostedCrashlyticsState(
  app: App,
  hostUrl: string,
  appId: string,
): Promise<BrokerState> {
  const initRes = await fetch(`${hostUrl}/__pyric/init.json`, {
    headers: sessionHeaders(app, hostUrl),
  });
  assert.equal(initRes.status, 200);
  const initPayload = (await initRes.json()) as {
    bridgeUrl?: string;
    instanceId?: string;
  };
  assert.equal(typeof initPayload.bridgeUrl, 'string');
  const wsUrl = resolveBridgeWsUrl(hostUrl, initPayload.bridgeUrl ?? '/__pyric/sandbox');

  const socket = new WebSocket(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error(`failed to open bridge socket ${wsUrl}`)),
        { once: true },
      );
    });

    const statePromise = new Promise<BrokerState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('timed out waiting for crashlytics.getState over HostedRuntime'));
      }, 10_000);

      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          error?: { message?: string } | string;
          message?: {
            t?: string;
            id?: string;
            ok?: boolean;
            value?: BrokerState;
            error?: { message?: string };
          };
        };
        if (frame.type === 'attach-ack') {
          socket.send(
            JSON.stringify({
              type: 'worker-message',
              message: {
                t: 'op',
                id: 'inspect-crashlytics-state',
                method: 'crashlytics.getState',
                appId,
              },
            }),
          );
          return;
        }
        if (frame.type === 'attach-error' || frame.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(`HostedRuntime attach error: ${JSON.stringify(frame)}`));
          return;
        }
        if (
          frame.type === 'worker-message-result' &&
          frame.message?.t === 'res' &&
          frame.message.id === 'inspect-crashlytics-state'
        ) {
          clearTimeout(timeout);
          if (frame.message.ok && frame.message.value !== undefined) {
            resolve(frame.message.value);
          } else {
            reject(
              new Error(
                `crashlytics.getState failed: ${frame.message.error?.message ?? 'unknown error'}`,
              ),
            );
          }
        }
      });
    });

    const attachFrame: Record<string, unknown> = {
      type: 'attach',
      protocol: 1,
      capabilities: ['pyric/firestore-values/1'],
      transport: 'worker-port',
      clientInfo: { platform: 'node' },
    };
    if (typeof initPayload.instanceId === 'string') {
      attachFrame.hostInstanceId = initPayload.instanceId;
    }
    socket.send(JSON.stringify(attachFrame));

    return await statePromise;
  } finally {
    socket.close();
  }
}

async function openReadyPage(app: App, page: Page, url: string): Promise<void> {
  page.on('console', (message) => {
    (app.browserLog as string[]).push(`[console.${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    (app.browserLog as string[]).push(`[pageerror] ${error.message}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.crashlyticsReady === true);
}

export default scenario(async (app) => {
  await app.step('verify firebase@13.4.0 and @firebase/crashlytics@0.2.0 are installed', () => {
    const firebaseManifest = JSON.parse(
      readFileSync(join(app.dir, 'node_modules/firebase/package.json'), 'utf8'),
    ) as { version?: string };
    const crashlyticsManifest = JSON.parse(
      readFileSync(
        join(app.dir, 'node_modules/@firebase/crashlytics/package.json'),
        'utf8',
      ),
    ) as { version?: string };
    assert.equal(firebaseManifest.version, '13.4.0');
    assert.equal(crashlyticsManifest.version, '0.2.0');
  });

  const host = await app.step('start the Vite dev server with HostedRuntime', () =>
    app.devServer(),
  );

  const debuggingPort = await app.freePort();
  const browser = await launchScenarioBrowser({
    args: [`--remote-debugging-port=${debuggingPort}`],
  });

  try {
    const watch = await app.step('watch all browser and worker network activity over CDP', () =>
      RequestWatch.open(debuggingPort),
    );
    const context = await browser.newContext();
    await guardContext(context, app.browserLog as string[]);
    await app.watchCrashes(context);
    const page = await context.newPage();

    await app.step('open the page in Chromium', () =>
      openReadyPage(app, page, host.url),
    );

    await app.step('exercise firebase/crashlytics and all four framework subpath mirrors', async () => {
      const flow = await page.evaluate(() => window.runHandledAndFrameworkFlow());
      assert.deepEqual(flow, {
        angularBrand: 'EnvironmentProviders',
        reactMountResult: null,
        nextRoutesResult: null,
        parameterizedRoute: '/orders/:orderId/items/:itemId',
        matchedLeafId: 'order-detail',
        angularRawPath: '/catalog/shoes',
        angularSafePath: '/catalog/:category',
        externalEndpointRefused: true,
        mismatchedOptionsRefused: true,
      });
    });

    await app.step('capture unhandled window error and unhandledrejection and flush', async () => {
      const unhandled = await page.evaluate(() => window.triggerUnhandledErrorsAndFlush());
      assert.deepEqual(unhandled, { flushed: true });
    });

    await app.step('inspect CrashlyticsBroker state over the local HostedRuntime bridge', async () => {
      const state = await readHostedCrashlyticsState(app, host.url, APP_ID);
      assert.equal(state.appVersion, '13.4.0-web-e2e');
      assert.equal(state.region, 'europe-west1');

      assert.deepEqual(
        state.logs.map((entry) => entry.message),
        [
          'Navigation event',
          'Navigation event',
          'payment-submitted',
          'before-unhandled-window-error',
          'before-unhandled-rejection',
        ],
      );
      assert.deepEqual(state.logs[0]?.attributes, {
        surface: 'storefront-web',
        'app.screen.id': '/checkout',
      });
      assert.deepEqual(state.logs[1]?.attributes, {
        surface: 'storefront-web',
        'app.screen.id': '/orders/:orderId',
      });
      assert.deepEqual(state.logs[2]?.attributes, {
        surface: 'storefront-web',
        method: 'card',
        cents: 4999,
      });

      assert.equal(state.reports.length, 4);

      const cardDeclined = state.reports[0];
      assert.ok(cardDeclined !== undefined);
      assert.equal(cardDeclined.name, 'RangeError');
      assert.equal(cardDeclined.message, 'card-declined');
      assert.equal(cardDeclined.fatal, false);
      assert.equal(cardDeclined.flushed, true);
      assert.equal(cardDeclined.sdkPlatform, 'web');
      assert.deepEqual(cardDeclined.attributes, {
        surface: 'storefront-web',
        retryable: true,
      });
      assert.deepEqual(
        cardDeclined.breadcrumbs.map((crumb) => crumb.message),
        ['Navigation event', 'Navigation event', 'payment-submitted'],
      );

      const ngError = state.reports[1];
      assert.ok(ngError !== undefined);
      assert.equal(ngError.name, 'Error');
      assert.equal(ngError.message, 'angular-zone-error');
      assert.equal(ngError.fatal, false);
      assert.equal(ngError.flushed, true);
      assert.deepEqual(ngError.breadcrumbs, []);

      const windowCrash = state.reports[2];
      assert.ok(windowCrash !== undefined);
      assert.equal(windowCrash.name, 'TypeError');
      assert.equal(windowCrash.message, 'unhandled-window-crash');
      assert.equal(windowCrash.fatal, true);
      assert.equal(windowCrash.flushed, true);
      assert.deepEqual(
        windowCrash.breadcrumbs.map((crumb) => crumb.message),
        ['before-unhandled-window-error'],
      );

      const promiseCrash = state.reports[3];
      assert.ok(promiseCrash !== undefined);
      assert.equal(promiseCrash.name, 'URIError');
      assert.equal(promiseCrash.message, 'unhandled-promise-crash');
      assert.equal(promiseCrash.fatal, true);
      assert.equal(promiseCrash.flushed, true);
      assert.deepEqual(
        promiseCrash.breadcrumbs.map((crumb) => crumb.message),
        ['before-unhandled-rejection'],
      );
    });

    await app.step('assert zero outbound requests to clienttelemetry.googleapis.com or any off-machine host', () => {
      assert.ok(watch.seen.length > 0, 'expected CDP watch to record local page requests');
      assert.deepEqual(watch.telemetryRequests(), []);
      assert.deepEqual(watch.offMachine(), []);
      assert.deepEqual(
        app.browserLog.filter((line) => line.startsWith('[blocked external')),
        [],
      );
    });

    watch.close();
  } finally {
    await browser.close();
  }
});
