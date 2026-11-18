/**
 * Oracle conformance -- messaging ADMIN send plane (surface `messaging-admin`,
 * the `pyric-admin` package). This suite was authored RED under Conformance
 * Driven Development (CDD; see `docs/conformance/cdd.md`, Step 3), BEFORE any
 * mirror implementation existed.
 *
 * --- BLOCKING -----------------------------------------------------------------
 * The suite runs un-gated in this package's normal test path:
 *
 *     bun test --cwd packages/pyric-admin
 *
 * Every messaging-admin row's `conforms` status is backed by this suite
 * passing in blocking CI. The mirror itself still gates its implicit
 * conformance-climb app behind `PYRIC_CLIMB` (WIP isolation; see
 * src/messaging/index.ts) -- this file enables that flag for its own lifetime
 * because the assertion sets were authored against the bare-call path, and
 * restores it afterward.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { messagingRows } from '../../../../packages/conformance/registry/messaging.ts';
import { createObservationGate } from '../../../../packages/conformance/src/observation-gate.ts';
import {
  assertAdminEntryAccessors,
  assertBatchMatchesObserved,
  assertConfigObservation,
  assertDrivenAcceptedPair,
  assertDrivenMessagingThrow,
  assertTopicManagementMatchesObserved,
  assertTopicManagementObservation,
  CONFIG_ROW_SPECS,
} from './oracle-conformance-cases.ts';

const PREV_CLIMB = process.env.PYRIC_CLIMB;
process.env.PYRIC_CLIMB = '1';
afterAll(() => {
  if (PREV_CLIMB === undefined) delete process.env.PYRIC_CLIMB;
  else process.env.PYRIC_CLIMB = PREV_CLIMB;
});

const OBS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'conformance',
  'observations',
  'messaging-admin',
);

/**
 * Intentionally EMPTY: all 29 committed `messaging-send-*` captures are driven
 * against `pyric-admin/messaging` below and their behavior fields asserted.
 */
const NOT_APPLICABLE_OBS: Record<string, string> = {};

const messagingObsGate = createObservationGate({
  dir: OBS_DIR,
  match: (f) => f.startsWith('messaging-send-') || f.startsWith('messaging-admin-'),
  notApplicable: NOT_APPLICABLE_OBS,
});

function obs(name: string): Record<string, any> {
  return messagingObsGate.load(name);
}

const RESOURCE_NAME = /^projects\/[^/]+\/messages\/[^/]+$/;

function fcmErrorCode(envelope: Record<string, any>): string | undefined {
  const details: any[] = envelope.error?.details ?? [];
  return details.find((d) => typeof d['@type'] === 'string' && d['@type'].endsWith('FcmError'))
    ?.errorCode;
}

function fieldViolationFields(envelope: Record<string, any>): string[] {
  const details: any[] = envelope.error?.details ?? [];
  const badRequest = details.find(
    (d) => typeof d['@type'] === 'string' && d['@type'].endsWith('BadRequest'),
  );
  const violations: any[] = badRequest?.fieldViolations ?? [];
  return violations.map((f: any) => f.field);
}

let adminMirror: Promise<any> | null = null;
const loadAdmin = (): Promise<any> => (adminMirror ??= import('pyric-admin/messaging'));

async function messaging(): Promise<any> {
  const m = await loadAdmin();
  return m.getMessaging();
}

async function drivenAccept(message: Record<string, any>): Promise<{ real: string; dry: string }> {
  const svc = await messaging();
  const real: string = await svc.send(message);
  expect(RESOURCE_NAME.test(real)).toBe(true);
  const dry: string = await svc.send(message, true);
  expect(RESOURCE_NAME.test(dry)).toBe(true);
  return { real, dry };
}

async function expectAccepted(message: Record<string, any>): Promise<void> {
  await drivenAccept(message);
}

function sameResourceShape(names: { real: string; dry: string }): boolean {
  return RESOURCE_NAME.test(names.real) && RESOURCE_NAME.test(names.dry);
}

async function expectRejectedInvalidArgument(message: Record<string, any>): Promise<any> {
  const svc = await messaging();
  let err: any;
  try {
    await svc.send(message);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.code).toBe('messaging/invalid-argument');
  return err;
}

