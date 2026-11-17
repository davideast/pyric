/**
 * Declarative Admin Auth method schemas composed from
 * `../argument-generator/argument-combinators.js` without modifying the shared
 * combinator module.
 */

import {
  boundedArraySchema,
  emitFieldCandidates,
  makeCandidate,
  methodSchema,
  objectSchema,
  prefixedIdentifierSchema,
  scalarSchema,
  type CandidateValue,
  type FieldSchema,
  type MethodSchema,
} from '../argument-generator/argument-combinators.js';
import type { AuthSchemaSeed } from './auth-sandbox-arms.js';

const UID_PREFIXES = ['', 'u-'] as const;
const UID_BODIES = ['', 'valid', 'x'.repeat(126), 'x'.repeat(128), 'x'.repeat(129)] as const;

export function buildUidFieldSchema(extra: readonly CandidateValue[] = []): FieldSchema {
  const baseGrammar = prefixedIdentifierSchema({
    prefixes: UID_PREFIXES,
    bodies: UID_BODIES,
  });
  if (extra.length === 0) {
    return baseGrammar;
  }
  return scalarSchema({
    extraCandidates: () => [...emitFieldCandidates(baseGrammar, 'uid'), ...extra],
  });
}

function buildEmailFieldSchema(extra: readonly CandidateValue[] = []): FieldSchema {
  return scalarSchema({
    extraCandidates: () => [
      makeCandidate('email="plain"', () => 'plain'),
      makeCandidate('email="@example.com"', () => '@example.com'),
      makeCandidate('email="user@"', () => 'user@'),
      makeCandidate('email="a@b@c.com"', () => 'a@b@c.com'),
      makeCandidate('email="user@localhost"', () => 'user@localhost'),
      makeCandidate('email=" padded@example.com "', () => ' padded@example.com '),
      makeCandidate('email="fresh@example.com"', () => 'fresh@example.com'),
      ...extra,
    ],
  });
}

function buildPhoneFieldSchema(): FieldSchema {
  return scalarSchema({
    extraCandidates: () => [
      makeCandidate('phone="+"', () => '+'),
      makeCandidate('phone="+---"', () => '+---'),
      makeCandidate('phone="15555550100"', () => '15555550100'),
      makeCandidate('phone="+abc"', () => '+abc'),
      makeCandidate('phone="+0123456"', () => '+0123456'),
      makeCandidate('phone="+155555501009999999"', () => '+155555501009999999'),
      makeCandidate('phone="+15555550199"', () => '+15555550199'),
    ],
  });
}

function buildUrlFieldSchema(): FieldSchema {
  return scalarSchema({
    extraCandidates: () => [
      makeCandidate('url="not-a-url"', () => 'not-a-url'),
      makeCandidate('url="ftp://example.com/a.png"', () => 'ftp://example.com/a.png'),
      makeCandidate('url="https://-bad.com/a.png"', () => 'https://-bad.com/a.png'),
      makeCandidate('url="https://example.com/bad path"', () => 'https://example.com/bad path'),
      makeCandidate('url="https://[::1]/avatar.png"', () => 'https://[::1]/avatar.png'),
      makeCandidate('url="https://example.com/avatar.png"', () => 'https://example.com/avatar.png'),
    ],
  });
}

function buildPasswordFieldSchema(): FieldSchema {
  return scalarSchema({
    extraCandidates: () => [
      makeCandidate('pw-len=5', () => '12345'),
      makeCandidate('pw-len=6', () => '123456'),
    ],
  });
}

function withExtraObjectCandidates(
  obj: FieldSchema,
  extra: () => readonly CandidateValue[],
): FieldSchema {
  return scalarSchema({
    extraCandidates: () => [...emitFieldCandidates(obj, 'obj'), ...extra()],
  });
}

const CLAIM_GRAMMAR_KEYS = [
  'role', 'acr', 'amr', 'at_hash', 'aud', 'auth_time', 'azp', 'cnf', 'c_hash',
  'exp', 'iat', 'iss', 'jti', 'nbf', 'nonce', 'sub', 'firebase', '__proto__',
] as const;

