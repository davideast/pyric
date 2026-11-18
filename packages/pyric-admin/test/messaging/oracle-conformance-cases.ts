/**
 * Shared assertion helpers and config-row specs for `oracle-conformance.test.ts` (`messaging-admin`).
 *
 * Drives `pyric-admin/messaging` at runtime and compares actual resource names,
 * batch summaries, and `FirebaseMessagingError` codes/messages against the
 * `behavior` proxy loaded from `packages/conformance/observations/messaging-admin/*.json`.
 */
import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp, initializeApp } from 'pyric-admin/app';

const RESOURCE_NAME = /^projects\/[^/]+\/messages\/[^/]+$/;

export interface ConfigInvalidCase {
  readonly obsKey: string;
  readonly message: Record<string, unknown>;
}

export async function assertDrivenAcceptedPair(
  svc: { send: (msg: unknown, dryRun?: boolean) => Promise<string> },
  acceptedObs: {
    realSend: { matchesProjectsMessagesFormat: boolean };
    dryRunSend: { matchesProjectsMessagesFormat: boolean };
    dryRunSameShapeAsReal: boolean;
  },
  message: Record<string, unknown>,
): Promise<void> {
  const real = await svc.send(message);
  const dry = await svc.send(message, true);
  expect(RESOURCE_NAME.test(real)).toBe(acceptedObs.realSend.matchesProjectsMessagesFormat);
  expect(RESOURCE_NAME.test(dry)).toBe(acceptedObs.dryRunSend.matchesProjectsMessagesFormat);
  expect(RESOURCE_NAME.test(real) && RESOURCE_NAME.test(dry)).toBe(
    acceptedObs.dryRunSameShapeAsReal,
  );
}

export async function assertDrivenMessagingThrow(
  invoke: () => Promise<unknown>,
  expectedObs: {
    threw: boolean;
    code?: string;
    message?: string;
    isFirebaseMessagingError?: boolean;
  },
  ErrorClass: Function,
): Promise<void> {
  let caught: unknown;
  try {
    await invoke();
  } catch (err) {
    caught = err;
  }
  expect(caught !== undefined).toBe(expectedObs.threw);
  const errRecord = caught as { code?: string; message?: string };
  if (expectedObs.code !== undefined) {
    expect(errRecord.code).toBe(expectedObs.code);
  }
  if (expectedObs.message !== undefined) {
    expect(errRecord.message).toBe(expectedObs.message);
  }
  if (expectedObs.isFirebaseMessagingError !== undefined) {
    expect(caught instanceof ErrorClass).toBe(expectedObs.isFirebaseMessagingError);
  }
}

export async function assertConfigObservation(
  svc: { send: (msg: unknown, dryRun?: boolean) => Promise<string> },
  ErrorClass: Function,
  obsBehavior: Record<string, any>,
  acceptedMessage: Record<string, unknown>,
  invalidCases: readonly ConfigInvalidCase[],
  acceptedKey = 'accepted',
): Promise<void> {
  await assertDrivenAcceptedPair(svc, obsBehavior[acceptedKey], acceptedMessage);
  for (const item of invalidCases) {
    await assertDrivenMessagingThrow(
      () => svc.send(item.message, true),
      obsBehavior[item.obsKey],
      ErrorClass,
    );
  }
}

export interface ConfigRowReplaySpec {
  readonly observation: string;
  readonly acceptedMessage: Record<string, unknown>;
  readonly invalidCases: readonly ConfigInvalidCase[];
  readonly acceptedKey?: string;
  readonly extraAccepted?: { readonly key: string; readonly message: Record<string, unknown> };
}