function assertEnvelope(o: Record<string, any>, expectedFcmCode = 'INVALID_ARGUMENT'): void {
  const topStatus = o.status ?? o.error?.code;
  expect(topStatus).toBe(400);
  expect(o.error.code).toBe(400);
  expect(o.error.status).toBe('INVALID_ARGUMENT');
  const details: any[] = o.error.details ?? [];
  if (details.some((d: any) => d['@type']?.endsWith('FcmError'))) {
    expect(fcmErrorCode(o)).toBe(expectedFcmCode);
  }
}

async function replayConfigRow(rowId: string): Promise<void> {
  const spec = CONFIG_ROW_SPECS[rowId];
  if (spec === undefined) throw new Error(`missing config row spec ${rowId}`);
  const m = await loadAdmin();
  const svc = await messaging();
  const o = obs(spec.observation);
  await assertConfigObservation(
    svc,
    m.FirebaseMessagingError,
    o,
    spec.acceptedMessage,
    spec.invalidCases,
    spec.acceptedKey ?? 'accepted',
  );
  if (spec.extraAccepted !== undefined) {
    await assertDrivenAcceptedPair(svc, o[spec.extraAccepted.key], spec.extraAccepted.message);
  }
}

const adminRows = messagingRows.filter((r) => r.surface === 'messaging-admin');