function buildClaimsMapCandidates(includeSizeCap: boolean): CandidateValue[] {
  const candidates: CandidateValue[] = [];
  for (const claimKey of CLAIM_GRAMMAR_KEYS) {
    candidates.push(
      makeCandidate(`claim[${claimKey}]="v"`, () => JSON.parse(`{"${claimKey}":"v"}`) as unknown),
    );
    candidates.push(
      makeCandidate(`claim[${claimKey}]=undefined`, () => ({ [claimKey]: undefined })),
    );
  }
  if (includeSizeCap) {
    const exact1000Value = 'x'.repeat(1000 - '{"d":""}'.length);
    const over1001Value = 'x'.repeat(1001 - '{"d":""}'.length);
    candidates.push(makeCandidate('payload-len=1000', () => ({ d: exact1000Value })));
    candidates.push(makeCandidate('payload-len=1001', () => ({ d: over1001Value })));
  }
  return candidates;
}

function buildActionCodeSettingsFieldSchema(): FieldSchema {
  return objectSchema({
    validBase: () => ({ url: 'https://example.com/finish' }),
    fields: {
      url: buildUrlFieldSchema(),
      handleCodeInApp: scalarSchema(),
      dynamicLinkDomain: scalarSchema(),
      linkDomain: scalarSchema(),
      iOS: objectSchema({
        validBase: () => ({ bundleId: 'com.example.ios' }),
        fields: { bundleId: scalarSchema() },
      }),
      android: objectSchema({
        validBase: () => ({ packageName: 'com.example.android' }),
        fields: {
          packageName: scalarSchema(),
          minimumVersion: scalarSchema(),
          installApp: scalarSchema(),
        },
      }),
    },
  });
}

export interface AuthMethodSchemas {
  readonly createCustomToken: MethodSchema;
  readonly setCustomUserClaims: MethodSchema;
  readonly createUser: MethodSchema;
  readonly updateUser: MethodSchema;
  readonly getUser: MethodSchema;
  readonly getUserByEmail: MethodSchema;
  readonly getUserByPhoneNumber: MethodSchema;
  readonly getUsers: MethodSchema;
  readonly deleteUser: MethodSchema;
  readonly deleteUsers: MethodSchema;
  readonly listUsers: MethodSchema;
  readonly verifyIdToken: MethodSchema;
  readonly revokeRefreshTokens: MethodSchema;
  readonly createSessionCookie: MethodSchema;
  readonly verifySessionCookie: MethodSchema;
  readonly generatePasswordResetLink: MethodSchema;
  readonly generateEmailVerificationLink: MethodSchema;
  readonly generateSignInWithEmailLink: MethodSchema;
  readonly generateVerifyAndChangeEmailLink: MethodSchema;
}

