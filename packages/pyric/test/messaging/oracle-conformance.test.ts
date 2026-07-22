/**
 * Oracle conformance — messaging CLIENT + SERVICE-WORKER receive planes
 * (surface `messaging`, the `pyric` package). This suite was authored RED under
 * Conformance Driven Development (CDD; see `docs/conformance/cdd.md`, Step 3),
 * BEFORE any mirror implementation existed.
 *
 * ─── BLOCKING ─────────────────────────────────────────────────────────────────
 * The suite runs un-gated in this package's normal test path:
 *
 *     bun test --cwd packages/pyric
 *
 * Every messaging row's `conforms` status is backed by this suite passing in
 * blocking CI. Bare `getMessaging()` calls run after initializing the standard
 * Firebase default app, matching the production SDK contract.
 *
 * ─── HOW EACH ASSERTION SET IS SHAPED ─────────────────────────────────────────
 * Rows are read DIRECTLY from `packages/conformance/registry/messaging.ts`
 * (`messagingRows`), filtered to the two receive-plane surfaces this package
 * owns. There is exactly one `it(row.id …)` per row (CDD Step 3: "one assertion
 * set per row"). Where a row cites committed `messaging-web-*` observations, the
 * observation JSON is loaded and its recorded values are the EXPECTED side —
 * never re-derived by hand (CDD Step 3) — driven against the mirror.
 * Rows with no observation are shape/export witnesses at documentation strength;
 * deep type conformance is closed by the tier-2 assignability census (CDD
 * resolved decision #5), not by a runtime replay.
 *
 * The completeness test at the bottom enforces this suite's half of the row
 * partition: it owns EXACTLY the `messaging` (client + sw) rows, the
 * `messaging-admin` suite owns the rest, the two are disjoint, and together they
 * cover every row in the registry file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messagingRows } from '../../../../packages/conformance/registry/messaging.ts';
import { initializeApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { BrokerSendError, DEFAULT_SENDER_ID, getMessagingBroker } from 'pyric/messaging/internal';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

beforeAll(async () => {
  await resetAppRegistryForTests();
  initializeApp({ projectId: 'messaging-oracle-conformance' });
});
afterAll(async () => {
  await resetAppRegistryForTests();
});

/** Repo-root observations directory (four levels up from this test file).
 *  messaging-web-* observations live under the 'messaging' surface
 *  subdirectory. */
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'messaging');

/** Load the frozen `behavior` block of a committed observation by name. */
function obs(name: string): Record<string, any> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, any>;
  };
  return json.behavior;
}

/**
 * The mirror entry points, memoized so each module is imported once per run.
 * Typed `any` on purpose: the suite drives the runtime surface the rows
 * describe rather than the mirror's own type declarations, so a type-level
 * regression cannot silently satisfy a runtime assertion.
 */
let clientMirror: Promise<any> | null = null;
let swMirror: Promise<any> | null = null;
/* eslint-disable @typescript-eslint/no-implied-eval */
const loadClient = (): Promise<any> => (clientMirror ??= import('pyric/messaging'));
const loadSw = (): Promise<any> => (swMirror ??= import('pyric/messaging/sw'));

/** The rows this package owns: client + service-worker receive planes. */
const clientRows = messagingRows.filter((r) => r.surface === 'messaging');

/**
 * Map a DRIVEN `DeliveryResult.route` onto the handler names the routing
 * observation records, so the pinned `deliveredTo` values can be compared
 * against what the broker actually did rather than re-asserted off the JSON.
 */
const deliveredTo = (result: { route: string }): string =>
  result.route === 'foreground' ? 'onMessage' : 'onBackgroundMessage';

/**
 * One assertion set per row, keyed by row id. Each handler drives the mirror so
 * it is red until the mirror exists AND meaningful the moment it does. Rows that
 * cite observations replay the pinned values; the rest are shape/export
 * witnesses at the row's evidence tier.
 */