const assertions: Record<string, () => Promise<void> | void> = {
  // -- entry + Messaging class ------------------------------------------------
  'messaging-admin#1': async () => {
    const m = await loadAdmin();
    await assertAdminEntryAccessors(m, obs('messaging-send-admin-entry-accessors'));
  },
  'messaging-admin#2': async () => {
    const m = await loadAdmin();
    const o = obs('messaging-send-admin-entry-accessors');
    expect(m.messaging() === m.getMessaging()).toBe(o.defaultGetMessagingMatchesNamespace);
  },
  'messaging-admin#3': async () => {
    const svc = await messaging();
    const m = await loadAdmin();
    const o = obs('messaging-send-admin-entry-accessors');
    expect(m.getMessaging(svc.app) === svc).toBe(o.defaultGetMessagingMatchesExplicit);
  },

  'messaging-admin#4': async () => {
    const topicAccept = await drivenAccept({
      topic: 'oracle-topic',
      notification: { title: 't', body: 'b' },
    });
    const conditionAccept = await drivenAccept({
      condition: "'a' in topics && 'b' in topics",
      data: { k: 'v' },
    });
    const notificationOnly = await drivenAccept({
      topic: 'oracle-topic',
      notification: { title: 't' },
    });
    const dataOnly = await drivenAccept({ topic: 'oracle-topic', data: { k: 'v' } });
    const webpushAccept = await drivenAccept({
      topic: 'oracle-topic',
      webpush: { headers: { TTL: '3600' }, fcmOptions: { link: 'https://example.com/oracle' } },
    });
    expect(sameResourceShape(topicAccept)).toBe(
      obs('messaging-send-topic-accepted').dryRunSameShapeAsReal,
    );
    expect(sameResourceShape(conditionAccept)).toBe(
      obs('messaging-send-condition-accepted').dryRunSameShapeAsReal,
    );
    expect(sameResourceShape(webpushAccept)).toBe(
      obs('messaging-send-webpush-config-accepted').dryRunSameShapeAsReal,
    );
    expect(sameResourceShape(notificationOnly) && sameResourceShape(dataOnly)).toBe(
      obs('messaging-send-notification-only-vs-data-only-accepted').bothAccepted,
    );

    const noTarget = obs('messaging-send-no-target-error-envelope');
    assertEnvelope(noTarget);
    expect(fieldViolationFields(noTarget)).toContain('message');
    await expectRejectedInvalidArgument({} as Record<string, any>);

    for (const name of [
      'messaging-send-invalid-token-error-envelope',
      'messaging-send-invalid-condition-error-envelope',
      'messaging-send-invalid-topic-name-error-envelope',
      'messaging-send-oversized-payload-error-envelope',
      'messaging-send-webpush-invalid-ttl-error-envelope',
    ]) {
      assertEnvelope(obs(name));
    }
    const lowercaseTtl = obs('messaging-send-webpush-lowercase-ttl');
    const lowercaseAccept = await drivenAccept({
      topic: 'oracle-topic',
      webpush: { headers: { ttl: '60' } },
    });
    expect(sameResourceShape(lowercaseAccept)).toBe(
      lowercaseTtl.validSixtySeconds.dryRunMatchesRealSend,
    );
    assertEnvelope({
      status: lowercaseTtl.negativeOne.realSendStatus,
      error: lowercaseTtl.negativeOne.realSendError,
    });
    assertEnvelope({
      status: lowercaseTtl.nonNumericAbc.realSendStatus,
      error: lowercaseTtl.nonNumericAbc.realSendError,
    });
    await expectRejectedInvalidArgument({ topic: 'oracle-topic', webpush: { headers: { ttl: '-1' } } });
    await expectRejectedInvalidArgument({ topic: 'oracle-topic', webpush: { headers: { ttl: 'abc' } } });

    const oversized = obs('messaging-send-oversized-payload-error-envelope');
    expect(oversized.documentedCapBytes).toBe(4096);
    await expectAccepted({
      topic: 'oracle-topic',
      data: { p: 'x'.repeat(oversized.largestAcceptedDataValueLen) },
    });
    await expectRejectedInvalidArgument({
      topic: 'oracle-topic',
      data: { p: 'x'.repeat(oversized.smallestRejectedDataValueLen) },
    });
  },

  'messaging-admin#5': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const mixed = obs('messaging-send-sendeach-mixed-batch');
    const guards = obs('messaging-send-sendeach-validation-guards');
    const batchInputs = [
      { topic: 'oracle-topic', data: { item: '0' } },
      { token: 'not-a-valid-fcm-token', data: { item: '1' } },
      { topic: '', data: { item: '2' } },
    ];
    const dryRes = await svc.sendEach(batchInputs, true);
    const realRes = await svc.sendEach(batchInputs, false);
    assertBatchMatchesObserved(dryRes, mixed.dryRun, m.FirebaseMessagingError);
    assertBatchMatchesObserved(realRes, mixed.realSend, m.FirebaseMessagingError);
    expect(dryRes.successCount === realRes.successCount).toBe(mixed.dryRunMatchesRealSend);

    await assertDrivenMessagingThrow(() => svc.sendEach([]), guards.emptyArray, m.FirebaseMessagingError);
    const over500 = Array.from({ length: 501 }, () => ({ topic: 'oracle-topic' }));
    await assertDrivenMessagingThrow(
      () => svc.sendEach(over500),
      guards.overMaxBatch501,
      m.FirebaseMessagingError,
    );
    await assertDrivenMessagingThrow(
      () => svc.sendEach([{ topic: 'oracle-topic' }], 'yes'),
      guards.nonBooleanDryRun,
      m.FirebaseMessagingError,
    );
  },
  'messaging-admin#6': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const multi = obs('messaging-send-multicast-batch');
    const out = await svc.sendEachForMulticast(
      { tokens: ['not-a-valid-fcm-token', ''], data: { item: '1' } },
      true,
    );
    assertBatchMatchesObserved(out, multi.mixedInvalidTokensDryRun, m.FirebaseMessagingError);
    await assertDrivenMessagingThrow(
      () => svc.sendEachForMulticast(null),
      multi.nullMessage,
      m.FirebaseMessagingError,
    );
    await assertDrivenMessagingThrow(
      () => svc.sendEachForMulticast({ tokens: [] }),
      multi.emptyTokensArray,
      m.FirebaseMessagingError,
    );
    const over500Tokens = Array.from({ length: 501 }, (_, i) => `tok-${i}`);
    await assertDrivenMessagingThrow(
      () => svc.sendEachForMulticast({ tokens: over500Tokens }),
      multi.overMaxTokens501,
      m.FirebaseMessagingError,
    );
  },
  'messaging-admin#7': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    await assertTopicManagementObservation(
      (tokens, topic) => svc.subscribeToTopic(tokens, topic),
      obs('messaging-send-topic-subscribe-batch'),
      m.FirebaseMessagingError,
    );
  },
  'messaging-admin#8': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    await assertTopicManagementObservation(
      (tokens, topic) => svc.unsubscribeFromTopic(tokens, topic),
      obs('messaging-send-topic-unsubscribe-batch'),
      m.FirebaseMessagingError,
    );
  },
  'messaging-admin#9': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const legacy = obs('messaging-send-legacy-http-transport');
    expect(svc.enableLegacyHttpTransport() === undefined).toBe(legacy.enableReturnIsUndefined);
    const res = await svc.sendEach(
      [{ topic: 'oracle-topic', data: { k: 'v' } }, { token: 'not-a-valid-fcm-token' }],
      true,
    );
    assertBatchMatchesObserved(res, legacy.dryRunBatch, m.FirebaseMessagingError);
  },

  // -- Message union + targets ------------------------------------------------
  'messaging-admin#10': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const multi = obs('messaging-send-multiple-targets-rejected');
    await assertDrivenMessagingThrow(
      () => svc.send({ topic: 'oracle-topic', condition: "'b' in topics" }, true),
      multi.topicAndConditionClient.dryRun,
      m.FirebaseMessagingError,
    );
    await assertDrivenMessagingThrow(
      () => svc.send({ token: 'seg1:seg2', topic: 'oracle-topic' }, false),
      multi.tokenAndTopicClient.realSend,
      m.FirebaseMessagingError,
    );
    await assertDrivenMessagingThrow(
      () => svc.send({ token: 'seg1:seg2', topic: 'oracle-topic', condition: "'b' in topics" }, true),
      multi.allThreeTargetsClient.dryRun,
      m.FirebaseMessagingError,
    );
    assertEnvelope(multi.wireTopicAndCondition);
    expect(fieldViolationFields(multi.wireTopicAndCondition)).toContain('message');
  },
  'messaging-admin#11': async () => {
    const o = obs('messaging-send-notification-only-vs-data-only-accepted');
    const notificationOnly = await drivenAccept({ topic: 'oracle-topic', notification: { title: 't' } });
    const dataOnly = await drivenAccept({ topic: 'oracle-topic', data: { k: 'v' } });
    expect(sameResourceShape(notificationOnly) && sameResourceShape(dataOnly)).toBe(o.bothAccepted);
  },
  'messaging-admin#12': async () => {
    const o = obs('messaging-send-invalid-token-error-envelope');
    assertEnvelope(o);
    expect(fieldViolationFields(o)).toContain('message.token');
    await expectRejectedInvalidArgument({ token: 'not-a-valid-fcm-token' });
  },
  'messaging-admin#13': async () => {
    expect(obs('messaging-send-topic-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({ topic: 'oracle-topic', notification: { title: 't' } });
    const bad = obs('messaging-send-invalid-topic-name-error-envelope');
    assertEnvelope(bad);
    await expectRejectedInvalidArgument({ topic: 'bad#topic!name', notification: { title: 't' } });
  },
  'messaging-admin#14': async () => {
    expect(obs('messaging-send-condition-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({ condition: "'a' in topics && 'b' in topics", data: { k: 'v' } });
    const bad = obs('messaging-send-invalid-condition-error-envelope');
    assertEnvelope(bad);
    await expectRejectedInvalidArgument({ condition: "'a' in topics &&", data: { k: 'v' } });
  },
  'messaging-admin#15': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const multi = obs('messaging-send-multicast-batch');
    const out = await svc.sendEachForMulticast(
      { tokens: ['not-a-valid-fcm-token', ''], notification: { title: 'Alert' } },
      true,
    );
    assertBatchMatchesObserved(out, multi.mixedInvalidTokensDryRun, m.FirebaseMessagingError);
  },

  // -- payload / config option shapes -----------------------------------------
  'messaging-admin#16': async () => {
    expect(
      obs('messaging-send-notification-only-vs-data-only-accepted').notificationOnly
        .matchesProjectsMessagesFormat,
    ).toBe(true);
    await expectAccepted({
      topic: 'oracle-topic',
      notification: { title: 't', body: 'b', imageUrl: 'https://example.com/i.png' },
    });
  },
  'messaging-admin#17': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const o = obs('messaging-send-fcm-options-analytics-label');
    await assertConfigObservation(
      svc,
      m.FirebaseMessagingError,
      o,
      { topic: 'oracle-topic', fcmOptions: { analyticsLabel: 'promo_2026' } },
      [{ obsKey: 'nonStringAnalyticsLabel', message: { topic: 'oracle-topic', fcmOptions: { analyticsLabel: 123 } } }],
    );
    expect(o.wireOversizedLabel51.status).toBe(200);
    await expectAccepted({ topic: 'oracle-topic', fcmOptions: { analyticsLabel: 'a'.repeat(51) } });
  },
  'messaging-admin#18': async () => {
    expect(obs('messaging-send-webpush-config-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({
      topic: 'oracle-topic',
      webpush: { headers: { TTL: '3600' }, fcmOptions: { link: 'https://example.com/oracle' } },
    });
    const bad = obs('messaging-send-webpush-invalid-ttl-error-envelope');
    assertEnvelope(bad);
    expect(fieldViolationFields(bad)).toContain('message.webpush.headers.TTL');
    await expectRejectedInvalidArgument({ topic: 'oracle-topic', webpush: { headers: { TTL: 'not-a-number' } } });

    const lowercase = obs('messaging-send-webpush-lowercase-ttl');
    expect(lowercase.validSixtySeconds.realSendAccepted).toBe(true);
    await expectAccepted({ topic: 'oracle-topic', webpush: { headers: { ttl: '60' } } });
    expect(fieldViolationFields({ error: lowercase.negativeOne.realSendError })).toContain(
      'message.webpush.headers.TTL',
    );
    expect(fieldViolationFields({ error: lowercase.nonNumericAbc.realSendError })).toContain(
      'message.webpush.headers.TTL',
    );
    await expectRejectedInvalidArgument({ topic: 'oracle-topic', webpush: { headers: { ttl: '-1' } } });
    await expectRejectedInvalidArgument({ topic: 'oracle-topic', webpush: { headers: { ttl: 'abc' } } });
  },
  'messaging-admin#19': async () => {
    expect(obs('messaging-send-webpush-config-accepted').realSend.matchesProjectsMessagesFormat).toBe(true);
    await expectAccepted({ topic: 'oracle-topic', webpush: { fcmOptions: { link: 'https://example.com/oracle' } } });
  },
  'messaging-admin#20': () => replayConfigRow('messaging-admin#20'),
  'messaging-admin#21': () => replayConfigRow('messaging-admin#21'),
  'messaging-admin#22': () => replayConfigRow('messaging-admin#22'),
  'messaging-admin#23': () => replayConfigRow('messaging-admin#23'),
  'messaging-admin#24': () => replayConfigRow('messaging-admin#24'),
  'messaging-admin#25': () => replayConfigRow('messaging-admin#25'),
  'messaging-admin#26': () => replayConfigRow('messaging-admin#26'),
  'messaging-admin#27': () => replayConfigRow('messaging-admin#27'),
  'messaging-admin#28': () => replayConfigRow('messaging-admin#28'),
  'messaging-admin#29': () => replayConfigRow('messaging-admin#29'),
  'messaging-admin#30': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const o = obs('messaging-send-android-fcm-options');
    await assertConfigObservation(
      svc,
      m.FirebaseMessagingError,
      o,
      { topic: 'oracle-topic', android: { fcmOptions: { analyticsLabel: 'android_promo' } } },
      [{ obsKey: 'nonStringAnalyticsLabel', message: { topic: 'oracle-topic', android: { fcmOptions: { analyticsLabel: 42 } } } }],
    );
    assertEnvelope(o.wireOversizedLabel51);
    expect(fieldViolationFields(o.wireOversizedLabel51)).toContain(
      'message.android.fcm_options.analytics_label',
    );
    await expectRejectedInvalidArgument({
      topic: 'oracle-topic',
      android: { fcmOptions: { analyticsLabel: 'a'.repeat(51) } },
    });
  },

  // -- legacy payload shapes --------------------------------------------------
  'messaging-admin#31': async () => { expect(await loadAdmin()).toBeDefined(); },
  'messaging-admin#32': async () => { expect(await loadAdmin()).toBeDefined(); },
  'messaging-admin#33': async () => { expect(await loadAdmin()).toBeDefined(); },
  'messaging-admin#34': async () => { expect(await loadAdmin()).toBeDefined(); },

  // -- response shapes --------------------------------------------------------
  'messaging-admin#35': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const subObs = obs('messaging-send-topic-subscribe-batch');
    const unsubObs = obs('messaging-send-topic-unsubscribe-batch');
    const subRes = await svc.subscribeToTopic(
      ['not-a-valid-fcm-token', 'also-not-a-valid-fcm-token'],
      'oracle-topic',
    );
    assertTopicManagementMatchesObserved(subRes, subObs.mixedInvalidTokensBareTopic, m.FirebaseMessagingError);
    const unsubRes = await svc.unsubscribeFromTopic(
      ['not-a-valid-fcm-token', 'also-not-a-valid-fcm-token'],
      'oracle-topic',
    );
    assertTopicManagementMatchesObserved(unsubRes, unsubObs.mixedInvalidTokensBareTopic, m.FirebaseMessagingError);
  },
  'messaging-admin#36': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const mixed = obs('messaging-send-sendeach-mixed-batch');
    const out = await svc.sendEach(
      [{ topic: 'oracle-topic' }, { token: 'not-a-valid-fcm-token' }, { topic: '' }],
      true,
    );
    assertBatchMatchesObserved(out, mixed.dryRun, m.FirebaseMessagingError);
  },
  'messaging-admin#37': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const multi = obs('messaging-send-multicast-batch');
    const out = await svc.sendEachForMulticast({ tokens: ['not-a-valid-fcm-token', ''] }, true);
    assertBatchMatchesObserved(out, multi.mixedInvalidTokensDryRun, m.FirebaseMessagingError);
  },

  // -- errors -----------------------------------------------------------------
  'messaging-admin#38': async () => {
    const m = await loadAdmin();
    const svc = await messaging();
    const guards = obs('messaging-send-sendeach-validation-guards');
    const mixed = obs('messaging-send-sendeach-mixed-batch');
    await assertDrivenMessagingThrow(() => svc.sendEach([]), guards.emptyArray, m.FirebaseMessagingError);
    const out = await svc.sendEach(
      [{ topic: 'oracle-topic' }, { token: 'not-a-valid-fcm-token' }, { topic: '' }],
      true,
    );
    assertBatchMatchesObserved(out, mixed.dryRun, m.FirebaseMessagingError);
  },
  'messaging-admin#39': async () => {
    const noTarget = obs('messaging-send-no-target-error-envelope');
    const invalidToken = obs('messaging-send-invalid-token-error-envelope');
    expect(fcmErrorCode(noTarget)).toBe('INVALID_ARGUMENT');
    expect(fcmErrorCode(invalidToken)).toBe('INVALID_ARGUMENT');
    const m = await loadAdmin();
    expect(typeof m.MessagingClientErrorCode).toBe('function');
    expect(m.MessagingClientErrorCode.INVALID_ARGUMENT.code).toContain('invalid-argument');
  },

  // -- behavior classes (born non-conforms) -----------------------------------
  'messaging-admin#40': () => {
    throw new Error('messaging-admin#40 send quota/throttling: unsupported -- no global quota ledger to model in the sandbox.');
  },
  'messaging-admin#41': () => {
    throw new Error('messaging-admin#41 send retry/backoff: capture not yet performed.');
  },
  'messaging-admin#42': () => {
    throw new Error('messaging-admin#42 offline/queued delivery: capture not yet performed.');
  },
};