export function buildAuthMethodSchemas(seed: AuthSchemaSeed): AuthMethodSchemas {
  const actionCodeSettingsSchema = buildActionCodeSettingsFieldSchema();
  const uidWithMissing = buildUidFieldSchema([
    makeCandidate('missing-uid', () => 'missing-user-999'),
  ]);

  const createUserObj = objectSchema({
    validBase: () => ({ email: 'created@example.com' }),
    fields: {
      uid: buildUidFieldSchema([makeCandidate('duplicate-uid', () => seed.existingUid)]),
      email: buildEmailFieldSchema([makeCandidate('duplicate-email', () => seed.existingEmail)]),
      phoneNumber: buildPhoneFieldSchema(),
      emailVerified: scalarSchema(),
      displayName: scalarSchema(),
      photoURL: buildUrlFieldSchema(),
      disabled: scalarSchema(),
      password: buildPasswordFieldSchema(),
    },
  });

  const updateUserObj = objectSchema({
    validBase: () => ({}),
    fields: {
      email: buildEmailFieldSchema([makeCandidate('duplicate-email', () => seed.secondEmail)]),
      phoneNumber: buildPhoneFieldSchema(),
      emailVerified: scalarSchema(),
      displayName: scalarSchema(),
      photoURL: buildUrlFieldSchema(),
      disabled: scalarSchema(),
      password: buildPasswordFieldSchema(),
    },
  });

  return {
    createCustomToken: methodSchema({
      name: 'createCustomToken',
      parameters: [
        { name: 'uid', validValue: () => seed.existingUid, schema: buildUidFieldSchema() },
        {
          name: 'developerClaims',
          validValue: () => ({ role: 'reader' }),
          omitTrailingUndefined: true,
          schema: scalarSchema({ extraCandidates: () => buildClaimsMapCandidates(false) }),
        },
      ],
    }),
    setCustomUserClaims: methodSchema({
      name: 'setCustomUserClaims',
      parameters: [
        { name: 'uid', validValue: () => seed.existingUid, schema: uidWithMissing },
        {
          name: 'customUserClaims',
          validValue: () => ({ role: 'editor' }),
          schema: scalarSchema({ extraCandidates: () => buildClaimsMapCandidates(true) }),
        },
      ],
    }),
    createUser: methodSchema({
      name: 'createUser',
      parameters: [
        {
          name: 'properties',
          validValue: () => ({ email: 'created@example.com', password: 'secret-password' }),
          schema: withExtraObjectCandidates(createUserObj, () => [
            makeCandidate('empty-properties', () => ({})),
            makeCandidate('password-without-email', () => ({ password: 'secret-password' })),
            makeCandidate('disallowed-customAttributes', () => ({ customAttributes: '{}' })),
            makeCandidate('disallowed-validSince', () => ({ validSince: 100 })),
            makeCandidate('disallowed-tenantId', () => ({ tenantId: 'tenant-1' })),
            makeCandidate('mfa-with-uid', () => ({
              multiFactor: {
                enrolledFactors: [{ uid: 'f1', factorId: 'phone', phoneNumber: '+15555550199' }],
              },
            })),
            makeCandidate('mfa-with-enrollmentTime', () => ({
              multiFactor: {
                enrolledFactors: [
                  {
                    enrollmentTime: 'Thu, 01 Jan 2026 00:00:00 GMT',
                    factorId: 'phone',
                    phoneNumber: '+15555550199',
                  },
                ],
              },
            })),
            makeCandidate('mfa-unsupported-factor', () => ({
              multiFactor: { enrolledFactors: [{ factorId: 'totp' }] },
            })),
          ]),
        },
      ],
    }),
    updateUser: methodSchema({
      name: 'updateUser',
      parameters: [
        { name: 'uid', validValue: () => seed.existingUid, schema: uidWithMissing },
        {
          name: 'properties',
          validValue: () => ({ displayName: 'Updated Name' }),
          schema: withExtraObjectCandidates(updateUserObj, () => [
            makeCandidate('disallowed-tenantId', () => ({ tenantId: 'tenant-1' })),
            makeCandidate('providerToLink-conflict-email', () => ({
              email: 'conflict@example.com',
              providerToLink: { providerId: 'email', uid: 'conflict@example.com' },
            })),
            makeCandidate('providerToLink-conflict-phone', () => ({
              phoneNumber: '+15555550122',
              providerToLink: { providerId: 'phone', uid: '+15555550122' },
            })),
            makeCandidate('providersToUnlink-conflict-phone-null', () => ({
              phoneNumber: null,
              providersToUnlink: ['phone'],
            })),
            makeCandidate('providerToLink-empty-providerId', () => ({
              providerToLink: { providerId: '', uid: 'prov-u1' },
            })),
            makeCandidate('providerToLink-empty-uid', () => ({
              providerToLink: { providerId: 'google.com', uid: '' },
            })),
            makeCandidate('providerToLink-bad-email', () => ({
              providerToLink: { providerId: 'google.com', uid: 'prov-u1', email: 'not-an-email' },
            })),
            makeCandidate('providerToLink-bad-photoURL', () => ({
              providerToLink: { providerId: 'google.com', uid: 'prov-u1', photoURL: 'not-a-url' },
            })),
            makeCandidate('providerToLink-valid', () => ({
              providerToLink: { providerId: 'google.com', uid: 'prov-u1' },
            })),
            makeCandidate('providersToUnlink-non-array-num', () => ({ providersToUnlink: 123 })),
            makeCandidate('providersToUnlink-non-array-str', () => ({
              providersToUnlink: 'google.com',
            })),
            makeCandidate('providersToUnlink-empty-entry', () => ({ providersToUnlink: [''] })),
            makeCandidate('providersToUnlink-valid', () => ({
              providersToUnlink: ['google.com'],
            })),
            makeCandidate('mfa-bad-enrollmentTime', () => ({
              multiFactor: {
                enrolledFactors: [
                  {
                    uid: 'f1',
                    factorId: 'phone',
                    phoneNumber: '+15555550199',
                    enrollmentTime: 'not-a-utc-date',
                  },
                ],
              },
            })),
          ]),
        },
      ],
    }),
    getUser: methodSchema({
      name: 'getUser',
      parameters: [{ name: 'uid', validValue: () => seed.existingUid, schema: uidWithMissing }],
    }),
    getUserByEmail: methodSchema({
      name: 'getUserByEmail',
      parameters: [
        {
          name: 'email',
          validValue: () => seed.existingEmail,
          schema: buildEmailFieldSchema([
            makeCandidate('missing-email', () => 'nobody@example.com'),
          ]),
        },
      ],
    }),
    getUserByPhoneNumber: methodSchema({
      name: 'getUserByPhoneNumber',
      parameters: [
        { name: 'phoneNumber', validValue: () => '+15555550100', schema: buildPhoneFieldSchema() },
      ],
    }),
    getUsers: methodSchema({
      name: 'getUsers',
      parameters: [
        {
          name: 'identifiers',
          validValue: () => [{ uid: seed.existingUid }],
          schema: boundedArraySchema({
            maxLength: 100,
            createValidElement: (index) => ({ uid: `batch-u-${index}` }),
            itemSchema: scalarSchema({
              extraCandidates: () => [
                makeCandidate('id={uid:""}', () => ({ uid: '' })),
                makeCandidate('id={uid:len129}', () => ({ uid: 'x'.repeat(129) })),
                makeCandidate('id={email:"bad"}', () => ({ email: 'bad' })),
                makeCandidate('id={email:valid}', () => ({ email: seed.existingEmail })),
                makeCandidate('id={phoneNumber:"bad"}', () => ({ phoneNumber: 'bad' })),
                makeCandidate('id={phoneNumber:valid}', () => ({ phoneNumber: '+15555550100' })),
                makeCandidate('id={providerId:"",providerUid:"u"}', () => ({
                  providerId: '',
                  providerUid: 'u',
                })),
                makeCandidate('id={providerId:"google.com",providerUid:""}', () => ({
                  providerId: 'google.com',
                  providerUid: '',
                })),
                makeCandidate('id={providerId:"google.com",providerUid:"u"}', () => ({
                  providerId: 'google.com',
                  providerUid: 'u',
                })),
              ],
            }),
          }),
        },
      ],
    }),
    deleteUser: methodSchema({
      name: 'deleteUser',
      parameters: [{ name: 'uid', validValue: () => seed.existingUid, schema: uidWithMissing }],
    }),
    deleteUsers: methodSchema({
      name: 'deleteUsers',
      parameters: [
        {
          name: 'uids',
          validValue: () => [seed.existingUid],
          schema: boundedArraySchema({
            maxLength: 1000,
            createValidElement: (index) => `del-u-${index}`,
            itemSchema: buildUidFieldSchema(),
          }),
        },
      ],
    }),
    listUsers: methodSchema({
      name: 'listUsers',
      parameters: [
        {
          name: 'maxResults',
          validValue: () => 10,
          omitTrailingUndefined: true,
          schema: scalarSchema({
            extraCandidates: () => [
              makeCandidate('maxResults=-1', () => -1),
              makeCandidate('maxResults=1.5', () => 1.5),
              makeCandidate('maxResults=1000', () => 1000),
              makeCandidate('maxResults=1001', () => 1001),
              makeCandidate('maxResults=Infinity', () => Number.POSITIVE_INFINITY),
            ],
          }),
        },
        {
          name: 'pageToken',
          validValue: () => seed.validPageToken,
          omitTrailingUndefined: true,
          schema: scalarSchema({
            extraCandidates: () => [
              makeCandidate('invalid-cursor-token', () => 'not-a-valid-cursor'),
            ],
          }),
        },
      ],
    }),
    verifyIdToken: methodSchema({
      name: 'verifyIdToken',
      parameters: [
        {
          name: 'idToken',
          validValue: () => seed.validIdToken,
          schema: scalarSchema({
            extraCandidates: () => [
              makeCandidate('expired-id-token', () => seed.expiredIdToken),
              makeCandidate('wrong-aud-id-token', () => seed.wrongAudIdToken),
              makeCandidate('custom-token', () => seed.customToken),
              makeCandidate('session-cookie-jwt', () => seed.validSessionCookieJwt),
              makeCandidate('malformed-jwt', () => 'eyJhbGciOi.eyJzdWIiOi.sig'),
            ],
          }),
        },
        {
          name: 'checkRevoked',
          validValue: () => false,
          omitTrailingUndefined: true,
          schema: scalarSchema(),
        },
      ],
    }),
    revokeRefreshTokens: methodSchema({
      name: 'revokeRefreshTokens',
      parameters: [{ name: 'uid', validValue: () => seed.existingUid, schema: uidWithMissing }],
    }),
    createSessionCookie: methodSchema({
      name: 'createSessionCookie',
      parameters: [
        { name: 'idToken', validValue: () => seed.validIdToken, schema: scalarSchema() },
        {
          name: 'sessionCookieOptions',
          validValue: () => ({ expiresIn: 60 * 60 * 1000 }),
          schema: objectSchema({
            validBase: () => ({ expiresIn: 60 * 60 * 1000 }),
            fields: {
              expiresIn: scalarSchema({
                extraCandidates: () => [
                  makeCandidate('expiresIn=299000', () => 299_000),
                  makeCandidate('expiresIn=300000', () => 300_000),
                  makeCandidate('expiresIn=1209600000', () => 1_209_600_000),
                  makeCandidate('expiresIn=1209601000', () => 1_209_601_000),
                ],
              }),
            },
          }),
        },
      ],
    }),
    verifySessionCookie: methodSchema({
      name: 'verifySessionCookie',
      parameters: [
        {
          name: 'sessionCookie',
          validValue: () => seed.validSessionCookieJwt,
          schema: scalarSchema({
            extraCandidates: () => [
              makeCandidate('id-token-instead-of-cookie', () => seed.validIdToken),
              makeCandidate('custom-token', () => seed.customToken),
              makeCandidate('malformed-jwt', () => 'eyJhbGciOi.eyJzdWIiOi.sig'),
            ],
          }),
        },
        {
          name: 'checkRevoked',
          validValue: () => false,
          omitTrailingUndefined: true,
          schema: scalarSchema(),
        },
      ],
    }),
    generatePasswordResetLink: methodSchema({
      name: 'generatePasswordResetLink',
      parameters: [
        { name: 'email', validValue: () => seed.existingEmail, schema: buildEmailFieldSchema() },
        {
          name: 'actionCodeSettings',
          validValue: () => ({ url: 'https://example.com/reset' }),
          omitTrailingUndefined: true,
          schema: actionCodeSettingsSchema,
        },
      ],
    }),
    generateEmailVerificationLink: methodSchema({
      name: 'generateEmailVerificationLink',
      parameters: [
        { name: 'email', validValue: () => seed.existingEmail, schema: buildEmailFieldSchema() },
        {
          name: 'actionCodeSettings',
          validValue: () => ({ url: 'https://example.com/verify' }),
          omitTrailingUndefined: true,
          schema: actionCodeSettingsSchema,
        },
      ],
    }),
    generateSignInWithEmailLink: methodSchema({
      name: 'generateSignInWithEmailLink',
      parameters: [
        { name: 'email', validValue: () => seed.existingEmail, schema: buildEmailFieldSchema() },
        {
          name: 'actionCodeSettings',
          validValue: () => ({ url: 'https://example.com/signin', handleCodeInApp: true }),
          schema: actionCodeSettingsSchema,
        },
      ],
    }),
    generateVerifyAndChangeEmailLink: methodSchema({
      name: 'generateVerifyAndChangeEmailLink',
      parameters: [
        { name: 'email', validValue: () => seed.existingEmail, schema: buildEmailFieldSchema() },
        { name: 'newEmail', validValue: () => 'changed@example.com', schema: buildEmailFieldSchema() },
        {
          name: 'actionCodeSettings',
          validValue: () => ({ url: 'https://example.com/change' }),
          omitTrailingUndefined: true,
          schema: actionCodeSettingsSchema,
        },
      ],
    }),
  };
}
