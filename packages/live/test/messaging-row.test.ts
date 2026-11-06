/**
 * The live-messaging and live-messaging-sw rows over stand-ins with the
 * Messaging SDK's signatures. Bun has no service worker, PushManager or
 * IndexedDB, so the real `firebase/messaging` cannot mint a token here (it
 * runs in the replay's browser test and the live-mode-messaging scenario).
 * The stand-in SDK sends no request: each call puts the Resource Timing
 * entries capture M recorded for it on a stand-in `PerformanceObserver`, as
 * the browser would for the SDK's own `fetch`, and settles as the SDK does.
 *
 * Each record must name the project and production's answer, list the
 * Installations and FCM registration requests the call made (API and action
 * only), and carry no token, FID, push key or payload text. A call that made
 * no request makes no record.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { observedCallOf } from '../src/page-observer.js';
import { wrapLiveModule, type LiveCallRecord, type LiveModuleSite, type LiveObserver } from '../src/index.js';
import { LIVE_REFUSED } from '../src/refusal.js';

/** The host reader and event builder this test uses, loaded at run time so this package's typecheck stays out of them. */
interface Loaded {
  readObservedCall(value: unknown): unknown;
  observedCallEvent(call: unknown): { detail?: { requests?: unknown } };
}

async function load(): Promise<Loaded> {
  return (await import(new URL('../../pyric/src/sandbox/internal/observed-call.ts', import.meta.url).href)) as Loaded;
}

const loaded = await load();
const PROJECT = 'demo-live-messaging';
const INSTALLATIONS = `https://firebaseinstallations.googleapis.com/v1/projects/${PROJECT}/installations`;
const REGISTRATIONS = `https://fcmregistrations.googleapis.com/v1/projects/${PROJECT}/registrations`;
/** Values no record may carry: an FID, an FCM token, the VAPID key, a push key and payload text. */
const FID = 'cD5xQ7rTnBm2Lk9Wv3YpZa';
const FCM_TOKEN = 'fcm-token-dGhpcyBpcyBub3QgYSByZWFsIHRva2Vu';
const VAPID_KEY = 'BOv4pYvapidkeyStandInForTheAppsOwnKey0123456789';
const PUSH_AUTH = 'q1w2e3r4t5y6u7i8o9p0aZ';
const PAYLOAD_TEXT = 'order 42 shipped';
const SECRETS = [FID, FCM_TOKEN, VAPID_KEY, PUSH_AUTH, PAYLOAD_TEXT];

/** One Resource Timing entry as the browser reports it for the SDK's `fetch`. */
interface StandInEntry {
  readonly name: string;
  readonly entryType: 'resource';
  readonly startTime: number;
  readonly responseStatus: number;
}

/** A stand-in for the browser's `PerformanceObserver`: entries the stand-in SDK reports wait in each observer until taken. */
class StandInPerformanceObserver {
  static readonly live = new Set<StandInPerformanceObserver>();
  static readonly supportedEntryTypes = ['resource'];
  private pending: StandInEntry[] = [];
  constructor(private readonly callback: (list: { getEntries(): StandInEntry[] }) => void) {}
  observe(options: { type?: string }): void {
    if (options.type === 'resource') StandInPerformanceObserver.live.add(this);
  }
  disconnect(): void {
    StandInPerformanceObserver.live.delete(this);
  }
  takeRecords(): StandInEntry[] {
    const taken = this.pending;
    this.pending = [];
    return taken;
  }
  /** Reports one entry, as the browser does when a request ends; the callback runs later, as the browser's task does. */
  static report(name: string, responseStatus: number): void {
    const entry: StandInEntry = { name, entryType: 'resource', startTime: performance.now(), responseStatus };
    for (const observer of StandInPerformanceObserver.live) {
      observer.pending.push(entry);
      setTimeout(() => {
        const entries = observer.takeRecords();
        if (entries.length > 0) observer.callback({ getEntries: () => entries });
      }, 5);
    }
  }
}

/** An SDK error, shaped as `@firebase/util`'s `FirebaseError`. */
function sdkError(code: string, customData?: Record<string, unknown>): Error {
  return Object.assign(new Error(`Messaging: ${code} ${FCM_TOKEN}`), { name: 'FirebaseError', code, ...(customData === undefined ? {} : { customData }) });
}

/** What the stand-in SDK's next getToken or deleteToken does: the requests it reports, then how it settles. */
interface Script {
  readonly requests: readonly (readonly [url: string, status: number])[];
  readonly error?: Error;
}

let next: Script = { requests: [] };
/** The FID-registration exports the stand-ins were called through; a refused one never adds to it. */
const registrationCalls: string[] = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));

async function runScript(value: unknown): Promise<unknown> {
  const script = next;
  await pause();
  for (const [url, status] of script.requests) {
    StandInPerformanceObserver.report(url, status);
    await pause();
  }
  if (script.error !== undefined) throw script.error;
  return value;
}

