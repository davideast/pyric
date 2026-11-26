import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { endpointTriggerLabel } from '../../src/functions/endpoints.js';
import {
  ACTIVE_IDENTITY_EVENT_TYPES,
  BEFORE_CREATE_EVENT_TYPE,
  BEFORE_SEND_EMAIL_EVENT_TYPE,
  BEFORE_SEND_SMS_EVENT_TYPE,
  BEFORE_SIGN_IN_EVENT_TYPE,
  IDENTITY_BLOCKING_EVENT_TYPES,
  discoverIdentityTriggers,
  identityBlockingFamily,
  inspectIdentityTriggers,
  isIdentityBlockingEventType,
} from '../../src/functions/identity/discovery.js';
import { rtdbValueTriggerFamily } from '../../src/functions/rtdb/discovery.js';
import { storageTriggersFamily } from '../../src/functions/storage/discovery.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const identityFunctions = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');
const databaseFunctions = requireFromConformance(
  'firebase-functions/v2/database',
) as typeof import('firebase-functions/v2/database');
const optionsModule = requireFromConformance(
  'firebase-functions/v2/options',
) as typeof import('firebase-functions/v2/options');
const paramsModule = requireFromConformance(
  'firebase-functions/params',
) as typeof import('firebase-functions/params');
const v1Functions = requireFromConformance(
  'firebase-functions/v1',
) as typeof import('firebase-functions/v1');

