import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  BEFORE_CREATE_EVENT_TYPE,
  BEFORE_SEND_EMAIL_EVENT_TYPE,
  BEFORE_SEND_SMS_EVENT_TYPE,
  BEFORE_SIGN_IN_EVENT_TYPE,
} from '../../src/functions/identity/discovery.js';
import {
  buildAuthBlockingEvent,
  buildAuthBlockingJwt,
  type BuildAuthBlockingEventOptions,
} from '../../src/functions/identity/event.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const firebaseFunctionsRoot = dirname(
  requireFromConformance.resolve('firebase-functions/package.json'),
);
const upstreamIdentityCommon = requireFromConformance(
  join(firebaseFunctionsRoot, 'lib/common/providers/identity.js'),
) as {
  parseAuthUserRecord(raw: Record<string, unknown>): Record<string, unknown>;
  parseAuthEventContext(
    decodedJwt: Record<string, unknown>,
    projectId: string,
    time?: number,
  ): Record<string, unknown>;
};

function decodeUnsignedJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const body = parts[1] ?? '';
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('AuthBlockingEvent and GCIP JWT encoder parity against firebase-functions 7.2.5', () => {
  test('matches upstream parseAuthUserRecord + parseAuthEventContext for tenant password beforeCreate', () => {
    const timestampMs = Date.UTC(2026, 10, 21, 15, 30, 45, 789);
    const options: BuildAuthBlockingEventOptions = {
      eventId: 'evt-create-pw-1',
      eventType: BEFORE_CREATE_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs,
      signInMethod: 'password',
      tenantId: 'tenant-alpha',
      locale: 'en-US',
      ipAddress: '203.0.113.10',
      userAgent: 'Mozilla/5.0 PyricTest',
      recaptchaScore: 0.9,
      userRecord: {
        uid: 'user-pw-1',
        email: 'ada@example.com',
        emailVerified: false,
        displayName: 'Ada',
        photoURL: 'https://example.com/ada.png',
        phoneNumber: '+15550100',
        disabled: false,
        creationTime: '2026-11-21T15:30:45.000Z',
        lastSignInTime: null,
        providerData: [
          {
            uid: 'ada@example.com',
            email: 'ada@example.com',
            displayName: 'Ada',
            photoURL: 'https://example.com/ada.png',
            providerId: 'password',
          },
        ],
        customClaims: { plan: 'starter' },
        tenantId: 'tenant-alpha',
        tokensValidAfterSeconds: 1700000000,
        enrolledFactors: [
          {
            uid: 'mfa-1',
            displayName: 'Work Phone',
            enrollmentTime: '2026-11-20T10:00:00.000Z',
            phoneNumber: '+15550199',
          },
        ],
      },
    };

    const builtEvent = buildAuthBlockingEvent(options);
    const jwt = buildAuthBlockingJwt(options);
    const decoded = decodeUnsignedJwtPayload(jwt);
    const upstreamContext = upstreamIdentityCommon.parseAuthEventContext(
      decoded,
      'demo-project',
      timestampMs,
    );
    const upstreamData = upstreamIdentityCommon.parseAuthUserRecord(
      decoded.user_record as Record<string, unknown>,
    );

    expect(builtEvent).toEqual({
      ...upstreamContext,
      data: upstreamData,
    });
    expect(builtEvent.eventType).toBe('providers/cloud.auth/eventTypes/user.beforeCreate:password');
    expect(builtEvent.authType).toBe('USER');
    expect(builtEvent.resource).toEqual({
      service: 'identitytoolkit.googleapis.com',
      name: 'projects/demo-project/tenants/tenant-alpha',
    });
    expect(builtEvent.credential).toBeNull();
  });

  test('gates OAuth credential tokens by BlockingOptions booleans and extracts GitHub/Twitter usernames', () => {
    const timestampMs = Date.UTC(2026, 10, 21, 16, 0, 0);
    const baseInput: BuildAuthBlockingEventOptions = {
      eventId: 'evt-github-1',
      eventType: BEFORE_SIGN_IN_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs,
      signInMethod: 'github.com',
      rawUserInfo: { login: 'octo-ada', id: 42 },
      credential: {
        idToken: 'oidc-id-tok',
        accessToken: 'gh-access-tok',
        refreshToken: 'gh-refresh-tok',
        expiresInSeconds: 3600,
        secret: 'gh-secret',
      },
      userRecord: {
        uid: 'gh-user-1',
        email: 'octo@example.com',
        emailVerified: true,
        creationTime: timestampMs,
        lastSignInTime: timestampMs,
        providerData: [{ uid: '42', email: 'octo@example.com', providerId: 'github.com' }],
      },
    };

    const allDisabled = buildAuthBlockingEvent({
      ...baseInput,
      blockingOptions: { idToken: false, accessToken: false, refreshToken: false },
    });
    expect(allDisabled.credential).toBeNull();
    expect(allDisabled.additionalUserInfo).toMatchObject({
      providerId: 'github.com',
      username: 'octo-ada',
      isNewUser: false,
      email: 'octo@example.com',
    });

    const selectiveEnabled = buildAuthBlockingEvent({
      ...baseInput,
      blockingOptions: { idToken: true, accessToken: false, refreshToken: true },
    });
    const selectiveJwt = decodeUnsignedJwtPayload(
      buildAuthBlockingJwt({
        ...baseInput,
        blockingOptions: { idToken: true, accessToken: false, refreshToken: true },
      }),
    );
    const upstreamSelective = upstreamIdentityCommon.parseAuthEventContext(
      selectiveJwt,
      'demo-project',
      timestampMs,
    );
    expect(selectiveEnabled.credential).toEqual(upstreamSelective.credential);
    expect(selectiveEnabled.credential).toMatchObject({
      idToken: 'oidc-id-tok',
      accessToken: undefined,
      refreshToken: 'gh-refresh-tok',
      secret: 'gh-secret',
      providerId: 'github.com',
      signInMethod: 'github.com',
    });

    const twitterEvent = buildAuthBlockingEvent({
      ...baseInput,
      signInMethod: 'twitter.com',
      rawUserInfo: JSON.stringify({ screen_name: 'ada_tw' }),
    });
    expect(twitterEvent.additionalUserInfo).toMatchObject({
      providerId: 'twitter.com',
      username: 'ada_tw',
    });
  });

  test('maps emailLink providerId to password and omits data on beforeSendEmail / beforeSendSms', () => {
    const timestampMs = Date.UTC(2026, 10, 21, 16, 15, 0);
    const emailLinkCreate = buildAuthBlockingEvent({
      eventId: 'evt-link-1',
      eventType: BEFORE_CREATE_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs,
      signInMethod: 'emailLink',
      userRecord: {
        uid: 'link-u1',
        email: 'link@example.com',
        emailVerified: true,
        creationTime: timestampMs,
        providerData: [{ uid: 'link@example.com', email: 'link@example.com', providerId: 'password' }],
      },
    });
    expect(emailLinkCreate.eventType).toBe(
      'providers/cloud.auth/eventTypes/user.beforeCreate:emailLink',
    );
    expect(emailLinkCreate.additionalUserInfo).toMatchObject({
      providerId: 'password',
      isNewUser: true,
    });

    const beforeEmail = buildAuthBlockingEvent({
      eventId: 'evt-mail-1',
      eventType: BEFORE_SEND_EMAIL_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs,
      email: 'reset@example.com',
      emailType: 'PASSWORD_RESET',
    });
    expect(beforeEmail.eventType).toBe(BEFORE_SEND_EMAIL_EVENT_TYPE);
    expect(beforeEmail.authType).toBe('UNAUTHENTICATED');
    expect(beforeEmail.emailType).toBe('PASSWORD_RESET');
    expect(beforeEmail.data).toBeUndefined();

    const beforeSms = buildAuthBlockingEvent({
      eventId: 'evt-sms-1',
      eventType: BEFORE_SEND_SMS_EVENT_TYPE,
      projectId: 'demo-project',
      timestampMs,
      phoneNumber: '+15550123',
      smsType: 'MULTI_FACTOR_ENROLLMENT',
      userRecord: {
        uid: 'sms-u1',
        phoneNumber: '+15550123',
      },
    });
    expect(beforeSms.eventType).toBe(BEFORE_SEND_SMS_EVENT_TYPE);
    expect(beforeSms.authType).toBe('USER');
    expect(beforeSms.smsType).toBe('MULTI_FACTOR_ENROLLMENT');
    expect(beforeSms.data).toBeUndefined();
  });
});
