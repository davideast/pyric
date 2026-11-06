// The browser seam for Messaging, in the test harness only: no package a user
// installs has it.
//
// `routeMessagingTo` relays every request a context's pages and workers send
// to Firebase Installations or FCM registrations to a replay server, and
// fulfills it with the replay's answer, so the SDK's own `fetch` reaches the
// replay while the scenario browser still blocks every other host.
//
// The push service is the one part that is not production's path (D2 in the
// Messaging plan). Headless Chromium has no push service and scenarios never
// reach Google, so `installPushStandIn` replaces
// `PushManager.prototype.subscribe`, `getSubscription` and the subscription's
// `unsubscribe` with a stand-in that returns capture M's endpoint shape and
// fixed keys (`CAPTURE_M_PUSH_SUBSCRIPTION`), and `deliverPush` sends a push
// through CDP `ServiceWorker.deliverPushMessage`, which fires the service
// worker's `push` event as the push service would. The SDK reads only
// `endpoint`, `getKey('p256dh')`, `getKey('auth')` and `unsubscribe()`.
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import type { JsonObject } from './format.ts';
import { CAPTURE_M_PUSH_SUBSCRIPTION } from './messaging-capture.ts';
import { MESSAGING_HOSTS } from './messaging.ts';

/** Request headers the relay does not pass on: they describe the hop to Google, not the call. */
const HOP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection']);
/** Response headers the fulfilled answer does not carry: Playwright sets its own length and framing. */
const HOP_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * Relays each Installations and registrations request from `context` to the
 * replay server at `replayOrigin`, as `<replayOrigin>/<host><path>`, and
 * answers it with the replay's status, headers and body. Register it after
 * `guardContext`: the last route registered answers first.
 */
export async function routeMessagingTo(context: BrowserContext, replayOrigin: string): Promise<void> {
  await context.route((url) => Object.hasOwn(MESSAGING_HOSTS, url.hostname), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = Object.fromEntries(Object.entries(await request.allHeaders()).filter(([name]) => !HOP_REQUEST_HEADERS.has(name) && !name.startsWith(':')));
    const body = request.postDataBuffer();
    const answer = await fetch(`${replayOrigin}/${url.hostname}${url.pathname}${url.search}`, { method: request.method(), headers, ...(body ? { body: new Uint8Array(body) } : {}) });
    const answerHeaders = Object.fromEntries([...answer.headers].filter(([name]) => !HOP_RESPONSE_HEADERS.has(name)));
    await route.fulfill({ status: answer.status, headers: answerHeaders, body: Buffer.from(await answer.arrayBuffer()) });
  });
}

/**
 * Replaces the browser's push subscription in every page of `context` with
 * the stand-in. Subscribing keeps the subscription in `localStorage`, so it
 * outlives a reload or a navigation, as the browser's own does, until
 * `unsubscribe()`.
 */
export async function installPushStandIn(context: BrowserContext): Promise<void> {
  await context.addInitScript((subscription) => {
    const STORED = 'pyric-replay-push-subscription';
    const decode = (base64url: string): ArrayBuffer => {
      const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
    };
    const standIn = () => ({
      endpoint: subscription.endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true },
      getKey: (name: string) => (name === 'p256dh' || name === 'auth' ? decode(subscription[name]) : null),
      unsubscribe: async () => {
        localStorage.removeItem(STORED);
        return true;
      },
      toJSON: () => ({ endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }),
    });
    if (typeof PushManager === 'undefined') return;
    PushManager.prototype.subscribe = async function subscribe() {
      localStorage.setItem(STORED, '1');
      return standIn() as unknown as PushSubscription;
    };
    PushManager.prototype.getSubscription = async function getSubscription() {
      return (localStorage.getItem(STORED) ? standIn() : null) as unknown as PushSubscription | null;
    };
  }, CAPTURE_M_PUSH_SUBSCRIPTION);
}

/**
 * Makes every page of `context` report `navigator.onLine` as true. Run with
 * the network off, Chromium sees only loopback and reports offline, which a
 * user's browser does not, and `@firebase/installations` then refuses every
 * call with `installations/app-offline` before it sends a request.
 */
export async function reportOnline(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => true });
  });
}

/**
 * Sends `payload`, as JSON, to the service worker registered for
 * `appOrigin` (the page's own origin by default), through CDP
 * `ServiceWorker.deliverPushMessage`. Pass `appOrigin` once the page has
 * navigated away from the app.
 */
export async function deliverPush(page: Page, payload: JsonObject, appOrigin: string = new URL(page.url()).origin): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const registrationId = await registrationFor(session, appOrigin);
    await session.send('ServiceWorker.deliverPushMessage', { origin: appOrigin, registrationId, data: JSON.stringify(payload) });
  } finally {
    await session.detach();
  }
}

/** The id of the live service worker registration whose scope is under `appOrigin`. */
async function registrationFor(session: CDPSession, appOrigin: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const found = new Promise<string>((resolve, reject) => {
    session.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const registration = registrations.find((entry) => !entry.isDeleted && entry.scopeURL.startsWith(`${appOrigin}/`));
      if (registration) resolve(registration.registrationId);
    });
    timer = setTimeout(() => reject(new Error(`no service worker registration for ${appOrigin} within ${REGISTRATION_TIMEOUT_MS} ms`)), REGISTRATION_TIMEOUT_MS);
  });
  try {
    await session.send('ServiceWorker.enable');
    return await found;
  } finally {
    clearTimeout(timer);
  }
}