type Listener = (payload: unknown) => void;
type NextOrObserver = Listener | { next?: Listener };

/** The SDK's own reading of `nextOrObserver`: a function, or an observer's `next`. */
function nextOf(nextOrObserver: NextOrObserver): Listener {
  if (typeof nextOrObserver === 'function') return nextOrObserver;
  return (payload) => nextOrObserver.next?.(payload);
}
const foreground: Listener[] = [];
const background: Listener[] = [];
const app = { name: '[DEFAULT]', options: { projectId: PROJECT, apiKey: 'test-api-key', appId: '1:1:web:live-messaging', messagingSenderId: '1' } };
const messaging = { app };

/** `firebase/messaging`'s exports, as stand-ins with the SDK's signatures. */
const realMessaging = {
  getMessaging: () => messaging,
  isSupported: async () => true,
  getToken: (_messaging: unknown, _options?: unknown) => runScript(FCM_TOKEN),
  deleteToken: (_messaging: unknown) => runScript(true),
  onMessage: (_messaging: unknown, nextOrObserver: NextOrObserver) => {
    foreground.push(nextOf(nextOrObserver));
    return () => undefined;
  },
  register: async (_messaging: unknown, _options?: unknown) => {
    registrationCalls.push('register');
  },
  unregister: async (_messaging: unknown) => {
    registrationCalls.push('unregister');
  },
  onRegistered: (_messaging: unknown, _nextOrObserver: NextOrObserver) => {
    registrationCalls.push('onRegistered');
    return () => undefined;
  },
  onUnregistered: (_messaging: unknown, _nextOrObserver: NextOrObserver) => {
    registrationCalls.push('onUnregistered');
    return () => undefined;
  },
};

/** `firebase/messaging/sw`'s exports, as stand-ins with the SDK's signatures. */
const realMessagingSw = {
  getMessaging: () => messaging,
  isSupported: async () => true,
  onBackgroundMessage: (_messaging: unknown, nextOrObserver: NextOrObserver) => {
    background.push(nextOf(nextOrObserver));
    return () => undefined;
  },
  experimentalSetDeliveryMetricsExportedToBigQueryEnabled: () => undefined,
  onRegistered: realMessaging.onRegistered,
  onUnregistered: realMessaging.onUnregistered,
};