describe('firebase-functions/v2/identity trigger discovery', () => {
  test('reads blockingTrigger manifests in endpoints.ts and claims all 4 identity event types', () => {
    const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } =
      identityFunctions;
    const { onValueCreated } = databaseFunctions;

    const onCreate = beforeUserCreated(
      { idToken: true, accessToken: true, refreshToken: false, region: 'europe-west1', timeoutSeconds: 7 },
      () => undefined,
    );
    const onSignIn = beforeUserSignedIn({ refreshToken: true }, () => undefined);
    const onEmail = beforeEmailSent(() => undefined);
    const onSms = beforeSmsSent(() => undefined);
    const onRtdb = onValueCreated('/items/{id}', () => undefined);

    expect(IDENTITY_BLOCKING_EVENT_TYPES).toEqual([
      BEFORE_CREATE_EVENT_TYPE,
      BEFORE_SIGN_IN_EVENT_TYPE,
      BEFORE_SEND_EMAIL_EVENT_TYPE,
      BEFORE_SEND_SMS_EVENT_TYPE,
    ]);
    expect(ACTIVE_IDENTITY_EVENT_TYPES.has(BEFORE_CREATE_EVENT_TYPE)).toBe(true);
    expect(ACTIVE_IDENTITY_EVENT_TYPES.has(BEFORE_SIGN_IN_EVENT_TYPE)).toBe(true);
    expect(ACTIVE_IDENTITY_EVENT_TYPES.has(BEFORE_SEND_EMAIL_EVENT_TYPE)).toBe(true);
    expect(ACTIVE_IDENTITY_EVENT_TYPES.has(BEFORE_SEND_SMS_EVENT_TYPE)).toBe(true);
    expect(isIdentityBlockingEventType(BEFORE_CREATE_EVENT_TYPE)).toBe(true);
    expect(isIdentityBlockingEventType(BEFORE_SIGN_IN_EVENT_TYPE)).toBe(true);
    expect(isIdentityBlockingEventType(BEFORE_SEND_EMAIL_EVENT_TYPE)).toBe(true);
    expect(isIdentityBlockingEventType(BEFORE_SEND_SMS_EVENT_TYPE)).toBe(true);
    expect(isIdentityBlockingEventType('google.firebase.database.ref.v1.created')).toBe(false);
    expect(isIdentityBlockingEventType(null)).toBe(false);

    expect(endpointTriggerLabel(onCreate.__endpoint)).toBe(BEFORE_CREATE_EVENT_TYPE);
    expect(endpointTriggerLabel(onSignIn.__endpoint)).toBe(BEFORE_SIGN_IN_EVENT_TYPE);
    expect(endpointTriggerLabel(onEmail.__endpoint)).toBe(BEFORE_SEND_EMAIL_EVENT_TYPE);
    expect(endpointTriggerLabel(onSms.__endpoint)).toBe(BEFORE_SEND_SMS_EVENT_TYPE);
    expect(endpointTriggerLabel({ blockingTrigger: {} })).toBe('blocking');

    expect(identityBlockingFamily.claims(onCreate.__endpoint)).toBe(true);
    expect(identityBlockingFamily.claims(onSignIn.__endpoint)).toBe(true);
    expect(identityBlockingFamily.claims(onEmail.__endpoint)).toBe(true);
    expect(identityBlockingFamily.claims(onSms.__endpoint)).toBe(true);
    expect(identityBlockingFamily.claims(onRtdb.__endpoint)).toBe(false);

    const inspected = inspectIdentityTriggers({
      onCreate,
      onSignIn,
      onEmail,
      onSms,
      onRtdb,
    });
    expect(inspected.unsupported).toEqual([]);
    expect(
      inspected.triggers.map((item) => ({
        exportName: item.exportName,
        eventType: item.eventType,
        shortEventType: item.shortEventType,
        options: item.options,
        location: item.location,
        timeoutSeconds: item.timeoutSeconds,
      })),
    ).toEqual([
      {
        exportName: 'onCreate',
        eventType: BEFORE_CREATE_EVENT_TYPE,
        shortEventType: 'beforeCreate',
        options: { idToken: true, accessToken: true, refreshToken: false },
        location: 'europe-west1',
        timeoutSeconds: 7,
      },
      {
        exportName: 'onSignIn',
        eventType: BEFORE_SIGN_IN_EVENT_TYPE,
        shortEventType: 'beforeSignIn',
        options: { idToken: false, accessToken: false, refreshToken: true },
        location: undefined,
        timeoutSeconds: undefined,
      },
      {
        exportName: 'onEmail',
        eventType: BEFORE_SEND_EMAIL_EVENT_TYPE,
        shortEventType: 'beforeSendEmail',
        options: { idToken: false, accessToken: false, refreshToken: false },
        location: undefined,
        timeoutSeconds: undefined,
      },
      {
        exportName: 'onSms',
        eventType: BEFORE_SEND_SMS_EVENT_TYPE,
        shortEventType: 'beforeSendSms',
        options: { idToken: false, accessToken: false, refreshToken: false },
        location: undefined,
        timeoutSeconds: undefined,
      },
    ]);
  });

  test('activates all 4 identity blocking event types and honors explicit activeEventTypes filtering', () => {
    const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } =
      identityFunctions;
    const onCreate = beforeUserCreated(() => undefined);
    const onSignIn = beforeUserSignedIn(() => undefined);
    const onEmail = beforeEmailSent(() => undefined);
    const onSms = beforeSmsSent(() => undefined);

    const active = discoverIdentityTriggers({ auth: { onCreate, onSignIn, onEmail, onSms } });
    expect(active.map((item) => item.exportName)).toEqual([
      'auth-onCreate',
      'auth-onSignIn',
      'auth-onEmail',
      'auth-onSms',
    ]);

    const unsupported = findUnsupportedTriggers(
      { auth: { onCreate, onSignIn, onEmail, onSms } },
      [rtdbValueTriggerFamily, storageTriggersFamily, identityBlockingFamily],
    );
    expect(unsupported).toEqual([]);

    const filtered = inspectIdentityTriggers(
      { auth: { onCreate, onEmail } },
      { activeEventTypes: new Set([BEFORE_CREATE_EVENT_TYPE]) },
    );
    expect(filtered.triggers.map((item) => item.exportName)).toEqual(['auth-onCreate']);
    expect(filtered.unsupported).toEqual([
      { exportName: 'auth-onEmail', eventType: BEFORE_SEND_EMAIL_EVENT_TYPE },
    ]);
  });

  test('honors omit: true, ResetValue options, and rejects dynamic param expressions', () => {
    const { beforeUserCreated } = identityFunctions;
    const dynamicOmit = paramsModule.defineBoolean('OMIT_BLOCKING');
    const dynamicRegion = paramsModule.defineString('BLOCKING_REGION');
    const dynamicTimeout = paramsModule.defineInt('BLOCKING_TIMEOUT');

    const omitted = beforeUserCreated({ omit: true }, () => undefined);
    const dynOmit = beforeUserCreated({ omit: dynamicOmit }, () => undefined);
    const dynRegion = beforeUserCreated({ region: dynamicRegion }, () => undefined);
    const dynTimeout = beforeUserCreated({ timeoutSeconds: dynamicTimeout }, () => undefined);
    const resetValues = beforeUserCreated(
      {
        region: optionsModule.RESET_VALUE,
        timeoutSeconds: optionsModule.RESET_VALUE,
      },
      () => undefined,
    );

    const inspected = inspectIdentityTriggers({
      omitted,
      dynOmit,
      dynRegion,
      dynTimeout,
      resetValues,
    });
    expect(inspected.triggers.map((item) => item.exportName)).toEqual(['resetValues']);
    expect(inspected.unsupported).toEqual([
      {
        exportName: 'omitted',
        eventType: `${BEFORE_CREATE_EVENT_TYPE} (omitted from emulation)`,
      },
      {
        exportName: 'dynOmit',
        eventType: `${BEFORE_CREATE_EVENT_TYPE} (unsupported dynamic omit option)`,
      },
      {
        exportName: 'dynRegion',
        eventType: `${BEFORE_CREATE_EVENT_TYPE} (unsupported dynamic region option)`,
      },
      {
        exportName: 'dynTimeout',
        eventType: `${BEFORE_CREATE_EVENT_TYPE} (unsupported dynamic timeoutSeconds option)`,
      },
    ]);
  });

  test('resolves duplicate registrations of the same blocking event type deterministically', () => {
    const { beforeUserCreated } = identityFunctions;
    const firstCreate = beforeUserCreated({ idToken: false }, () => ({ displayName: 'First' }));
    const secondCreate = beforeUserCreated({ idToken: true }, () => ({ displayName: 'Second' }));
    const omittedThird = beforeUserCreated({ omit: true }, () => ({ displayName: 'Omitted' }));

    const inspected = inspectIdentityTriggers({
      firstCreate,
      secondCreate,
      omittedThird,
    });
    expect(inspected.triggers.map((item) => ({
      exportName: item.exportName,
      options: item.options,
    }))).toEqual([
      {
        exportName: 'secondCreate',
        options: { idToken: true, accessToken: false, refreshToken: false },
      },
    ]);
    expect(inspected.unsupported).toEqual([
      {
        exportName: 'omittedThird',
        eventType: `${BEFORE_CREATE_EVENT_TYPE} (omitted from emulation)`,
      },
      {
        exportName: 'firstCreate',
        eventType: `${BEFORE_CREATE_EVENT_TYPE} (superseded by secondCreate)`,
      },
    ]);
  });

  test('reports unclaimed, malformed, and v1 blocking Auth triggers under their blocking event type instead of unknown (#1945)', () => {
    const { beforeUserCreated, beforeUserSignedIn, beforeEmailSent, beforeSmsSent } =
      identityFunctions;
    const prevProject = process.env.GCLOUD_PROJECT;
    process.env.GCLOUD_PROJECT = 'demo-project';
    try {
      const gate = beforeUserCreated(() => undefined);
      const signInGate = beforeUserSignedIn(() => undefined);
      const emailGate = beforeEmailSent(() => undefined);
      const smsGate = beforeSmsSent(() => undefined);
      const omittedGate = beforeUserCreated({ omit: true }, () => undefined);
      const emptyEventBlocking = Object.assign(() => undefined, {
        __endpoint: { blockingTrigger: { eventType: '' } },
      });
      const v1Gate = v1Functions.auth.user().beforeCreate(() => undefined);
      const v1OmittedGate = v1Functions
        .runWith({ omit: true } as never)
        .auth.user()
        .beforeCreate(() => undefined);

      // When no blocking family claims the exports, findUnsupportedTriggers still names
      // each blockingTrigger.eventType (and falls back to 'blocking', never 'unknown').
      const unclaimed = findUnsupportedTriggers(
        { gate, signInGate, emailGate, smsGate, omittedGate, emptyEventBlocking },
        [rtdbValueTriggerFamily, storageTriggersFamily],
      );
      expect(unclaimed).toEqual([
        { exportName: 'gate', eventType: BEFORE_CREATE_EVENT_TYPE },
        { exportName: 'signInGate', eventType: BEFORE_SIGN_IN_EVENT_TYPE },
        { exportName: 'emailGate', eventType: BEFORE_SEND_EMAIL_EVENT_TYPE },
        { exportName: 'smsGate', eventType: BEFORE_SEND_SMS_EVENT_TYPE },
        {
          exportName: 'omittedGate',
          eventType: `${BEFORE_CREATE_EVENT_TYPE} (omitted from emulation)`,
        },
        { exportName: 'emptyEventBlocking', eventType: 'blocking' },
      ]);

      // v1 auth.user().beforeCreate is refused with its blockingTrigger.eventType rather
      // than silently invoked with a v2 AuthBlockingEvent signature, while omit wins first.
      const withV1 = inspectIdentityTriggers({ v1Gate, v1OmittedGate });
      expect(withV1.triggers).toEqual([]);
      expect(withV1.unsupported).toEqual([
        {
          exportName: 'v1Gate',
          eventType: `${BEFORE_CREATE_EVENT_TYPE} (v1 auth.user() blocking is not supported)`,
        },
        {
          exportName: 'v1OmittedGate',
          eventType: `${BEFORE_CREATE_EVENT_TYPE} (omitted from emulation)`,
        },
      ]);
    } finally {
      if (prevProject === undefined) delete process.env.GCLOUD_PROJECT;
      else process.env.GCLOUD_PROJECT = prevProject;
    }
  });
});