export const CONFIG_ROW_SPECS: Record<string, ConfigRowReplaySpec> = {
  'messaging-admin#20': {
    observation: 'messaging-send-webpush-notification-options',
    acceptedMessage: { topic: 'oracle-topic', webpush: { data: { k: 'v' }, notification: { title: 'Web', customKey: 'x' } } },
    invalidCases: [{ obsKey: 'nonStringWebpushData', message: { topic: 'oracle-topic', webpush: { data: { bad: 1 } } } }],
  },
  'messaging-admin#21': {
    observation: 'messaging-send-apns-config-and-headers',
    acceptedMessage: { topic: 'oracle-topic', apns: { headers: { 'apns-priority': '10' }, payload: { aps: { badge: 1 } } } },
    invalidCases: [
      { obsKey: 'emptyLiveActivityToken', message: { topic: 'oracle-topic', apns: { liveActivityToken: '' } } },
      { obsKey: 'nonStringHeaderValue', message: { topic: 'oracle-topic', apns: { headers: { p: 10 } } } },
    ],
  },
  'messaging-admin#22': {
    observation: 'messaging-send-apns-payload-custom-data',
    acceptedMessage: { topic: 'oracle-topic', apns: { payload: { aps: { category: 'NEW' }, itemId: '42' } } },
    invalidCases: [{ obsKey: 'nonObjectPayload', message: { topic: 'oracle-topic', apns: { payload: 'bad' } } }],
  },
  'messaging-admin#23': {
    observation: 'messaging-send-apns-aps-fields',
    acceptedMessage: { topic: 'oracle-topic', apns: { payload: { aps: { contentAvailable: true, mutableContent: true, threadId: 't1' } } } },
    invalidCases: [
      { obsKey: 'duplicateContentAvailable', message: { topic: 'oracle-topic', apns: { payload: { aps: { contentAvailable: true, 'content-available': 1 } } } } },
    ],
  },
  'messaging-admin#24': {
    observation: 'messaging-send-apns-aps-alert',
    acceptedMessage: { topic: 'oracle-topic', apns: { payload: { aps: { alert: { title: 'Hi', locKey: 'K', locArgs: ['1'] } } } } },
    invalidCases: [
      { obsKey: 'locArgsWithoutLocKey', message: { topic: 'oracle-topic', apns: { payload: { aps: { alert: { locArgs: ['1'] } } } } } },
      { obsKey: 'titleLocArgsWithoutTitleLocKey', message: { topic: 'oracle-topic', apns: { payload: { aps: { alert: { titleLocArgs: ['1'] } } } } } },
      { obsKey: 'subtitleLocArgsWithoutSubtitleLocKey', message: { topic: 'oracle-topic', apns: { payload: { aps: { alert: { subtitleLocArgs: ['1'] } } } } } },
    ],
  },
  'messaging-admin#25': {
    observation: 'messaging-send-apns-critical-sound',
    acceptedMessage: { topic: 'oracle-topic', apns: { payload: { aps: { sound: { critical: true, name: 'default', volume: 0.5 } } } } },
    invalidCases: [
      { obsKey: 'emptySoundName', message: { topic: 'oracle-topic', apns: { payload: { aps: { sound: { name: '' } } } } } },
      { obsKey: 'negativeVolume', message: { topic: 'oracle-topic', apns: { payload: { aps: { sound: { name: 'default', volume: -0.1 } } } } } },
      { obsKey: 'volumeAboveOne', message: { topic: 'oracle-topic', apns: { payload: { aps: { sound: { name: 'default', volume: 1.1 } } } } } },
    ],
  },
  'messaging-admin#26': {
    observation: 'messaging-send-apns-fcm-options',
    acceptedMessage: { topic: 'oracle-topic', apns: { fcmOptions: { analyticsLabel: 'ios', imageUrl: 'https://example.com/a.png' } } },
    invalidCases: [
      { obsKey: 'invalidImageUrl', message: { topic: 'oracle-topic', apns: { fcmOptions: { imageUrl: 'ftp://bad' } } } },
      { obsKey: 'duplicateImageAndImageUrl', message: { topic: 'oracle-topic', apns: { fcmOptions: { imageUrl: 'https://example.com/a.png', image: 'https://example.com/b.png' } } } },
    ],
  },
  'messaging-admin#27': {
    observation: 'messaging-send-android-config',
    acceptedMessage: { topic: 'oracle-topic', android: { collapseKey: 'c1', priority: 'high', ttl: 60000, data: { k: 'v' }, directBootOk: true } },
    invalidCases: [
      { obsKey: 'negativeTtl', message: { topic: 'oracle-topic', android: { ttl: -1 } } },
      { obsKey: 'nonStringDataValue', message: { topic: 'oracle-topic', android: { data: { k: 1 } } } },
    ],
  },
  'messaging-admin#28': {
    observation: 'messaging-send-android-notification',
    acceptedMessage: {
      topic: 'oracle-topic',
      android: {
        notification: {
          title: 'Hi',
          color: '#112233',
          eventTimestamp: new Date('2026-01-01T00:00:00.000Z'),
          vibrateTimingsMillis: [100, 200],
          bodyLocKey: 'BK',
          bodyLocArgs: ['1'],
        },
      },
    },
    invalidCases: [
      { obsKey: 'malformedColor', message: { topic: 'oracle-topic', android: { notification: { color: 'red' } } } },
      { obsKey: 'bodyLocArgsWithoutKey', message: { topic: 'oracle-topic', android: { notification: { bodyLocArgs: ['1'] } } } },
      { obsKey: 'nonDateEventTimestamp', message: { topic: 'oracle-topic', android: { notification: { eventTimestamp: 'bad' } } } },
    ],
  },
  'messaging-admin#29': {
    observation: 'messaging-send-android-light-settings',
    acceptedKey: 'acceptedHex6',
    acceptedMessage: {
      topic: 'oracle-topic',
      android: { notification: { lightSettings: { color: '#112233', lightOnDurationMillis: 100, lightOffDurationMillis: 200 } } },
    },
    invalidCases: [
      { obsKey: 'negativeLightOnDuration', message: { topic: 'oracle-topic', android: { notification: { lightSettings: { color: '#112233', lightOnDurationMillis: -1, lightOffDurationMillis: 200 } } } } },
      { obsKey: 'malformedColorShortHex', message: { topic: 'oracle-topic', android: { notification: { lightSettings: { color: '#123', lightOnDurationMillis: 100, lightOffDurationMillis: 200 } } } } },
    ],
    extraAccepted: {
      key: 'acceptedHex8',
      message: {
        topic: 'oracle-topic',
        android: { notification: { lightSettings: { color: '#11223380', lightOnDurationMillis: 100, lightOffDurationMillis: 200 } } },
      },
    },
  },
};

