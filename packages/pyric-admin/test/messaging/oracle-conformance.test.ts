/**
 * Oracle conformance — messaging ADMIN send plane (surface `messaging-admin`,
 * the `pyric-admin` package). This is the RED conformance suite derived under
 * Conformance Driven Development (CDD; see `docs/conformance/cdd.md`, Step 3),
 * authored BEFORE any mirror implementation exists.
 *
 * ─── FLAG GATE ────────────────────────────────────────────────────────────────
 * The whole suite body is skipped unless `PYRIC_CLIMB=1` is set. This keeps the
 * BLOCKING test run green:
 *
 *     bun test --cwd packages/pyric-admin          # green — placeholder only
 *     PYRIC_CLIMB=1 bun test --cwd packages/pyric-admin \
 *       test/messaging/oracle-conformance.test.ts   # RED (by design)
 *
 * Why RED is correct: the surface has no mirror yet, so the assertion sets below
 * import `pyric-admin/messaging` — a subpath that DOES NOT EXIST — and every one
 * fails at the import. Red at birth via import failure is the point (CDD Step 3:
 * "The suite is the surface's definition of done, written before the work.").
 * When PYRIC_CLIMB is unset, the else branch below is never registered, so no
 * unresolved import is ever attempted and the file is green.
 *
 * ─── HOW EACH ASSERTION SET IS SHAPED ─────────────────────────────────────────
 * Rows are read DIRECTLY from `scripts/compat/registry/messaging.ts`
 * (`messagingRows`), filtered to `messaging-admin`. There is exactly one
 * `it(row.id …)` per row. Where a row cites committed `messaging-send-*`
 * observations, the observation JSON is loaded and its recorded values (the
 * exact google.rpc error envelopes, the resource-name shapes, the documented
 * 4096-byte cap) are the EXPECTED side, never re-derived by hand (CDD Step 3),
 * driven against the (future) mirror's `send`. Rows with no observation are
 * shape/export witnesses at documentation strength; deep type conformance is
 * closed by the tier-2 assignability census (CDD resolved decision #5).
 *
 * The completeness test at the bottom enforces this suite's half of the row
 * partition: it owns EXACTLY the `messaging-admin` rows, the client/sw suite in
 * `packages/pyric` owns the rest, the two are disjoint, and together they cover
 * every row in the registry file.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messagingRows } from '../../../../scripts/compat/registry/messaging.ts';

const CLIMB = process.env.PYRIC_CLIMB === '1';

/** Repo-root observations directory (four levels up from this test file). */
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

/** Load the frozen `behavior` block of a committed observation by name. */
function obs(name: string): Record<string, any> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, any>;
  };
  return json.behavior;
}

/** The FCM resource name shape returned by an accepted send / dryRun. */
const RESOURCE_NAME = /^projects\/[^/]+\/messages\/\d+$/;

/** Pull the `google.firebase.fcm.v1.FcmError` errorCode out of an envelope. */
function fcmErrorCode(envelope: Record<string, any>): string | undefined {
  const details: any[] = envelope.error?.details ?? [];
  return details.find((d) => typeof d['@type'] === 'string' && d['@type'].endsWith('FcmError'))?.errorCode;
}

/** Pull the `google.rpc.BadRequest` fieldViolation field names out of an envelope. */
function fieldViolationFields(envelope: Record<string, any>): string[] {
  const details: any[] = envelope.error?.details ?? [];
  const badRequest = details.find((d) => typeof d['@type'] === 'string' && d['@type'].endsWith('BadRequest'));
  return (badRequest?.fieldViolations ?? []).map((f: any) => f.field);
}

/**
 * The not-yet-existent admin mirror. Importing it REJECTS today; that rejection
 * is the suite's red. Typed `any` because the surface has no types yet.
 */
let adminMirror: Promise<any> | null = null;
const loadAdmin = (): Promise<any> => (adminMirror ??= import('pyric-admin/messaging'));

/** A `Messaging` instance from the mirror's default sandbox admin app. */
async function messaging(): Promise<any> {
  const m = await loadAdmin();
  return m.getMessaging();
}

/** Assert a message is accepted: real send + dryRun both return the resource name shape. */
async function expectAccepted(message: Record<string, any>): Promise<void> {
  const svc = await messaging();
  const name: string = await svc.send(message);
  expect(RESOURCE_NAME.test(name)).toBe(true);
  const dry: string = await svc.send(message, true);
  expect(RESOURCE_NAME.test(dry)).toBe(true); // dryRun returns the SAME shape (fake id)
}

