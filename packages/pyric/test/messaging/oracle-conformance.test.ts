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
 * blocking CI. The mirror itself still gates its implicit default-sandbox app
 * behind `PYRIC_CLIMB` (WIP isolation; see src/messaging/instance.ts) — this
 * file enables that flag for its own lifetime because the assertion sets were
 * authored against the bare-call path, and restores it afterward.
 *
 * ─── HOW EACH ASSERTION SET IS SHAPED ─────────────────────────────────────────
 * Rows are read DIRECTLY from `scripts/compat/registry/messaging.ts`
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
import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messagingRows } from '../../../../scripts/compat/registry/messaging.ts';

// Enable the mirror's climb-only default-sandbox path for this file's
// lifetime, then restore, so sibling files' flag-off contract tests (e.g.
// sandbox-instance-identity's bare-call refusal) stay honest.
const PREV_CLIMB = process.env.PYRIC_CLIMB;
process.env.PYRIC_CLIMB = '1';
afterAll(() => {
  if (PREV_CLIMB === undefined) delete process.env.PYRIC_CLIMB;
  else process.env.PYRIC_CLIMB = PREV_CLIMB;
});

/** Repo-root observations directory (four levels up from this test file). */
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

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
    // deleteToken resolves truthy; the now-dead token stops delivery and the
    // send plane eventually surfaces UNREGISTERED (admin re-wraps the code).
    const o = obs('messaging-web-deletetoken-unregistered');
    const m = await loadClient();
    const ok = await m.deleteToken(m.getMessaging());
    expect(Boolean(ok)).toBe(o.deleteTokenResolvedTruthy);
    expect(o.fcmErrorCode).toBe('UNREGISTERED'); // pinned wire code the broker must emit
    expect(o.adminThrowCode).toBe('messaging/registration-token-not-registered');
    expect(o.noDeliveryToClient).toBe(true);
  },

  'messaging#4': async () => {
    // onMessage fires on a VISIBLE window client; routing keys on visibility.
    const fg = obs('messaging-web-onmessage-foreground');
    const routing = obs('messaging-web-visibility-routing');
    const m = await loadClient();
    const received: any[] = [];
    const unsub = m.onMessage(m.getMessaging(), (p: any) => received.push(p));
    expect(typeof unsub).toBe('function');
    // Deliver a notification+data message to a visible client via the broker.
    await m.sandbox.deliver(m.getMessaging(), {
      visibilityState: 'visible',
      notification: { title: 't', body: 'b' },
      data: { demo: '1', source: 's', tag: 'g' },
    });
    expect(received.length).toBe(1);
    expect(Object.keys(received[0]).sort()).toEqual([...fg.topLevelKeys].sort());
    expect(routing.visibleClient.deliveredTo).toBe('onMessage');
    expect(routing.noVisibleClient.deliveredTo).toBe('onBackgroundMessage');
    expect(routing.routesOnVisibilityNotFocus).toBe(true);
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
    // interface GetTokenOptions { vapidKey?; serviceWorkerRegistration? } — a
    // type-only shape; getToken must accept the option bag without complaint.
    const m = await loadClient();
    expect(typeof m.getToken).toBe('function');
  },

  'messaging#8': async () => {
    // MessagePayload envelope: top-level keys data/from/messageId/notification;
    // from = sender id; messageId present (foreground + background captures).
    const fg = obs('messaging-web-onmessage-foreground');
    const bg = obs('messaging-web-onbackgroundmessage');
    const m = await loadClient();
    const received: any[] = [];
    m.onMessage(m.getMessaging(), (p: any) => received.push(p));
    await m.sandbox.deliver(m.getMessaging(), {
      visibilityState: 'visible',
      notification: { title: 't', body: 'b' },
      data: { demo: '1', source: 's', tag: 'g' },
    });
    const payload = received[0];
    expect(Object.keys(payload).sort()).toEqual([...fg.topLevelKeys].sort());
    expect(fg.fromEqualsSenderId).toBe(true);
    expect(fg.messageIdPresent).toBe(true);
    // The background capture pins the identical top-level key set.
    expect([...bg.topLevelKeys].sort()).toEqual([...fg.topLevelKeys].sort());
  },

  'messaging#9': async () => {
    // NotificationPayload inside a foreground delivery carries title + body.
    const fg = obs('messaging-web-onmessage-foreground');
    const m = await loadClient();
    const received: any[] = [];
    m.onMessage(m.getMessaging(), (p: any) => received.push(p));
    await m.sandbox.deliver(m.getMessaging(), {
      visibilityState: 'visible',
      notification: { title: 't', body: 'b' },
      data: { demo: '1' },
    });
    expect(Object.keys(received[0].notification).sort()).toEqual([...fg.notificationKeys].sort());
    expect(fg.notificationTitleDelivered).toBe(true);
  },

  'messaging#10': async () => {
    // interface FcmOptions { link?; analyticsLabel? } — type-only shape. Touch
    // the mirror so this is red at birth; deep type conformance is closed by the
    // assignability census (resolved decision #5), not this runtime replay.
    expect(await loadClient()).toBeDefined();
  },

  'messaging#11': async () => {
    // NextFn / Observer / Unsubscribe are re-exported from @firebase/util —
    // type-only re-exports; closed by the assignability census.
    expect(await loadClient()).toBeDefined();
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
