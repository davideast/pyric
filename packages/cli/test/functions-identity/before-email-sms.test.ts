import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  applyActionCode,
  createUserWithEmailAndPassword,
  getAuth,
  sandbox as authSandbox,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInAnonymously,
  verifyBeforeUpdateEmail,
  verifyPasswordResetCode,
} from 'pyric/auth';
import {
  makeAuthBlockingRejectionError,
  setAuthBlockingHooks,
  type AuthBlockingEmailHookInput,
  type AuthBlockingSmsHookInput,
} from 'pyric/auth/internal';
import { initializeSandbox } from 'pyric/sandbox';
import {
  BEFORE_SEND_EMAIL_EVENT_TYPE,
  BEFORE_SEND_SMS_EVENT_TYPE,
  discoverIdentityTriggers,
} from '../../src/functions/identity/discovery.js';
import type { IdentityEmailType, IdentitySmsType } from '../../src/functions/identity/event.js';
import { executeIdentityTrigger } from '../../src/functions/identity/response.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const identityFunctions = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');
const firebaseFunctionsRoot = dirname(
  requireFromConformance.resolve('firebase-functions/package.json'),
);
const upstreamIdentityCommon = requireFromConformance(
  join(firebaseFunctionsRoot, 'lib/common/providers/identity.js'),
) as {
  parseAuthEventContext(
    decodedJwt: Record<string, unknown>,
    projectId: string,
    time?: number,
  ): Record<string, unknown>;
  generateResponsePayload(authResponse: Record<string, unknown> | undefined): Record<string, unknown>;
};