const records: LiveCallRecord[] = [];
const observer: LiveObserver = (record) => {
  records.push(record);
};
const site: LiveModuleSite = { observer, sdkVersion: '12.19.0', client: 'page' };
const page = wrapLiveModule('live-messaging', 'firebase/messaging', realMessaging, site);
const worker = wrapLiveModule('live-messaging-sw', 'firebase/messaging/sw', realMessagingSw, site);
const realObserver = (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;

beforeEach(() => {
  (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = StandInPerformanceObserver;
  records.length = 0;
});

afterEach(() => {
  (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver = realObserver;
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a record');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Runs one call with a script, and the records it made once the row has read its requests. */
async function recorded(script: Script, call: () => Promise<unknown>): Promise<LiveCallRecord[]> {
  next = script;
  await call().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return [...records];
}

/** The observed call the page plane sends for a record, read back by the host's own reader. */
function hostRead(record: LiveCallRecord): Record<string, unknown> {
  const call = observedCallOf(record, Date.now());
  expect(call).not.toBeNull();
  return loaded.readObservedCall(JSON.parse(JSON.stringify(call))) as Record<string, unknown>;
}

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe('the live-messaging row records getToken and deleteToken with the requests they made', () => {
  test('a fresh getToken: ok, with Installations create and registrations create, and no token', async () => {
    const options = { vapidKey: VAPID_KEY };
    next = { requests: [[INSTALLATIONS, 200], [REGISTRATIONS, 200]] };
    const token = await page.getToken(messaging, options);
    expect(token).toBe(FCM_TOKEN);
    await until(() => records.length === 1);
    const [record] = records;
    expect(record).toMatchObject({ module: 'firebase/messaging', name: 'getToken', outcome: 'resolved', projectId: PROJECT });
    expect(record?.requests).toEqual([
      { api: 'installations', action: 'create', status: 200 },
      { api: 'registrations', action: 'create', status: 200 },
    ]);
    const call = hostRead(record!);
    expect(call).toMatchObject({ service: 'messaging', method: 'getToken', outcome: { status: 'ok' }, projectId: PROJECT });
    expect(loaded.observedCallEvent(call).detail).toEqual({ requests: record!.requests });
    expectNoSecrets([record, call]);
  });

  test('a getToken the registrations API answers 403: permission_denied, read from the request', async () => {
    const error = sdkError('messaging/token-subscribe-failed');
    const [record] = await recorded({ requests: [[INSTALLATIONS, 200], [REGISTRATIONS, 403]], error }, () => page.getToken(messaging));
    expect(record).toMatchObject({ name: 'getToken', outcome: 'rejected', code: 'permission_denied' });
    expect(record?.requests).toEqual([
      { api: 'installations', action: 'create', status: 200 },
      { api: 'registrations', action: 'create', status: 403 },
    ]);
    expect(hostRead(record!)).toMatchObject({ outcome: { status: 'error', code: 'permission_denied' } });
    expectNoSecrets(record);
  });

  test('an Installations denial whose responseStatus reads 0: the status is left out and the code is the server status the SDK kept', async () => {
    const error = sdkError('installations/request-failed', { requestName: 'Create Installation', serverCode: 400, serverStatus: 'INVALID_ARGUMENT', serverMessage: 'API key not valid.' });
    const [record] = await recorded({ requests: [[INSTALLATIONS, 0]], error }, () => page.getToken(messaging));
    expect(record).toMatchObject({ outcome: 'rejected', code: 'invalid_argument', requests: [{ api: 'installations', action: 'create' }] });
    expect(record?.requests?.[0]).not.toHaveProperty('status');
    hostRead(record!);
    expectNoSecrets(record);
  });

  test('an Installations denial with no Resource Timing entry is still recorded, with the server status the SDK kept', async () => {
    const error = sdkError('installations/request-failed', { requestName: 'Create Installation', serverCode: 403, serverStatus: 'PERMISSION_DENIED' });
    const [record] = await recorded({ requests: [], error }, () => page.getToken(messaging));
    expect(record).toMatchObject({ outcome: 'rejected', code: 'permission_denied' });
    expect(record).not.toHaveProperty('requests');
    hostRead(record!);
    expectNoSecrets(record);
  });

  test('a getToken whose fetch threw before production answered makes no record, though the SDK says token-subscribe-failed', async () => {
    const error = sdkError('messaging/token-subscribe-failed', { errorInfo: 'TypeError: Failed to fetch' });
    expect(await recorded({ requests: [], error }, () => page.getToken(messaging))).toEqual([]);
  });

  test('a getToken that refreshes its stored token: registrations update', async () => {
    const [record] = await recorded({ requests: [[`${REGISTRATIONS}/${FCM_TOKEN}`, 200]] }, () => page.getToken(messaging));
    expect(record?.requests).toEqual([{ api: 'registrations', action: 'update', status: 200 }]);
    expectNoSecrets(record);
  });

  test('a getToken that replaces its stored token: registrations delete, then create, and Installations generateAuthToken', async () => {
    const script: Script = { requests: [[`${INSTALLATIONS}/${FID}/authTokens:generate`, 200], [`${REGISTRATIONS}/${FCM_TOKEN}`, 200], [REGISTRATIONS, 200]] };
    const [record] = await recorded(script, () => page.getToken(messaging));
    expect(record?.requests).toEqual([
      { api: 'installations', action: 'generateAuthToken', status: 200 },
      { api: 'registrations', action: 'delete', status: 200 },
      { api: 'registrations', action: 'create', status: 200 },
    ]);
    expectNoSecrets(record);
  });

  test('more than four requests in a call\'s window: the record keeps the last four, which a host takes', async () => {
    const script: Script = { requests: [[INSTALLATIONS, 200], [INSTALLATIONS, 200], [`${INSTALLATIONS}/${FID}/authTokens:generate`, 200], [`${INSTALLATIONS}/${FID}/authTokens:generate`, 200], [REGISTRATIONS, 200], ['https://example.com/other', 200]] };
    const [record] = await recorded(script, () => page.getToken(messaging));
    expect(record?.requests).toHaveLength(4);
    expect(record?.requests?.at(-1)).toEqual({ api: 'registrations', action: 'create', status: 200 });
    hostRead(record!);
  });

  test('deleteToken: ok, with registrations delete', async () => {
    const [record] = await recorded({ requests: [[`${REGISTRATIONS}/${FCM_TOKEN}`, 200]] }, () => page.deleteToken(messaging));
    expect(record).toMatchObject({ name: 'deleteToken', outcome: 'resolved', projectId: PROJECT, requests: [{ api: 'registrations', action: 'delete', status: 200 }] });
    expect(hostRead(record!)).toMatchObject({ service: 'messaging', method: 'deleteToken', outcome: { status: 'ok' } });
    expectNoSecrets(record);
  });

  test('a getToken answered from the stored token, and a deleteToken with none stored, make no record', async () => {
    expect(await recorded({ requests: [] }, () => page.getToken(messaging))).toEqual([]);
    expect(await recorded({ requests: [] }, () => page.deleteToken(messaging))).toEqual([]);
  });

  test('a getToken the SDK refuses before any request makes no record', async () => {
    expect(await recorded({ requests: [], error: sdkError('messaging/permission-blocked') }, () => page.getToken(messaging))).toEqual([]);
  });

  test('the app gets the SDK\'s own value and error', async () => {
    next = { requests: [[INSTALLATIONS, 200], [REGISTRATIONS, 200]] };
    expect(await page.getToken(messaging)).toBe(FCM_TOKEN);
    const error = sdkError('messaging/token-subscribe-failed');
    next = { requests: [[REGISTRATIONS, 403]], error };
    await expect(page.getToken(messaging)).rejects.toBe(error);
    await until(() => records.length === 2);
  });

  test('without PerformanceObserver, every settled call is recorded, without requests', async () => {
    delete (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver;
    const [record] = await recorded({ requests: [] }, () => page.getToken(messaging));
    expect(record).toMatchObject({ name: 'getToken', outcome: 'resolved', projectId: PROJECT });
    expect(record).not.toHaveProperty('requests');
    hostRead(record!);
  });

  test('isSupported makes no record', async () => {
    expect(await page.isSupported()).toBe(true);
    expect(await worker.isSupported()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(records).toEqual([]);
  });
});

describe('the live-messaging rows record one row per delivery the SDK hands the app', () => {
  const payload = { from: '1', messageId: FCM_TOKEN, notification: { title: PAYLOAD_TEXT }, data: { auth: PUSH_AUTH, fid: FID } };

  test('onMessage: one delivered record per foreground message, and no payload text', () => {
    const seen: unknown[] = [];
    page.onMessage(messaging, (message) => seen.push(message));
    foreground.at(-1)?.(payload);
    foreground.at(-1)?.(payload);
    expect(seen).toEqual([payload, payload]);
    const delivered = records.filter((record) => record.outcome === 'delivered');
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({ module: 'firebase/messaging', name: 'onMessage', projectId: PROJECT });
    expect(hostRead(delivered[0]!)).toMatchObject({ service: 'messaging', method: 'onMessage', outcome: { status: 'ok' } });
    expectNoSecrets(records);
  });

  test('onBackgroundMessage: one delivered record per background message, and no payload text', () => {
    const seen: unknown[] = [];
    worker.onBackgroundMessage(messaging, { next: (message: unknown) => seen.push(message) });
    background.at(-1)?.(payload);
    expect(seen).toEqual([payload]);
    const delivered = records.filter((record) => record.outcome === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ module: 'firebase/messaging/sw', name: 'onBackgroundMessage', projectId: PROJECT });
    expect(hostRead(delivered[0]!)).toMatchObject({ service: 'messaging', method: 'onBackgroundMessage' });
    expectNoSecrets(records);
  });

  test('a subscribe call sends no row', () => {
    page.onMessage(messaging, () => undefined);
    const subscribed = records.filter((record) => record.outcome === 'returned');
    expect(subscribed).toHaveLength(1);
    expect(observedCallOf(subscribed[0]!, Date.now())).toBeNull();
  });
});

describe('the live-messaging rows refuse the FID registration calls they do not observe', () => {
  const refusal = (call: string) =>
    `@pyric/live: ${call} is refused in live mode, from a page: it would reach FCM registration by Firebase Installation ID, ` +
    'and live mode serves only getToken, deleteToken, onMessage and onBackgroundMessage. The call threw before any request left.';

  test('register and unregister throw the refusal before the SDK runs', () => {
    registrationCalls.length = 0;
    expect(() => page.register(messaging, { vapidKey: VAPID_KEY })).toThrow(expect.objectContaining({ code: LIVE_REFUSED }));
    expect(() => page.register(messaging)).toThrow(refusal('register'));
    expect(() => page.unregister(messaging)).toThrow(expect.objectContaining({ code: LIVE_REFUSED }));
    expect(() => page.unregister(messaging)).toThrow(refusal('unregister'));
    expect(registrationCalls).toEqual([]);
  });

  test('onRegistered and onUnregistered throw the refusal in the page and in the service worker', () => {
    registrationCalls.length = 0;
    for (const entry of [page, worker]) {
      expect(() => entry.onRegistered(messaging, () => undefined)).toThrow(expect.objectContaining({ code: LIVE_REFUSED }));
      expect(() => entry.onRegistered(messaging, () => undefined)).toThrow(refusal('onRegistered'));
      expect(() => entry.onUnregistered(messaging, () => undefined)).toThrow(refusal('onUnregistered'));
    }
    expect(registrationCalls).toEqual([]);
  });

  test('a refusal makes no record and carries no VAPID key', () => {
    let message = '';
    try {
      page.register(messaging, { vapidKey: VAPID_KEY });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith('@pyric/live: register is refused in live mode');
    expectNoSecrets(message);
    expect(records).toEqual([]);
  });
});
