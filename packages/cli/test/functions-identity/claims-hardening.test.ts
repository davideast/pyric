import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getAuth as getAdminAuth } from 'pyric-admin/auth';
import {
  createUserWithEmailAndPassword as createSandboxEmailUser,
  getAuth as getSandboxAuth,
  sandbox as authSandbox,
  sendPasswordResetEmail as sendSandboxPasswordReset,
  signInWithEmailAndPassword as signInSandboxEmailUser,
} from 'pyric/auth';
import { setAuthBlockingHooks } from 'pyric/auth/internal';
import { initializeSandbox } from 'pyric/sandbox';
import { discoverIdentityTriggers } from '../../src/functions/identity/discovery.js';
import {
  CLAIMS_MAX_PAYLOAD_SIZE,
  DISALLOWED_BLOCKING_CLAIMS,
  executeIdentityTrigger,
  normalizeIdentityBlockingError,
  validateIdentityBlockingResponse,
} from '../../src/functions/identity/response.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const identityFunctions = requireFromConformance(
  'firebase-functions/v2/identity',
) as typeof import('firebase-functions/v2/identity');

describe('Identity blocking claims budgets, reserved JWT claims, recaptchaActionOverride, and error hardening', () => {
  test('rejects all 16 reserved JWT claims in both customClaims and sessionClaims', async () => {
    expect(DISALLOWED_BLOCKING_CLAIMS).toHaveLength(16);
    for (const claim of DISALLOWED_BLOCKING_CLAIMS) {
      let createValidationErr: unknown;
      try {
        validateIdentityBlockingResponse('beforeCreate', {
          customClaims: { [claim]: 'reserved' },
        });
      } catch (err) {
        createValidationErr = err;
      }
      expect(normalizeIdentityBlockingError(createValidationErr)).toMatchObject({
        code: 'invalid-argument',
        status: 'INVALID_ARGUMENT',
      });

      let signInValidationErr: unknown;
      try {
        validateIdentityBlockingResponse('beforeSignIn', {
          sessionClaims: { [claim]: 'reserved' },
        });
      } catch (err) {
        signInValidationErr = err;
      }
      expect(normalizeIdentityBlockingError(signInValidationErr)).toMatchObject({
        code: 'invalid-argument',
        status: 'INVALID_ARGUMENT',
      });
    }

    const sandbox = initializeSandbox();
    const auth = getSandboxAuth(sandbox);
    authSandbox.createUser(auth, {
      uid: 'u-claims',
      email: 'claims@example.com',
      password: 'password123',
    });
    for (const claim of ['sub', 'aud', 'iss', 'iat', 'exp', 'auth_time', 'firebase']) {
      setAuthBlockingHooks(auth, {
        beforeCreate: async () => ({ customClaims: { [claim]: 'bad' } }),
        beforeSignIn: async () => ({ sessionClaims: { [claim]: 'bad' } }),
      });
      let createErr: Error | undefined;
      try {
        await createSandboxEmailUser(auth, `new-${claim}@example.com`, 'password123');
      } catch (err) {
        createErr = err as Error;
      }
      expect(createErr?.message).toContain('INVALID_ARGUMENT');

      let signInErr: Error | undefined;
      try {
        await signInSandboxEmailUser(auth, 'claims@example.com', 'password123');
      } catch (err) {
        signInErr = err as Error;
      }
      expect(signInErr?.message).toContain('INVALID_ARGUMENT');
      expect(auth.currentUser).toBeNull();
    }
    expect(authSandbox.listUsers(auth).map((u) => u.uid)).toEqual(['u-claims']);
  });

  test('enforces exact 1000-char boundaries for customClaims, sessionClaims, and combined claims', async () => {
    const exactSingle = { k: 'x'.repeat(CLAIMS_MAX_PAYLOAD_SIZE - 8) };
    const overSingle = { k: 'x'.repeat(CLAIMS_MAX_PAYLOAD_SIZE - 7) };
    expect(JSON.stringify(exactSingle).length).toBe(1000);
    expect(JSON.stringify(overSingle).length).toBe(1001);

    expect(
      validateIdentityBlockingResponse('beforeCreate', { customClaims: exactSingle }).response
        .customClaims,
    ).toEqual(exactSingle);
    expect(
      validateIdentityBlockingResponse('beforeSignIn', { sessionClaims: exactSingle }).response
        .sessionClaims,
    ).toEqual(exactSingle);

    for (const badPayload of [
      () => validateIdentityBlockingResponse('beforeCreate', { customClaims: overSingle }),
      () => validateIdentityBlockingResponse('beforeSignIn', { sessionClaims: overSingle }),
    ]) {
      let caught: unknown;
      try {
        badPayload();
      } catch (err) {
        caught = err;
      }
      expect(normalizeIdentityBlockingError(caught).status).toBe('INVALID_ARGUMENT');
    }

    const customHalf = { a: 'a'.repeat(492) };
    const sessionExactHalf = { b: 'b'.repeat(493) };
    const sessionOverHalf = { b: 'b'.repeat(494) };
    expect(JSON.stringify({ ...customHalf, ...sessionExactHalf }).length).toBe(1000);
    expect(JSON.stringify({ ...customHalf, ...sessionOverHalf }).length).toBe(1001);

    const sandbox = initializeSandbox();
    const auth = getSandboxAuth(sandbox);
    const adminApp = initializeAdminApp(
      { sandbox, projectId: 'pyric-sandbox' },
      'hardening-claims-admin',
    );
    try {
      setAuthBlockingHooks(auth, {
        beforeSignIn: async () => ({
          customClaims: customHalf,
          sessionClaims: sessionOverHalf,
        }),
      });
      authSandbox.createUser(auth, {
        uid: 'u-budget',
        email: 'budget@example.com',
        password: 'password123',
      });
      let overCombinedErr: Error | undefined;
      try {
        await signInSandboxEmailUser(auth, 'budget@example.com', 'password123');
      } catch (err) {
        overCombinedErr = err as Error;
      }
      expect(overCombinedErr?.message).toContain('INVALID_ARGUMENT');

      setAuthBlockingHooks(auth, {
        beforeSignIn: async () => ({
          customClaims: customHalf,
          sessionClaims: sessionExactHalf,
        }),
      });
      const okCred = await signInSandboxEmailUser(auth, 'budget@example.com', 'password123');
      const token = await okCred.user.getIdToken();
      const decoded = await getAdminAuth(adminApp).verifyIdToken(token);
      expect(decoded.a).toBe(customHalf.a);
      expect(decoded.b).toBe(sessionExactHalf.b);
    } finally {
      await deleteAdminApp(adminApp);
    }
  });

  test('validates recaptchaActionOverride ("ALLOW" | "BLOCK") across all 4 trigger types', async () => {
    for (const shortType of [
      'beforeCreate',
      'beforeSignIn',
      'beforeSendEmail',
      'beforeSendSms',
    ] as const) {
      expect(
        validateIdentityBlockingResponse(shortType, { recaptchaActionOverride: 'ALLOW' }).response
          .recaptchaActionOverride,
      ).toBe('ALLOW');
      expect(
        validateIdentityBlockingResponse(shortType, { recaptchaActionOverride: 'BLOCK' }).response
          .recaptchaActionOverride,
      ).toBe('BLOCK');
      let invalidErr: unknown;
      try {
        validateIdentityBlockingResponse(shortType, { recaptchaActionOverride: 'CHALLENGE' });
      } catch (err) {
        invalidErr = err;
      }
      expect(normalizeIdentityBlockingError(invalidErr).status).toBe('INVALID_ARGUMENT');
    }

    const sandbox = initializeSandbox();
    const auth = getSandboxAuth(sandbox);
    authSandbox.createUser(auth, {
      uid: 'u-recap',
      email: 'recap@example.com',
      password: 'password123',
    });
    const invalidOverride = 'CHALLENGE' as unknown as 'ALLOW';
    setAuthBlockingHooks(auth, {
      beforeCreate: async () => ({ recaptchaActionOverride: invalidOverride }),
      beforeSignIn: async () => ({ recaptchaActionOverride: invalidOverride }),
      beforeSendEmail: async () => ({ recaptchaActionOverride: invalidOverride }),
      beforeSendSms: async () => ({ recaptchaActionOverride: invalidOverride }),
    });

    for (const badCall of [
      () => createSandboxEmailUser(auth, 'new-recap@example.com', 'password123'),
      () => signInSandboxEmailUser(auth, 'recap@example.com', 'password123'),
      () => sendSandboxPasswordReset(auth, 'recap@example.com'),
      () => authSandbox.sendAuthSms(auth, { phoneNumber: '+15550103333', smsType: 'SIGN_IN_OR_SIGN_UP' }),
    ]) {
      let caught: Error | undefined;
      try {
        await badCall();
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.message).toContain('INVALID_ARGUMENT');
    }
    expect(authSandbox.takeAuthMail(auth)).toBeNull();
    expect(authSandbox.takeAuthSms(auth)).toBeNull();
  });

  test('maps non-HttpsError throws, invalid return types, and transient init errors fail-closed as INTERNAL', async () => {
    const { beforeUserCreated } = identityFunctions;
    const throwsString = beforeUserCreated(() => {
      throw 'raw string failure';
    });
    const returnsPrimitive = beforeUserCreated(() => 'invalid-return' as unknown as undefined);
    const okHandler = beforeUserCreated(() => ({ displayName: 'Recovered Init' }));

    const [stringTrigger] = discoverIdentityTriggers({ throwsString });
    const [primitiveTrigger] = discoverIdentityTriggers({ returnsPrimitive });
    const [okTrigger] = discoverIdentityTriggers({ okHandler });
    if (!stringTrigger || !primitiveTrigger || !okTrigger) {
      throw new Error('expected discovered triggers');
    }

    const baseInput = {
      eventId: 'evt-hardening',
      projectId: 'demo-project',
      timestampMs: Date.now(),
      signInMethod: 'password',
      userRecord: { uid: 'u-err', email: 'err@example.com' },
    };

    const r1 = await executeIdentityTrigger(stringTrigger, baseInput);
    expect(r1.status).toBe('rejected');
    if (r1.status === 'rejected') {
      expect(r1.error).toEqual({
        code: 'internal',
        status: 'INTERNAL',
        httpStatus: 500,
        message: 'An unexpected error occurred.',
      });
    }

    const r2 = await executeIdentityTrigger(primitiveTrigger, baseInput);
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') {
      expect(r2.error.status).toBe('INTERNAL');
    }

    let initAttempts = 0;
    const flakyInit = async (): Promise<void> => {
      initAttempts += 1;
      if (initAttempts === 1) {
        throw new Error('transient secret fetch failed');
      }
    };
    const r3 = await executeIdentityTrigger(okTrigger, baseInput, {
      ensureInitialized: flakyInit,
    });
    expect(r3.status).toBe('rejected');
    if (r3.status === 'rejected') {
      expect(r3.error.status).toBe('INTERNAL');
    }
    const r4 = await executeIdentityTrigger(okTrigger, baseInput, {
      ensureInitialized: flakyInit,
    });
    expect(r4.status).toBe('fulfilled');
    if (r4.status === 'fulfilled') {
      expect(r4.response).toEqual({ displayName: 'Recovered Init' });
    }
  });
});
