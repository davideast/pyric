import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  BEFORE_CREATE_EVENT_TYPE,
  discoverIdentityTriggers,
  type DiscoveredIdentityTrigger,
} from '../../src/functions/identity/discovery.js';
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

describe('Identity blocking response validation, HttpsError mapping, and execution', () => {
  test('validates BeforeCreateResponse fields, updateMask wire payload, and recaptchaActionOverride', () => {
    const empty = validateIdentityBlockingResponse('beforeCreate', undefined);
    expect(empty).toEqual({ response: {}, wirePayload: {} });

    const populated = validateIdentityBlockingResponse('beforeCreate', {
      displayName: 'Grace Hopper',
      disabled: false,
      emailVerified: true,
      photoURL: 'https://example.com/grace.png',
      customClaims: { role: 'admiral', level: 9 },
      recaptchaActionOverride: 'ALLOW',
    });
    expect(populated).toEqual({
      response: {
        displayName: 'Grace Hopper',
        disabled: false,
        emailVerified: true,
        photoURL: 'https://example.com/grace.png',
        customClaims: { role: 'admiral', level: 9 },
        recaptchaActionOverride: 'ALLOW',
      },
      wirePayload: {
        userRecord: {
          displayName: 'Grace Hopper',
          disabled: false,
          emailVerified: true,
          photoURL: 'https://example.com/grace.png',
          customClaims: { role: 'admiral', level: 9 },
          updateMask: 'displayName,disabled,emailVerified,photoURL,customClaims',
        },
        recaptchaActionOverride: 'ALLOW',
      },
    });
  });

  test('rejects reserved JWT claims and oversized claim payloads with invalid-argument', () => {
    for (const reserved of DISALLOWED_BLOCKING_CLAIMS) {
      let caught: unknown;
      try {
        validateIdentityBlockingResponse('beforeCreate', {
          customClaims: { [reserved]: 'forbidden' },
        });
      } catch (err) {
        caught = err;
      }
      expect(normalizeIdentityBlockingError(caught)).toMatchObject({
        code: 'invalid-argument',
        status: 'INVALID_ARGUMENT',
        httpStatus: 400,
      });
    }

    const oversizedValue = 'x'.repeat(CLAIMS_MAX_PAYLOAD_SIZE);
    let oversizedErr: unknown;
    try {
      validateIdentityBlockingResponse('beforeCreate', {
        customClaims: { blob: oversizedValue },
      });
    } catch (err) {
      oversizedErr = err;
    }
    expect(normalizeIdentityBlockingError(oversizedErr)).toMatchObject({
      code: 'invalid-argument',
      status: 'INVALID_ARGUMENT',
    });

    let combinedErr: unknown;
    try {
      validateIdentityBlockingResponse('beforeSignIn', {
        customClaims: { a: 'a'.repeat(520) },
        sessionClaims: { b: 'b'.repeat(520) },
      });
    } catch (err) {
      combinedErr = err;
    }
    expect(normalizeIdentityBlockingError(combinedErr)).toMatchObject({
      code: 'invalid-argument',
      status: 'INVALID_ARGUMENT',
    });

    let badRecaptchaErr: unknown;
    try {
      validateIdentityBlockingResponse('beforeCreate', {
        recaptchaActionOverride: 'INVALID',
      });
    } catch (err) {
      badRecaptchaErr = err;
    }
    expect(normalizeIdentityBlockingError(badRecaptchaErr)).toMatchObject({
      code: 'invalid-argument',
      status: 'INVALID_ARGUMENT',
    });
  });

  test('executes real firebase-functions/v2/identity HttpsError rejections and Express fallback handlers', async () => {
    const { beforeUserCreated, HttpsError } = identityFunctions;

    const rejecting = beforeUserCreated((event) => {
      if (!event.data?.email?.endsWith('@allowed.test')) {
        throw new HttpsError('permission-denied', 'Domain not allowed', {
          domain: event.data?.email ?? null,
        });
      }
      return { emailVerified: true };
    });

    const crashing = beforeUserCreated(() => {
      throw new TypeError('unexpected boom');
    });

    const [rejectingTrigger] = discoverIdentityTriggers({ rejecting });
    const [crashingTrigger] = discoverIdentityTriggers({ crashing });
    if (!rejectingTrigger || !crashingTrigger) {
      throw new Error('expected discovered triggers');
    }

    const deniedResult = await executeIdentityTrigger(rejectingTrigger, {
      eventId: 'evt-1',
      projectId: 'demo-project',
      timestampMs: Date.now(),
      signInMethod: 'password',
      userRecord: { uid: 'u-1', email: 'intruder@blocked.test' },
    });
    expect(deniedResult.status).toBe('rejected');
    if (deniedResult.status === 'rejected') {
      expect(deniedResult.error).toEqual({
        code: 'permission-denied',
        status: 'PERMISSION_DENIED',
        httpStatus: 403,
        message: 'Domain not allowed',
        details: { domain: 'intruder@blocked.test' },
      });
    }

    const crashResult = await executeIdentityTrigger(crashingTrigger, {
      eventId: 'evt-2',
      projectId: 'demo-project',
      timestampMs: Date.now(),
      signInMethod: 'password',
      userRecord: { uid: 'u-2', email: 'user@allowed.test' },
    });
    expect(crashResult.status).toBe('rejected');
    if (crashResult.status === 'rejected') {
      expect(crashResult.error).toEqual({
        code: 'internal',
        status: 'INTERNAL',
        httpStatus: 500,
        message: 'An unexpected error occurred.',
      });
    }

    const expressTrigger: DiscoveredIdentityTrigger = {
      exportName: 'expressStyle',
      eventType: BEFORE_CREATE_EVENT_TYPE,
      shortEventType: 'beforeCreate',
      options: { idToken: false, accessToken: false, refreshToken: false },
      callable: (req: unknown, res: unknown) => {
        const reqObj = req as { body?: { data?: { jwt?: string } } };
        const resObj = res as {
          status(code: number): unknown;
          send(body: string): void;
        };
        const hasJwt = typeof reqObj.body?.data?.jwt === 'string';
        resObj.status(200);
        resObj.send(
          JSON.stringify({
            userRecord: {
              displayName: hasJwt ? 'Via Express JWT' : 'Missing JWT',
              updateMask: 'displayName',
            },
          }),
        );
      },
    };
    const expressResult = await executeIdentityTrigger(expressTrigger, {
      eventId: 'evt-3',
      projectId: 'demo-project',
      timestampMs: Date.now(),
      signInMethod: 'password',
      userRecord: { uid: 'u-3', email: 'express@allowed.test' },
    });
    expect(expressResult.status).toBe('fulfilled');
    if (expressResult.status === 'fulfilled') {
      expect(expressResult.response).toEqual({ displayName: 'Via Express JWT' });
    }
  });
});