/** Assert a malformed message is rejected with the admin-wrapped INVALID_ARGUMENT code. */
async function expectRejectedInvalidArgument(message: Record<string, any>): Promise<any> {
  const svc = await messaging();
  let err: any;
  try {
    await svc.send(message);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  // wire FcmError INVALID_ARGUMENT → MessagingClientErrorCode.INVALID_ARGUMENT
  // → admin code messaging/invalid-argument (row messaging-admin#39).
  expect(err.code).toBe('messaging/invalid-argument');
  return err;
}

/** Assert the pinned production error envelope's stable, contractual invariants. */
function assertEnvelope(o: Record<string, any>, expectedFcmCode = 'INVALID_ARGUMENT'): void {
  expect(o.status ?? o.error?.code).toBe(400);
  expect(o.error.code).toBe(400);
  expect(o.error.status).toBe('INVALID_ARGUMENT');
  if ((o.error.details ?? []).some((d: any) => d['@type']?.endsWith('FcmError'))) {
    expect(fcmErrorCode(o)).toBe(expectedFcmCode);
  }
}

/** The rows this package owns: the admin send plane. */
const adminRows = messagingRows.filter((r) => r.surface === 'messaging-admin');

/** One assertion set per row, keyed by row id. */
const assertions: Record<string, () => Promise<void> | void> = {
  // ── entry + Messaging class ───────────────────────────────────────────────
  'messaging-admin#1': async () => {
    const m = await loadAdmin();
    expect(typeof m.getMessaging).toBe('function');
  },
  'messaging-admin#2': async () => {
    // Namespaced/legacy accessor equivalent of getMessaging.
    const m = await loadAdmin();
    expect(typeof m.messaging).toBe('function');
  },
  'messaging-admin#3': async () => {
    // Messaging.app is the admin App the instance is bound to.
    const svc = await messaging();
    expect(svc).toHaveProperty('app');
  },

  'messaging-admin#4': async () => {
    // send(message, dryRun?) — the send-plane contract, cited by 10 observations.
    // Accept paths: topic / condition / notification-only / data-only / webpush.
    await expectAccepted({ topic: 'oracle-topic', notification: { title: 't', body: 'b' } });
    await expectAccepted({ condition: "'a' in topics && 'b' in topics", data: { k: 'v' } });
    await expectAccepted({ topic: 'oracle-topic', notification: { title: 't' } }); // notification-only
    await expectAccepted({ topic: 'oracle-topic', data: { k: 'v' } }); // data-only
    await expectAccepted({
      topic: 'oracle-topic',
      webpush: { headers: { TTL: '3600' }, fcmOptions: { link: 'https://example.com/oracle' } },
    });
    // dryRun shape parity is pinned by every accept observation.
    for (const name of [
      'messaging-send-topic-accepted',
      'messaging-send-condition-accepted',
      'messaging-send-webpush-config-accepted',
    ]) {
      expect(obs(name).dryRunSameShapeAsReal).toBe(true);
    }
    expect(obs('messaging-send-notification-only-vs-data-only-accepted').bothAccepted).toBe(true);

    // Error envelopes: assert each pinned production envelope's invariants, then
    // drive the mirror to reject with the wrapped admin code.
    const noTarget = obs('messaging-send-no-target-error-envelope');
    assertEnvelope(noTarget);
    expect(fieldViolationFields(noTarget)).toContain('message');
    await expectRejectedInvalidArgument({} as Record<string, any>); // no recipient

    for (const name of [
      'messaging-send-invalid-token-error-envelope',
      'messaging-send-invalid-condition-error-envelope',
      'messaging-send-invalid-topic-name-error-envelope',
      'messaging-send-oversized-payload-error-envelope',
      'messaging-send-webpush-invalid-ttl-error-envelope',
    ]) {
      assertEnvelope(obs(name));
    }
    // Documented data cap.
    expect(obs('messaging-send-oversized-payload-error-envelope').documentedCapBytes).toBe(4096);
  },

  'messaging-admin#5': async () => {
    const m = await loadAdmin();
    expect(typeof m.getMessaging().sendEach).toBe('function');
  },
  'messaging-admin#6': async () => {
    const m = await loadAdmin();
    expect(typeof m.getMessaging().sendEachForMulticast).toBe('function');
  },
  'messaging-admin#7': async () => {
    const m = await loadAdmin();
    expect(typeof m.getMessaging().subscribeToTopic).toBe('function');
  },
  'messaging-admin#8': async () => {
    const m = await loadAdmin();
    expect(typeof m.getMessaging().unsubscribeFromTopic).toBe('function');
  },
  'messaging-admin#9': async () => {
    const m = await loadAdmin();
    expect(typeof m.getMessaging().enableLegacyHttpTransport).toBe('function');
  },

  // ── Message union + targets ───────────────────────────────────────────────
  'messaging-admin#10': async () => {
    // type Message = TokenMessage | TopicMessage | ConditionMessage — type-only;
    // touch the mirror so this is red at birth (deep type conformance is closed
    // by the assignability census, resolved decision #5).
    expect(await loadAdmin()).toBeDefined();
  },
  'messaging-admin#11': async () => {
    // BaseMessage: neither data nor notification is individually required.
    const o = obs('messaging-send-notification-only-vs-data-only-accepted');
    expect(o.bothAccepted).toBe(true);
    await expectAccepted({ topic: 'oracle-topic', notification: { title: 't' } });
    await expectAccepted({ topic: 'oracle-topic', data: { k: 'v' } });
  },
  'messaging-admin#12': async () => {
    // TokenMessage: an invalid token is rejected; fieldViolations names message.token.
    const o = obs('messaging-send-invalid-token-error-envelope');
    assertEnvelope(o);
    expect(fieldViolationFields(o)).toContain('message.token');
    await expectRejectedInvalidArgument({ token: 'not-a-valid-fcm-token' });
  },
  'messaging-admin#13': async () => {
    // TopicMessage: well-formed accepted; invalid characters rejected.
    expect(obs('messaging-send-topic-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({ topic: 'oracle-topic', notification: { title: 't' } });
    const bad = obs('messaging-send-invalid-topic-name-error-envelope');
    assertEnvelope(bad);
    await expectRejectedInvalidArgument({ topic: 'bad#topic!name', notification: { title: 't' } });
  },
  'messaging-admin#14': async () => {
    // ConditionMessage: well-formed accepted; dangling operator rejected.
    expect(obs('messaging-send-condition-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({ condition: "'a' in topics && 'b' in topics", data: { k: 'v' } });
    const bad = obs('messaging-send-invalid-condition-error-envelope');
    assertEnvelope(bad);
    await expectRejectedInvalidArgument({ condition: "'a' in topics &&", data: { k: 'v' } });
  },
  'messaging-admin#15': async () => {
    // MulticastMessage { tokens: string[] } — type-only.
    expect(await loadAdmin()).toBeDefined();
  },

  // ── payload / config option shapes ────────────────────────────────────────
  'messaging-admin#16': async () => {
    // Notification block: a notification-only message is accepted.
    expect(obs('messaging-send-notification-only-vs-data-only-accepted').notificationOnly.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({ topic: 'oracle-topic', notification: { title: 't', body: 'b', imageUrl: 'https://example.com/i.png' } });
  },
  'messaging-admin#17': async () => {
    // FcmOptions { analyticsLabel? } — type-only.
    expect(await loadAdmin()).toBeDefined();
  },
  'messaging-admin#18': async () => {
    // WebpushConfig: headers.TTL + fcmOptions.link accepted; non-numeric TTL rejected.
    expect(obs('messaging-send-webpush-config-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({
      topic: 'oracle-topic',
      webpush: { headers: { TTL: '3600' }, fcmOptions: { link: 'https://example.com/oracle' } },
    });
    const bad = obs('messaging-send-webpush-invalid-ttl-error-envelope');
    assertEnvelope(bad);
    expect(fieldViolationFields(bad)).toContain('message.webpush.headers.TTL');
    await expectRejectedInvalidArgument({ topic: 'oracle-topic', webpush: { headers: { TTL: 'not-a-number' } } });
  },
  'messaging-admin#19': async () => {
    // WebpushFcmOptions { link? } — link accepted on a webpush send.
    expect(obs('messaging-send-webpush-config-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({ topic: 'oracle-topic', webpush: { fcmOptions: { link: 'https://example.com/oracle' } } });
  },
  // Type-only config / legacy / response shapes — no runtime behavior to replay;
  // each touches the mirror so it is red at birth, and deep type conformance is
  // closed by the assignability census (resolved decision #5).
  'messaging-admin#20': async () => { expect(await loadAdmin()).toBeDefined(); }, // WebpushNotification
  'messaging-admin#21': async () => { expect(await loadAdmin()).toBeDefined(); }, // ApnsConfig
  'messaging-admin#22': async () => { expect(await loadAdmin()).toBeDefined(); }, // ApnsPayload
  'messaging-admin#23': async () => { expect(await loadAdmin()).toBeDefined(); }, // Aps
  'messaging-admin#24': async () => { expect(await loadAdmin()).toBeDefined(); }, // ApsAlert
  'messaging-admin#25': async () => { expect(await loadAdmin()).toBeDefined(); }, // CriticalSound
  'messaging-admin#26': async () => { expect(await loadAdmin()).toBeDefined(); }, // ApnsFcmOptions
  'messaging-admin#27': async () => { expect(await loadAdmin()).toBeDefined(); }, // AndroidConfig
  'messaging-admin#28': async () => { expect(await loadAdmin()).toBeDefined(); }, // AndroidNotification
  'messaging-admin#29': async () => { expect(await loadAdmin()).toBeDefined(); }, // LightSettings
  'messaging-admin#30': async () => { expect(await loadAdmin()).toBeDefined(); }, // AndroidFcmOptions

  // ── legacy payload shapes ─────────────────────────────────────────────────
  'messaging-admin#31': async () => { expect(await loadAdmin()).toBeDefined(); }, // DataMessagePayload
  'messaging-admin#32': async () => { expect(await loadAdmin()).toBeDefined(); }, // NotificationMessagePayload
  'messaging-admin#33': async () => { expect(await loadAdmin()).toBeDefined(); }, // MessagingPayload
  'messaging-admin#34': async () => { expect(await loadAdmin()).toBeDefined(); }, // MessagingOptions

  // ── response shapes ───────────────────────────────────────────────────────
  'messaging-admin#35': async () => { expect(await loadAdmin()).toBeDefined(); }, // MessagingTopicManagementResponse
  'messaging-admin#36': async () => { expect(await loadAdmin()).toBeDefined(); }, // BatchResponse
  'messaging-admin#37': async () => { expect(await loadAdmin()).toBeDefined(); }, // SendResponse

  // ── errors ────────────────────────────────────────────────────────────────
  'messaging-admin#38': async () => {
    // FirebaseMessagingError is the exported admin messaging error class.
    const m = await loadAdmin();
    expect(typeof m.FirebaseMessagingError).toBe('function');
  },
  'messaging-admin#39': async () => {
    // MessagingClientErrorCode exports static { code, message } members; the wire
    // INVALID_ARGUMENT FcmError maps to MessagingClientErrorCode.INVALID_ARGUMENT.
    const noTarget = obs('messaging-send-no-target-error-envelope');
    const invalidToken = obs('messaging-send-invalid-token-error-envelope');
    expect(fcmErrorCode(noTarget)).toBe('INVALID_ARGUMENT');
    expect(fcmErrorCode(invalidToken)).toBe('INVALID_ARGUMENT');
    const m = await loadAdmin();
    expect(typeof m.MessagingClientErrorCode).toBe('function');
    expect(m.MessagingClientErrorCode.INVALID_ARGUMENT.code).toContain('invalid-argument');
  },
};

if (!CLIMB) {
  // Flag off: register a single passing placeholder so the blocking run
  // (`bun test --cwd packages/pyric-admin`) stays green and never touches the
  // not-yet-existent mirror. See the FLAG GATE note at the top of this file.
  describe('oracle conformance (messaging-admin send plane) — climb-gated', () => {
    it('skipped unless PYRIC_CLIMB=1 (blocking run stays green)', () => {
      expect(CLIMB).toBe(false);
    });
  });
} else {
  describe('oracle conformance (messaging-admin send plane)', () => {
    const covered: string[] = [];
    for (const rowMeta of adminRows) {
      const handler = assertions[rowMeta.id];
      covered.push(rowMeta.id);
      it(`${rowMeta.id} — ${rowMeta.api}`, async () => {
        if (!handler) throw new Error(`no assertion set authored for row ${rowMeta.id}`);
        await handler();
      });
    }

    // ── completeness: this suite owns EXACTLY the messaging-admin partition ──
    it('completeness: covers exactly the messaging-admin rows (partition gate)', () => {
      const allIds = messagingRows.map((r) => r.id).sort();
      const clientIds = messagingRows.filter((r) => r.surface === 'messaging').map((r) => r.id).sort();
      const adminIds = messagingRows.filter((r) => r.surface === 'messaging-admin').map((r) => r.id).sort();

      // Every admin row got exactly one assertion set here.
      expect([...covered].sort()).toEqual(adminIds);
      // Every admin row has an authored handler.
      expect(adminIds.filter((id) => !(id in assertions))).toEqual([]);
      // Partition: admin and client surfaces are disjoint and exhaustive.
      expect(adminIds.filter((id) => clientIds.includes(id))).toEqual([]);
      expect([...clientIds, ...adminIds].sort()).toEqual(allIds);
      // No stray surface leaked into the registry file.
      const surfaces = new Set(messagingRows.map((r) => r.surface));
      expect([...surfaces].sort()).toEqual(['messaging', 'messaging-admin']);
    });
  });
}