function decodeUnsignedJwt(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const body = parts[1] ?? '';
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('beforeEmailSent and beforeSmsSent unit and in-process auth hook fidelity', () => {
  test('encodes all 5 emailType values with undefined data and USER vs UNAUTHENTICATED authType across .run and Express JWT paths', async () => {
    const { beforeEmailSent, HttpsError } = identityFunctions;
    const seenEvents: Array<Record<string, unknown>> = [];

    const emailTrigger = beforeEmailSent((event) => {
      seenEvents.push(event as unknown as Record<string, unknown>);
      if (event.additionalUserInfo?.email?.endsWith('@block.test')) {
        throw new HttpsError('permission-denied', 'Email blocked by policy');
      }
      return { recaptchaActionOverride: 'ALLOW' };
    });

    const [discovered] = discoverIdentityTriggers({ emailTrigger });
    if (!discovered) throw new Error('expected emailTrigger to be discovered');
    expect(discovered.eventType).toBe(BEFORE_SEND_EMAIL_EVENT_TYPE);

    const allEmailTypes: IdentityEmailType[] = [
      'EMAIL_SIGN_IN',
      'PASSWORD_RESET',
      'VERIFY_EMAIL',
      'VERIFY_AND_CHANGE_EMAIL',
      'REVERT_SECOND_FACTOR_ADDITION',
    ];

    for (const emailType of allEmailTypes) {
      const hasUser = emailType !== 'EMAIL_SIGN_IN';
      const outcome = await executeIdentityTrigger(discovered, {
        eventId: `ev-${emailType}`,
        projectId: 'demo-email-proj',
        timestampMs: 1_700_000_000_000,
        tenantId: 'tenant-1',
        locale: 'en-US',
        ipAddress: '203.0.113.10',
        userAgent: 'TestAgent/1.0',
        recaptchaScore: 0.9,
        email: 'ada@allow.test',
        emailType,
        userRecord: hasUser ? { uid: 'uid-ada', email: 'ada@allow.test' } : undefined,
      });
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status === 'fulfilled') {
        expect(outcome.response).toEqual({ recaptchaActionOverride: 'ALLOW' });
        expect(outcome.wirePayload).toEqual({ recaptchaActionOverride: 'ALLOW' });
      }
      const recorded = seenEvents.at(-1);
      expect(recorded?.data).toBeUndefined();
      expect(recorded?.authType).toBe(hasUser ? 'USER' : 'UNAUTHENTICATED');
      expect(recorded?.emailType).toBe(emailType);
      expect(recorded?.resource).toEqual({
        service: 'identitytoolkit.googleapis.com',
        name: 'projects/demo-email-proj/tenants/tenant-1',
      });
      expect(recorded?.additionalUserInfo).toMatchObject({
        email: 'ada@allow.test',
        isNewUser: false,
        recaptchaScore: 0.9,
      });
    }

    // Verify Express (req, res) JWT decoding path against upstream parseAuthEventContext.
    const expressOnlyTrigger = {
      ...discovered,
      callable: (req: unknown, res: unknown) => {
        const reqRecord = req as { body?: { data?: { jwt?: string } } };
        const resRecord = res as {
          status(code: number): unknown;
          send(body: unknown): void;
        };
        const jwt = reqRecord.body?.data?.jwt ?? '';
        const decoded = decodeUnsignedJwt(jwt);
        const context = upstreamIdentityCommon.parseAuthEventContext(
          decoded,
          'demo-email-proj',
          1_700_000_000_000,
        );
        try {
          const out = emailTrigger.run(context as unknown as Parameters<typeof emailTrigger.run>[0]);
          const wire = upstreamIdentityCommon.generateResponsePayload(
            (out ?? undefined) as Record<string, unknown> | undefined,
          );
          resRecord.status(200);
          resRecord.send(JSON.stringify(wire));
        } catch (err) {
          const httpErr = err as {
            httpErrorCode?: { status?: number };
            toJSON?: () => Record<string, unknown>;
          };
          resRecord.status(httpErr.httpErrorCode?.status ?? 500);
          resRecord.send({ error: httpErr.toJSON ? httpErr.toJSON() : {} });
        }
      },
    };
    const jwtAllowed = await executeIdentityTrigger(expressOnlyTrigger, {
      eventId: 'jwt-email-1',
      projectId: 'demo-email-proj',
      timestampMs: 1_700_000_000_000,
      email: 'grace@allow.test',
      emailType: 'VERIFY_AND_CHANGE_EMAIL',
      userRecord: { uid: 'uid-grace', email: 'old-grace@allow.test' },
    });
    expect(jwtAllowed.status).toBe('fulfilled');
    if (jwtAllowed.status === 'fulfilled') {
      expect(jwtAllowed.response).toEqual({ recaptchaActionOverride: 'ALLOW' });
    }
    const jwtSeen = seenEvents.at(-1);
    expect(jwtSeen?.data).toBeUndefined();
    expect(jwtSeen?.authType).toBe('USER');
    expect(jwtSeen?.emailType).toBe('VERIFY_AND_CHANGE_EMAIL');
    expect((jwtSeen?.additionalUserInfo as Record<string, unknown> | undefined)?.email).toBe(
      'grace@allow.test',
    );

    const jwtBlocked = await executeIdentityTrigger(expressOnlyTrigger, {
      eventId: 'jwt-email-2',
      projectId: 'demo-email-proj',
      timestampMs: 1_700_000_000_000,
      email: 'mallory@block.test',
      emailType: 'EMAIL_SIGN_IN',
    });
    expect(jwtBlocked.status).toBe('rejected');
    if (jwtBlocked.status === 'rejected') {
      expect(jwtBlocked.error.status).toBe('PERMISSION_DENIED');
      expect(jwtBlocked.error.message).toBe('Email blocked by policy');
    }
  });

  test('encodes all 3 smsType values with undefined data and validates recaptchaActionOverride', async () => {
    const { beforeSmsSent, HttpsError } = identityFunctions;
    const seenSmsEvents: Array<Record<string, unknown>> = [];

    const smsTrigger = beforeSmsSent((event) => {
      seenSmsEvents.push(event as unknown as Record<string, unknown>);
      if (event.additionalUserInfo?.phoneNumber?.startsWith('+1900')) {
        throw new HttpsError('resource-exhausted', 'Premium SMS destination blocked');
      }
      if (event.additionalUserInfo?.phoneNumber === '+15550009999') {
        return { recaptchaActionOverride: 'INVALID_ACTION' as 'ALLOW' };
      }
      return { recaptchaActionOverride: 'BLOCK' };
    });

    const [discovered] = discoverIdentityTriggers({ smsTrigger });
    if (!discovered) throw new Error('expected smsTrigger to be discovered');
    expect(discovered.eventType).toBe(BEFORE_SEND_SMS_EVENT_TYPE);

    const smsTypes: IdentitySmsType[] = [
      'SIGN_IN_OR_SIGN_UP',
      'MULTI_FACTOR_SIGN_IN',
      'MULTI_FACTOR_ENROLLMENT',
    ];

    for (const smsType of smsTypes) {
      const hasUser = smsType !== 'SIGN_IN_OR_SIGN_UP';
      const res = await executeIdentityTrigger(discovered, {
        eventId: `sms-${smsType}`,
        projectId: 'demo-sms-proj',
        timestampMs: 1_700_000_000_000,
        phoneNumber: '+15550101234',
        smsType,
        userRecord: hasUser ? { uid: 'mfa-u1', phoneNumber: '+15550101234' } : undefined,
      });
      expect(res.status).toBe('fulfilled');
      if (res.status === 'fulfilled') {
        expect(res.response).toEqual({ recaptchaActionOverride: 'BLOCK' });
      }
      const seen = seenSmsEvents.at(-1);
      expect(seen?.data).toBeUndefined();
      expect(seen?.authType).toBe(hasUser ? 'USER' : 'UNAUTHENTICATED');
      expect(seen?.smsType).toBe(smsType);
      expect(seen?.additionalUserInfo).toMatchObject({
        phoneNumber: '+15550101234',
        isNewUser: false,
      });
    }

    const denied = await executeIdentityTrigger(discovered, {
      eventId: 'sms-denied',
      projectId: 'demo-sms-proj',
      timestampMs: 1_700_000_000_000,
      phoneNumber: '+19005550199',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(denied.status).toBe('rejected');
    if (denied.status === 'rejected') {
      expect(denied.error.status).toBe('RESOURCE_EXHAUSTED');
    }

    const invalidRecaptcha = await executeIdentityTrigger(discovered, {
      eventId: 'sms-bad-recaptcha',
      projectId: 'demo-sms-proj',
      timestampMs: 1_700_000_000_000,
      phoneNumber: '+15550009999',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(invalidRecaptcha.status).toBe('rejected');
    if (invalidRecaptcha.status === 'rejected') {
      expect(invalidRecaptcha.error.status).toBe('INVALID_ARGUMENT');
    }
  });

  test('gates sendPasswordResetEmail and sendSignInLinkToEmail with enumeration protection and pre-outbox rejection', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);
    const ada = authSandbox.createUser(auth, {
      uid: 'ada-email-1',
      email: 'ada@example.com',
      password: 'secret123',
    });

    const calls: AuthBlockingEmailHookInput[] = [];
    let blockNext = false;
    setAuthBlockingHooks(auth, {
      async beforeSendEmail(input) {
        calls.push(structuredClone(input));
        if (blockNext) {
          throw makeAuthBlockingRejectionError({
            status: 'PERMISSION_DENIED',
            message: 'Outbound mail blocked',
          });
        }
        return { recaptchaActionOverride: 'ALLOW' };
      },
    });

    // Unknown address on sendPasswordResetEmail resolves silently without firing beforeSendEmail.
    await sendPasswordResetEmail(auth, 'ghost@example.com');
    expect(calls).toHaveLength(0);
    expect(authSandbox.takeAuthMail(auth)).toBeNull();

    // Blocked known address rejects before minting code or writing mail.
    blockNext = true;
    let resetErr: (Error & { code?: string }) | undefined;
    try {
      await sendPasswordResetEmail(auth, 'ada@example.com');
    } catch (err) {
      resetErr = err as Error & { code?: string };
    }
    expect(resetErr?.code).toBe('auth/internal-error');
    expect(resetErr?.message).toContain('PERMISSION_DENIED');
    expect(authSandbox.takeAuthMail(auth)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.emailType).toBe('PASSWORD_RESET');
    expect(calls[0]?.userRecord?.uid).toBe(ada.uid);

    // Approved known address delivers working reset code.
    blockNext = false;
    await sendPasswordResetEmail(auth, 'ada@example.com');
    const resetMail = authSandbox.takeAuthMail(auth, 'ada@example.com');
    expect(resetMail).not.toBeNull();
    if (resetMail) {
      expect(await verifyPasswordResetCode(auth, resetMail.code)).toBe('ada@example.com');
    }

    // sendSignInLinkToEmail: brand-new email passes undefined userRecord; existing email passes userRecord.
    const linkSettings = { url: 'https://example.com/finish', handleCodeInApp: true };
    await sendSignInLinkToEmail(auth, 'new-signup@example.com', linkSettings);
    expect(calls.at(-1)?.emailType).toBe('EMAIL_SIGN_IN');
    expect(calls.at(-1)?.userRecord).toBeUndefined();
    expect(authSandbox.takeAuthMail(auth, 'new-signup@example.com')).not.toBeNull();

    await sendSignInLinkToEmail(auth, 'ada@example.com', linkSettings);
    expect(calls.at(-1)?.emailType).toBe('EMAIL_SIGN_IN');
    expect(calls.at(-1)?.userRecord?.uid).toBe(ada.uid);
    expect(authSandbox.takeAuthMail(auth, 'ada@example.com')).not.toBeNull();

    blockNext = true;
    let linkErr: (Error & { code?: string }) | undefined;
    try {
      await sendSignInLinkToEmail(auth, 'blocked-link@example.com', linkSettings);
    } catch (err) {
      linkErr = err as Error & { code?: string };
    }
    expect(linkErr?.code).toBe('auth/internal-error');
    expect(authSandbox.takeAuthMail(auth)).toBeNull();
  });

  test('gates User-only sendEmailVerification and verifyBeforeUpdateEmail via backend projectStore hooks', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);

    const calls: AuthBlockingEmailHookInput[] = [];
    let shouldBlock = false;
    setAuthBlockingHooks(auth, {
      async beforeSendEmail(input) {
        calls.push(structuredClone(input));
        if (shouldBlock) {
          throw makeAuthBlockingRejectionError({
            status: 'FAILED_PRECONDITION',
            message: 'Email change blocked',
          });
        }
        return { recaptchaActionOverride: 'ALLOW' };
      },
    });

    // Anonymous user has no email -> throws auth/missing-email before hook runs.
    const anonCred = await signInAnonymously(auth);
    let missingEmailErr: (Error & { code?: string }) | undefined;
    try {
      await sendEmailVerification(anonCred.user);
    } catch (err) {
      missingEmailErr = err as Error & { code?: string };
    }
    expect(missingEmailErr?.code).toBe('auth/missing-email');
    expect(calls).toHaveLength(0);
    await auth.signOut();

    const userCred = await createUserWithEmailAndPassword(auth, 'grace@example.com', 'secret123');
    shouldBlock = true;
    let verifyErr: (Error & { code?: string }) | undefined;
    try {
      await sendEmailVerification(userCred.user);
    } catch (err) {
      verifyErr = err as Error & { code?: string };
    }
    expect(verifyErr?.code).toBe('auth/internal-error');
    expect(authSandbox.takeAuthMail(auth)).toBeNull();

    shouldBlock = false;
    await sendEmailVerification(userCred.user);
    expect(calls.at(-1)?.emailType).toBe('VERIFY_EMAIL');
    expect(calls.at(-1)?.userRecord?.uid).toBe(userCred.user.uid);
    const verifyMail = authSandbox.takeAuthMail(auth, 'grace@example.com');
    if (!verifyMail) throw new Error('expected verification mail');
    await applyActionCode(auth, verifyMail.code);

    // verifyBeforeUpdateEmail sends to newEmail and blocks before emitting code on error.
    shouldBlock = true;
    let changeErr: (Error & { code?: string }) | undefined;
    try {
      await verifyBeforeUpdateEmail(userCred.user, 'grace-next@example.com');
    } catch (err) {
      changeErr = err as Error & { code?: string };
    }
    expect(changeErr?.code).toBe('auth/internal-error');
    expect(authSandbox.takeAuthMail(auth)).toBeNull();

    shouldBlock = false;
    await verifyBeforeUpdateEmail(userCred.user, 'grace-next@example.com');
    expect(calls.at(-1)?.emailType).toBe('VERIFY_AND_CHANGE_EMAIL');
    expect(calls.at(-1)?.email).toBe('grace-next@example.com');
    expect(calls.at(-1)?.userRecord?.uid).toBe(userCred.user.uid);
    const changeMail = authSandbox.takeAuthMail(auth, 'grace-next@example.com');
    if (!changeMail) throw new Error('expected change-email message');
    await applyActionCode(auth, changeMail.code);
    const updatedRecord = authSandbox.listUsers(auth).find((u) => u.uid === userCred.user.uid);
    expect(updatedRecord?.email).toBe('grace-next@example.com');
  });

  test('gates sandbox.sendAuthSms across SIGN_IN_OR_SIGN_UP, MULTI_FACTOR_SIGN_IN, and MULTI_FACTOR_ENROLLMENT', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);
    const existingPhoneUser = authSandbox.createUser(auth, {
      uid: 'phone-user-1',
      email: 'phone@example.com',
      phoneNumber: '+15550102000',
    });

    const smsCalls: AuthBlockingSmsHookInput[] = [];
    setAuthBlockingHooks(auth, {
      async beforeSendSms(input) {
        smsCalls.push(structuredClone(input));
        if (input.phoneNumber.startsWith('+1900')) {
          throw makeAuthBlockingRejectionError({
            status: 'PERMISSION_DENIED',
            message: 'Carrier prefix denied',
          });
        }
        return { recaptchaActionOverride: 'ALLOW' };
      },
    });

    // Invalid E.164 phone number fails before invoking beforeSendSms.
    let badPhoneErr: (Error & { code?: string }) | undefined;
    try {
      await authSandbox.sendAuthSms(auth, { phoneNumber: '555-0100' });
    } catch (err) {
      badPhoneErr = err as Error & { code?: string };
    }
    expect(badPhoneErr?.code).toBe('auth/invalid-phone-number');
    expect(smsCalls).toHaveLength(0);

    // Blocked SMS aborts before pushing to smsOutbox.
    let blockedSmsErr: (Error & { code?: string }) | undefined;
    try {
      await authSandbox.sendAuthSms(auth, {
        phoneNumber: '+19005550123',
        smsType: 'SIGN_IN_OR_SIGN_UP',
      });
    } catch (err) {
      blockedSmsErr = err as Error & { code?: string };
    }
    expect(blockedSmsErr?.code).toBe('auth/internal-error');
    expect(authSandbox.listAuthSms(auth)).toEqual([]);
    expect(authSandbox.takeAuthSms(auth)).toBeNull();

    // Brand-new phone number -> userRecord undefined.
    const freshSms = await authSandbox.sendAuthSms(auth, {
      phoneNumber: '+15550101111',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(smsCalls.at(-1)?.userRecord).toBeUndefined();
    expect(freshSms.recaptchaActionOverride).toBe('ALLOW');
    expect(authSandbox.takeAuthSms(auth, '+15550101111')?.verificationId).toBe(
      freshSms.verificationId,
    );

    // Existing phone user -> userRecord populated on SIGN_IN_OR_SIGN_UP and MULTI_FACTOR_SIGN_IN.
    await authSandbox.sendAuthSms(auth, {
      phoneNumber: '+15550102000',
      smsType: 'SIGN_IN_OR_SIGN_UP',
    });
    expect(smsCalls.at(-1)?.userRecord?.uid).toBe(existingPhoneUser.uid);

    await authSandbox.sendAuthSms(auth, {
      phoneNumber: '+15550102000',
      smsType: 'MULTI_FACTOR_SIGN_IN',
    });
    expect(smsCalls.at(-1)?.smsType).toBe('MULTI_FACTOR_SIGN_IN');
    expect(smsCalls.at(-1)?.userRecord?.uid).toBe(existingPhoneUser.uid);

    // MULTI_FACTOR_ENROLLMENT for an explicit uid enrolling a new second-factor phone.
    const enrollSms = await authSandbox.sendAuthSms(auth, {
      phoneNumber: '+15550103333',
      smsType: 'MULTI_FACTOR_ENROLLMENT',
      uid: existingPhoneUser.uid,
    });
    expect(smsCalls.at(-1)?.smsType).toBe('MULTI_FACTOR_ENROLLMENT');
    expect(smsCalls.at(-1)?.userRecord?.uid).toBe(existingPhoneUser.uid);
    expect(enrollSms.uid).toBe(existingPhoneUser.uid);
    expect(authSandbox.listAuthSms(auth)).toHaveLength(3);
  });
});