export async function assertAdminEntryAccessors(
  adminMod: {
    getMessaging: (app?: unknown) => any;
    messaging: (app?: unknown) => any;
  },
  o: Record<string, any>,
): Promise<void> {
  const prevClimb = process.env.PYRIC_CLIMB;
  delete process.env.PYRIC_CLIMB;
  let noAppErr: any;
  try {
    adminMod.getMessaging();
  } catch (err) {
    noAppErr = err;
  } finally {
    if (prevClimb !== undefined) process.env.PYRIC_CLIMB = prevClimb;
  }
  expect(noAppErr !== undefined).toBe(o.noDefaultAppThrows.threw);
  expect(noAppErr.code).toBe(o.noDefaultAppThrows.code);

  const sbxA = initializeSandbox({ projectId: 'entry-default-proj' });
  const sbxB = initializeSandbox({ projectId: 'entry-named-proj' });
  const defApp = initializeApp({ sandbox: sbxA, projectId: 'entry-default-proj' });
  const namedApp = initializeApp(
    { sandbox: sbxB, projectId: 'entry-named-proj' },
    `entry-named-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const defSvc = adminMod.getMessaging();
    expect(defSvc === adminMod.getMessaging(defApp)).toBe(o.defaultGetMessagingMatchesExplicit);
    expect(defSvc === adminMod.messaging()).toBe(o.defaultGetMessagingMatchesNamespace);
    expect(defSvc.app === defApp).toBe(o.defaultAppGetterMatchesDefaultApp);

    const namedSvc = adminMod.getMessaging(namedApp);
    expect(namedSvc === adminMod.messaging(namedApp)).toBe(o.namedGetMessagingMatchesNamespace);
    expect(namedSvc.app === namedApp).toBe(o.namedAppGetterMatchesNamedApp);
    expect(namedSvc !== defSvc).toBe(o.namedDistinctFromDefault);

    let invalidAppErr: unknown;
    try {
      adminMod.getMessaging({});
    } catch (err) {
      invalidAppErr = err;
    }
    expect(invalidAppErr !== undefined).toBe(o.invalidAppArgument.threw);
    expect((invalidAppErr as Error).name).toBe(o.invalidAppArgument.errorName);

    const dryName: string = await namedSvc.send({ topic: 'oracle-topic', data: { k: 'v' } }, true);
    expect(RESOURCE_NAME.test(dryName)).toBe(o.namedDryRunSend.matchesProjectsMessagesFormat);
    expect(dryName.startsWith('projects/entry-named-proj/messages/')).toBe(
      o.namedDryRunSend.projectSegmentMatchesProject,
    );
  } finally {
    await deleteApp(namedApp);
    await deleteApp(defApp);
    sbxA.dispose();
    sbxB.dispose();
  }
}

export function assertBatchMatchesObserved(
  actual: {
    successCount: number;
    failureCount: number;
    responses: Array<{ success: boolean; messageId?: string; error?: any }>;
  },
  expected: {
    successCount: number;
    failureCount: number;
    responseCount: number;
    responses: Array<{
      index: number;
      success: boolean;
      hasMessageId: boolean;
      nameFacts: { matchesProjectsMessagesFormat: boolean } | null;
      hasError: boolean;
      error: { code: string; message: string; isFirebaseMessagingError: boolean } | null;
    }>;
  },
  ErrorClass: Function,
): void {
  expect(actual.successCount).toBe(expected.successCount);
  expect(actual.failureCount).toBe(expected.failureCount);
  expect(actual.responses.length).toBe(expected.responseCount);
  for (const expItem of expected.responses) {
    const got = actual.responses[expItem.index];
    expect(got).toBeDefined();
    if (got === undefined) continue;
    expect(got.success).toBe(expItem.success);
    expect(typeof got.messageId === 'string').toBe(expItem.hasMessageId);
    if (expItem.nameFacts !== null && typeof got.messageId === 'string') {
      expect(RESOURCE_NAME.test(got.messageId)).toBe(
        expItem.nameFacts.matchesProjectsMessagesFormat,
      );
    }
    expect(got.error !== undefined).toBe(expItem.hasError);
    if (expItem.error !== null && got.error !== undefined) {
      expect(got.error.code).toBe(expItem.error.code);
      expect(got.error.message).toBe(expItem.error.message);
      expect(got.error instanceof ErrorClass).toBe(expItem.error.isFirebaseMessagingError);
    }
  }
}