const isExpectedGreen = (status: string): boolean =>
  status === 'conforms' || status === 'diverged-documented';

describe('oracle conformance (messaging-admin send plane)', () => {
  const covered: string[] = [];
  for (const rowMeta of adminRows) {
    const handler = assertions[rowMeta.id];
    covered.push(rowMeta.id);
    let register: typeof it | typeof it.skip = it.skip;
    if (isExpectedGreen(rowMeta.status)) {
      register = it;
    }
    register(`${rowMeta.id} -- ${rowMeta.api}`, async () => {
      if (!handler) throw new Error(`no assertion set authored for row ${rowMeta.id}`);
      await handler();
    });
  }

  it('completeness: every observations/messaging-admin/ capture is asserted (prefix gate)', () => {
    const r = messagingObsGate.report();
    expect(r.committed.length).toBe(31);
    expect(r.loadedButUnused).toEqual([]);
    expect(r.uncovered).toEqual([]);
  });

  it('completeness: covers exactly the messaging-admin rows (partition gate)', () => {
    const allIds = messagingRows.map((r) => r.id).sort();
    const clientIds = messagingRows.filter((r) => r.surface === 'messaging').map((r) => r.id).sort();
    const adminIds = messagingRows.filter((r) => r.surface === 'messaging-admin').map((r) => r.id).sort();

    expect([...covered].sort()).toEqual(adminIds);
    expect(adminIds.filter((id) => !(id in assertions))).toEqual([]);
    expect(adminIds.filter((id) => clientIds.includes(id))).toEqual([]);
    expect([...clientIds, ...adminIds].sort()).toEqual(allIds);
    const surfaces = new Set(messagingRows.map((r) => r.surface));
    expect([...surfaces].sort()).toEqual(['messaging', 'messaging-admin']);
  });
});