const assertions: Record<string, () => Promise<void> | void> = {
  // ── firebase/messaging (client) ───────────────────────────────────────────
  'messaging#1': async () => {
    // getMessaging(app?) returns the FCM client instance bound to component `messaging`.
    const m = await loadClient();
    expect(typeof m.getMessaging).toBe('function');
  },

  'messaging#2': async () => {
    // getToken: minted token shape + per-registration stability (both cited).
    const shape = obs('messaging-web-token-shape');
    const stability = obs('messaging-web-token-stability');
    const m = await loadClient();
    const token: string = await m.getToken(m.getMessaging(), {
      vapidKey: 'test-vapid-key',
      serviceWorkerRegistration: m.sandbox?.registration?.(),
    });
    expect(typeof token).toBe('string');
    expect(token.length).toBe(shape.length); // prod: 142
    expect(token.includes(':')).toBe(shape.colonSeparated);
    expect(token.split(':')[1]?.startsWith('APA91b')).toBe(shape.suffixAfterColonStartsWithAPA91b);
    expect(/^[A-Za-z0-9_:-]+$/.test(token)).toBe(shape.urlSafe);
    // Stability: a second getToken on the same registration returns the same token.
    const token2: string = await m.getToken(m.getMessaging(), { vapidKey: 'test-vapid-key' });
    expect(token2 === token).toBe(stability.tokensEqual);
    expect(token2.length === token.length).toBe(stability.sameLength);
  },

  'messaging#3': async () => {
    // deleteToken resolves truthy; afterwards a send to the now-dead token is
    // answered by the SAME broker with the captured UNREGISTERED envelope and
    // routes NO delivery to either client handler. The full loop is DRIVEN
    // in-process (mint → delete → dead-token send → rejection + silence); the
    // observation's recorded values are the expected side. The admin re-wrap
    // the capture also records (`adminThrowCode`,
    // `messaging/registration-token-not-registered`) is driven by the blocking
    // pyric-admin suite (test/messaging/send.test.ts, minted-then-deleted
    // token), not restated here off the JSON. The capture's TIMING nuance
    // ("eventually") is pinned as environment-dependent and NOT contractual;
    // the broker is deterministic — dead is dead immediately.
    const o = obs('messaging-web-deletetoken-unregistered');
    const m = await loadClient();
    const sw = await loadSw();
    // Dedicated sandbox app: deleting the shared default app's token would
    // bleed into sibling rows that drive the same broker.
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, { projectId: 'messaging-oracle-row3' }, 'msg-oracle-row3');
    const messaging = m.getMessaging(app);
    const token: string = await m.getToken(messaging, { vapidKey: 'test-vapid-key' });
    const ok = await m.deleteToken(messaging);
    expect(Boolean(ok)).toBe(o.deleteTokenResolvedTruthy);
    // Handlers on BOTH routes, registered before the dead-token send.
    const fg: any[] = [];
    const bg: any[] = [];
    m.onMessage(messaging, (p: any) => fg.push(p));
    sw.onBackgroundMessage(sw.getMessaging(app), (p: any) => bg.push(p));
    // Drive the send plane at the dead token on the same broker.
    const broker = getMessagingBroker(sandbox);
    let err: any;
    try {
      broker.send({ token, notification: { title: 't', body: 'b' } });
    } catch (e) {
      err = e;
    }
    expect(err instanceof BrokerSendError).toBe(o.sendPlaneEventuallyUnregistered);
    expect(err.envelope.status).toBe(o.unregisteredHttpStatus);
    expect(err.envelope.error.code).toBe(o.unregisteredErrorCodeTop);
    expect(err.envelope.error.status).toBe(o.unregisteredErrorStatus);
    expect(typeof err.envelope.error.message === 'string' && err.envelope.error.message.length > 0)
      .toBe(o.unregisteredMessagePresent);
    expect((err.envelope.error.details ?? []).map((d: any) => d['@type'])).toEqual([...o.unregisteredDetailTypes]);
    expect(err.errorCode).toBe(o.fcmErrorCode); // the DRIVEN wire code vs the pinned 'UNREGISTERED'
    expect(fg.length === 0 && bg.length === 0).toBe(o.noDeliveryToClient);
  },

  'messaging#4': async () => {
    // onMessage fires on a VISIBLE window client; routing keys on visibility.
    // BOTH routing arms are driven — the same message is delivered once with a
    // visible client and once with none — and the pinned `deliveredTo` values
    // are compared against the routes the broker actually took.
    const fg = obs('messaging-web-onmessage-foreground');
    const routing = obs('messaging-web-visibility-routing');
    const m = await loadClient();
    const sw = await loadSw();
    const received: any[] = [];
    const bgReceived: any[] = [];
    const unsub = m.onMessage(m.getMessaging(), (p: any) => received.push(p));
    const unsubBg = sw.onBackgroundMessage(sw.getMessaging(), (p: any) => bgReceived.push(p));
    expect(typeof unsub).toBe('function');
    const spec = {
      notification: { title: 't', body: 'b' },
      data: { demo: '1', source: 's', tag: 'g' },
    };
    // Arm 1: a visible window client → the foreground handler.
    const visible = await m.sandbox.deliver(m.getMessaging(), { visibilityState: 'visible', ...spec });
    expect(received.length).toBe(1);
    expect(bgReceived.length).toBe(0);
    expect(Object.keys(received[0]).sort()).toEqual([...fg.topLevelKeys].sort());
    expect(deliveredTo(visible)).toBe(routing.visibleClient.deliveredTo);
    // Arm 2: the SAME message with no visible client → the background handler,
    // and the foreground handler does NOT fire again.
    const hidden = await m.sandbox.deliver(m.getMessaging(), { visibilityState: 'hidden', ...spec });
    expect(deliveredTo(hidden)).toBe(routing.noVisibleClient.deliveredTo);
    expect(bgReceived.length).toBe(1);
    expect(received.length).toBe(1);
    // Focus is not an input to the broker at all (the captured rule): with
    // everything else held equal, flipping ONLY visibility flipped the route.
    expect(visible.route === 'foreground' && hidden.route === 'background').toBe(
      routing.routesOnVisibilityNotFocus,
    );
    unsub();
    unsubBg();
  },

  'messaging#5': async () => {
    // isSupported() resolves a boolean (bound to isWindowSupported).
    const m = await loadClient();
    expect(typeof m.isSupported).toBe('function');
    expect(typeof (await m.isSupported())).toBe('boolean');
  },

  'messaging#6': async () => {
    // interface Messaging exposes the bound FirebaseApp as `app`.
    const m = await loadClient();
    const instance = m.getMessaging();
    expect(instance).toHaveProperty('app');
  },

  'messaging#7': async () => {
    // interface GetTokenOptions { vapidKey?; serviceWorkerRegistration? } —
    // driven: getToken accepts the full option bag, and both fields are
    // optional (a bare call also resolves). Deep type shape is closed by the
    // assignability census (resolved decision #5).
    const m = await loadClient();
    const messaging = m.getMessaging();
    const withOptions = await m.getToken(messaging, {
      vapidKey: 'test-vapid-key',
      serviceWorkerRegistration: m.sandbox.registration(),
    });
    expect(typeof withOptions).toBe('string');
    const bare = await m.getToken(messaging);
    expect(typeof bare).toBe('string');
  },

  'messaging#8': async () => {
    // MessagePayload envelope: top-level keys data/from/messageId/notification;
    // from = sender id; messageId present. Every fact is read off the payload
    // the broker actually DELIVERED (foreground and background routes both
    // driven), never off the observation JSON. The `from`/`messageId` facts —
    // formerly asserted straight from `fg.fromEqualsSenderId` /
    // `fg.messageIdPresent` — are now the delivered payload's own `from` and
    // `messageId`, compared against the pinned sender-id shape.
    const fg = obs('messaging-web-onmessage-foreground');
    const bg = obs('messaging-web-onbackgroundmessage');
    const m = await loadClient();
    const sw = await loadSw();
    const received: any[] = [];
    const bgReceived: any[] = [];
    m.onMessage(m.getMessaging(), (p: any) => received.push(p));
    sw.onBackgroundMessage(sw.getMessaging(), (p: any) => bgReceived.push(p));
    const spec = {
      notification: { title: 't', body: 'b' },
      data: { demo: '1', source: 's', tag: 'g' },
    };
    await m.sandbox.deliver(m.getMessaging(), { visibilityState: 'visible', ...spec });
    await m.sandbox.deliver(m.getMessaging(), { visibilityState: 'hidden', ...spec });
    const payload = received[0];
    const bgPayload = bgReceived[0];
    // Foreground delivery: top-level key set matches the foreground capture.
    expect(Object.keys(payload).sort()).toEqual([...fg.topLevelKeys].sort());
    // from = the project sender id (driven payload.from vs the broker's pinned
    // DEFAULT_SENDER_ID); messageId present. `fromEqualsSenderId` /
    // `messageIdPresent` are the capture's recorded truth for these.
    expect(payload.from === DEFAULT_SENDER_ID).toBe(fg.fromEqualsSenderId);
    expect(typeof payload.messageId === 'string' && payload.messageId.length > 0).toBe(fg.messageIdPresent);
    // Background delivery: the delivered payload's own key set matches the
    // background capture, and the two routes carry the identical top-level set.
    expect(Object.keys(bgPayload).sort()).toEqual([...bg.topLevelKeys].sort());
    expect(Object.keys(bgPayload).sort()).toEqual(Object.keys(payload).sort());
    expect(bgPayload.from === DEFAULT_SENDER_ID).toBe(bg.fromEqualsSenderId);
    expect(typeof bgPayload.messageId === 'string' && bgPayload.messageId.length > 0).toBe(bg.messageIdPresent);
  },

  'messaging#9': async () => {
    // NotificationPayload inside a foreground delivery carries title + body.
    // Both the key set and the title-delivered fact are read off the payload
    // the broker delivered (was: `fg.notificationTitleDelivered` off the JSON).
    const fg = obs('messaging-web-onmessage-foreground');
    const m = await loadClient();
    const received: any[] = [];
    m.onMessage(m.getMessaging(), (p: any) => received.push(p));
    await m.sandbox.deliver(m.getMessaging(), {
      visibilityState: 'visible',
      notification: { title: 't', body: 'b' },
      data: { demo: '1' },
    });
    const notification = received[0].notification;
    expect(Object.keys(notification).sort()).toEqual([...fg.notificationKeys].sort());
    expect(typeof notification.title === 'string' && notification.title.length > 0).toBe(fg.notificationTitleDelivered);
  },

  'messaging#10': async () => {
    // interface FcmOptions { link?; analyticsLabel? } — a type-only shape with
    // NO runtime carrier in the sandbox: the broker delivers only
    // data/from/messageId(+notification) and, by capture-faithful design, never
    // carries `fcmOptions` on a delivered payload (the same reason
    // `collapseKey` is omitted). There is nothing for the broker to exhibit, so
    // the row is honestly DOWNGRADED to the shape tier (type-backed) in the
    // registry — deep type conformance for FcmOptions is closed by the tier-2
    // assignability census (resolved decision #5), not a runtime replay. This
    // witness only pins that the row's shape-tier boundary holds: `fcmOptions`
    // does not appear on a delivered payload.
    const m = await loadClient();
    const received: any[] = [];
    m.onMessage(m.getMessaging(), (p: any) => received.push(p));
    await m.sandbox.deliver(m.getMessaging(), {
      visibilityState: 'visible',
      notification: { title: 't', body: 'b' },
      data: { demo: '1' },
    });
    expect('fcmOptions' in received[0]).toBe(false);
  },

  'messaging#11': async () => {
    // NextFn / Observer / Unsubscribe: the callback / observer / teardown types
    // onMessage consumes. Driven, not asserted off `toBeDefined()`: onMessage
    // accepts BOTH the bare-NextFn form and the full-Observer form, delivers to
    // each via the broker, and returns a callable Unsubscribe that stops
    // delivery. Deep type parity with the @firebase/util re-exports is closed
    // by the assignability census (resolved decision #5).
    const m = await loadClient();
    const messaging = m.getMessaging();
    const nextForm: any[] = [];
    const observerForm: any[] = [];
    // NextFn form.
    const unsubNext: () => void = m.onMessage(messaging, (p: any) => nextForm.push(p));
    // Observer form { next, error, complete }.
    const unsubObserver: () => void = m.onMessage(messaging, {
      next: (p: any) => observerForm.push(p),
      error: () => {},
      complete: () => {},
    });
    expect(typeof unsubNext).toBe('function');
    expect(typeof unsubObserver).toBe('function');
    await m.sandbox.deliver(messaging, { visibilityState: 'visible', data: { demo: '1' } });
    expect(nextForm.length).toBe(1);
    expect(observerForm.length).toBe(1); // Observer.next received the same delivery
    // Unsubscribe stops further delivery to that handler only.
    unsubNext();
    await m.sandbox.deliver(messaging, { visibilityState: 'visible', data: { demo: '2' } });
    expect(nextForm.length).toBe(1); // no further delivery after unsubscribe
    expect(observerForm.length).toBe(2); // the still-subscribed observer keeps receiving
    unsubObserver();
  },

  'messaging#12': async () => {
    // const enum ErrorCode is @internal — NOT a public export. The mirror must
    // not leak it, even though its 18 values back thrown FirebaseErrors.
    const m = await loadClient();
    expect(m.ErrorCode).toBeUndefined();
  },

  // ── firebase/messaging/sw (service worker) ────────────────────────────────
  'messaging#13': async () => {
    // getMessaging in a service-worker context (bound to getMessagingInSw).
    const sw = await loadSw();
    expect(typeof sw.getMessaging).toBe('function');
  },

  'messaging#14': async () => {
    // onBackgroundMessage fires when no window client is visible; a DATA-ONLY
    // message fires with no `notification` key; the handler suppresses auto-display.
    const bg = obs('messaging-web-onbackgroundmessage');
    const dataOnly = obs('messaging-web-data-only-background');
    const routing = obs('messaging-web-visibility-routing');
    const sw = await loadSw();
    const received: any[] = [];
    const unsub = sw.onBackgroundMessage(sw.getMessaging(), (p: any) => received.push(p));
    expect(typeof unsub).toBe('function');
    // Notification+data with NO visible client → onBackgroundMessage.
    await sw.sandbox.deliver(sw.getMessaging(), {
      visibilityState: 'hidden',
      notification: { title: 't', body: 'b' },
      data: { demo: '1', source: 's', tag: 'g' },
    });
    expect(Object.keys(received[0]).sort()).toEqual([...bg.topLevelKeys].sort());
    expect(routing.noVisibleClient.deliveredTo).toBe('onBackgroundMessage');
    // Data-only delivery: fires, no notification key.
    const received2: any[] = [];
    sw.onBackgroundMessage(sw.getMessaging(), (p: any) => received2.push(p));
    await sw.sandbox.deliver(sw.getMessaging(), {
      visibilityState: 'hidden',
      data: { demo: '1', source: 's', tag: 'g' },
    });
    expect(received2.length >= 1).toBe(dataOnly.onBackgroundMessageFired);
    expect(Object.keys(received2[0]).sort()).toEqual([...dataOnly.topLevelKeys].sort());
    expect('notification' in received2[0]).toBe(dataOnly.hasNotificationKey);
  },

  'messaging#15': async () => {
    // experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable): void
    const sw = await loadSw();
    expect(typeof sw.experimentalSetDeliveryMetricsExportedToBigQueryEnabled).toBe('function');
  },

  'messaging#16': async () => {
    // isSupported() in sw context (bound to isSwSupported).
    const sw = await loadSw();
    expect(typeof sw.isSupported).toBe('function');
    expect(typeof (await sw.isSupported())).toBe('boolean');
  },

  'messaging#17': async () => {
    // Module boundary + shared type parity: the sw entry exports the background
    // handler/metrics toggle but NOT getToken/deleteToken/onMessage, and the
    // client entry is the mirror image.
    const client = await loadClient();
    const sw = await loadSw();
    // sw HAS these:
    for (const name of ['onBackgroundMessage', 'getMessaging', 'experimentalSetDeliveryMetricsExportedToBigQueryEnabled', 'isSupported']) {
      expect(typeof sw[name]).toBe('function');
    }
    // sw does NOT export the client-only receive/token functions:
    for (const name of ['getToken', 'deleteToken', 'onMessage']) {
      expect(sw[name]).toBeUndefined();
    }
    // client HAS the client-only functions:
    for (const name of ['getToken', 'deleteToken', 'onMessage']) {
      expect(typeof client[name]).toBe('function');
    }
    // client does NOT export the sw-only surface:
    for (const name of ['onBackgroundMessage', 'experimentalSetDeliveryMetricsExportedToBigQueryEnabled']) {
      expect(client[name]).toBeUndefined();
    }
  },
};

describe('oracle conformance (messaging client + sw)', () => {
  const covered: string[] = [];
  for (const rowMeta of clientRows) {
    const handler = assertions[rowMeta.id];
    covered.push(rowMeta.id);
    it(`${rowMeta.id} — ${rowMeta.api}`, async () => {
      if (!handler) throw new Error(`no assertion set authored for row ${rowMeta.id}`);
      await handler();
    });
  }

  // ── completeness: this suite owns EXACTLY the client + sw row partition ──
  it('completeness: covers exactly the messaging client + sw rows (partition gate)', () => {
    const allIds = messagingRows.map((r) => r.id).sort();
    const clientIds = messagingRows.filter((r) => r.surface === 'messaging').map((r) => r.id).sort();
    const adminIds = messagingRows.filter((r) => r.surface === 'messaging-admin').map((r) => r.id).sort();

    // Every client/sw row got exactly one assertion set here.
    expect([...covered].sort()).toEqual(clientIds);
    // Every client/sw row has an authored handler.
    expect(clientIds.filter((id) => !(id in assertions))).toEqual([]);
    // Partition: client and admin surfaces are disjoint and exhaustive.
    expect(clientIds.filter((id) => adminIds.includes(id))).toEqual([]);
    expect([...clientIds, ...adminIds].sort()).toEqual(allIds);
    // No stray surface leaked into the registry file.
    const surfaces = new Set(messagingRows.map((r) => r.surface));
    expect([...surfaces].sort()).toEqual(['messaging', 'messaging-admin']);
  });
});
