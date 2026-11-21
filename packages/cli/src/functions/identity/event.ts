/**
 * `AuthBlockingEvent` encoder, `AuthUserRecord` builder, and GCIP JWT encoder
 * for `firebase-functions/v2/identity` (`7.2.5`).
 *
 * Matches `lib/common/providers/identity.js` (`parseAuthUserRecord` and
 * `parseAuthEventContext`).
 */
import type { IdentityBlockingEventType, IdentityBlockingOptions } from './discovery.js';
import { shortIdentityEventType } from './discovery.js';

export type IdentityEmailType =
  | 'EMAIL_SIGN_IN'
  | 'PASSWORD_RESET'
  | 'VERIFY_EMAIL'
  | 'VERIFY_AND_CHANGE_EMAIL'
  | 'REVERT_SECOND_FACTOR_ADDITION';
export type IdentitySmsType =
  | 'SIGN_IN_OR_SIGN_UP'
  | 'MULTI_FACTOR_SIGN_IN'
  | 'MULTI_FACTOR_ENROLLMENT';

interface IdentityProviderDataInput {
  uid: string;
  providerId: string;
  displayName?: string | null;
  email?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
}

interface IdentityMultiFactorInput {
  uid: string;
  factorId?: string;
  displayName?: string;
  enrollmentTime?: string | number | null;
  phoneNumber?: string;
}

export interface IdentityUserRecordInput {
  uid: string;
  email?: string | null;
  emailVerified?: boolean;
  displayName?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
  disabled?: boolean;
  creationTime?: string | number | null;
  lastSignInTime?: string | number | null;
  providerData?: readonly IdentityProviderDataInput[];
  passwordHash?: string;
  passwordSalt?: string;
  customClaims?: Record<string, unknown>;
  tenantId?: string | null;
  tokensValidAfterSeconds?: number | null;
  enrolledFactors?: readonly IdentityMultiFactorInput[];
}

export interface IdentityRawCredentialInput {
  claims?: Record<string, unknown>;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  expirationTime?: string;
  secret?: string;
}

export interface BuildAuthBlockingEventOptions {
  eventId: string;
  eventType: IdentityBlockingEventType;
  projectId: string;
  timestampMs: number;
  signInMethod?: string;
  tenantId?: string | null;
  locale?: string;
  ipAddress?: string;
  userAgent?: string;
  recaptchaScore?: number;
  email?: string;
  phoneNumber?: string;
  emailType?: IdentityEmailType;
  smsType?: IdentitySmsType;
  rawUserInfo?: string | Record<string, unknown>;
  credential?: IdentityRawCredentialInput;
  blockingOptions?: IdentityBlockingOptions;
  userRecord?: IdentityUserRecordInput;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: string | null | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

function toUtcTimestampOrNull(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toUTCString();
}

function parseTokensValidAfterUtc(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds === 0) {
    return null;
  }
  const parsed = new Date(seconds * 1000);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toUTCString();
}

function buildMultiFactor(
  factors: readonly IdentityMultiFactorInput[] | undefined,
): { enrolledFactors: Array<Record<string, unknown>> } | null {
  if (!factors || factors.length === 0) return null;
  const enrolledFactors: Array<Record<string, unknown>> = [];
  for (const factor of factors) {
    let resolvedFactorId = factor.factorId ?? '';
    if (factor.phoneNumber && !factor.factorId) {
      resolvedFactorId = 'phone';
    }
    enrolledFactors.push({
      uid: factor.uid,
      factorId: resolvedFactorId,
      displayName: factor.displayName,
      enrollmentTime: toUtcTimestampOrNull(factor.enrollmentTime),
      phoneNumber: factor.phoneNumber,
    });
  }
  return { enrolledFactors };
}

/** Build an upstream-shaped `AuthUserRecord` matching `parseAuthUserRecord`. */
function buildAuthUserRecord(input: IdentityUserRecordInput): Record<string, unknown> {
  if (!input.uid) {
    const err = new Error('INTERNAL ASSERT FAILED: Invalid user response') as Error & {
      code: string;
    };
    err.code = 'internal';
    throw err;
  }
  const providerData: Array<Record<string, unknown>> = [];
  for (const provider of input.providerData ?? []) {
    providerData.push({
      uid: provider.uid,
      displayName: optionalString(provider.displayName),
      email: optionalString(provider.email),
      photoURL: optionalString(provider.photoURL),
      providerId: provider.providerId,
      phoneNumber: optionalString(provider.phoneNumber),
    });
  }
  let tenantId: string | undefined;
  if (typeof input.tenantId === 'string' && input.tenantId.length > 0) {
    tenantId = input.tenantId;
  }
  let customClaims: Record<string, unknown> | undefined;
  if (input.customClaims !== undefined) {
    customClaims = structuredClone(input.customClaims);
  }
  return {
    uid: input.uid,
    email: optionalString(input.email),
    emailVerified: Boolean(input.emailVerified),
    displayName: optionalString(input.displayName),
    photoURL: optionalString(input.photoURL),
    phoneNumber: optionalString(input.phoneNumber),
    disabled: Boolean(input.disabled),
    metadata: {
      creationTime: toUtcTimestampOrNull(input.creationTime),
      lastSignInTime: toUtcTimestampOrNull(input.lastSignInTime),
    },
    providerData,
    passwordHash: input.passwordHash,
    passwordSalt: input.passwordSalt,
    customClaims,
    tenantId,
    tokensValidAfterTime: parseTokensValidAfterUtc(input.tokensValidAfterSeconds),
    multiFactor: buildMultiFactor(input.enrolledFactors),
  };
}

function parseRawProfile(
  rawUserInfo: string | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (rawUserInfo === undefined) return undefined;
  if (typeof rawUserInfo === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawUserInfo);
      if (isPlainRecord(parsed)) return parsed;
    } catch {
      // Matches `parseAdditionalUserInfo` ignoring malformed JSON strings.
    }
    return undefined;
  }
  return structuredClone(rawUserInfo);
}

function buildCredential(
  rawCredential: IdentityRawCredentialInput | undefined,
  blockingOptions: IdentityBlockingOptions,
  signInMethod: string | undefined,
  nowMs: number,
): Record<string, unknown> | null {
  let idToken: string | undefined;
  if (blockingOptions.idToken && typeof rawCredential?.idToken === 'string') {
    idToken = rawCredential.idToken;
  }
  let accessToken: string | undefined;
  if (blockingOptions.accessToken && typeof rawCredential?.accessToken === 'string') {
    accessToken = rawCredential.accessToken;
  }
  let refreshToken: string | undefined;
  if (blockingOptions.refreshToken && typeof rawCredential?.refreshToken === 'string') {
    refreshToken = rawCredential.refreshToken;
  }
  let claims: Record<string, unknown> | undefined;
  if (rawCredential?.claims !== undefined) {
    claims = structuredClone(rawCredential.claims);
  }
  if (!claims && !idToken && !accessToken && !refreshToken) {
    return null;
  }
  let expirationTime = rawCredential?.expirationTime;
  if (
    expirationTime === undefined &&
    typeof rawCredential?.expiresInSeconds === 'number' &&
    rawCredential.expiresInSeconds > 0
  ) {
    expirationTime = new Date(nowMs + rawCredential.expiresInSeconds * 1000).toUTCString();
  }
  let providerId = signInMethod;
  if (signInMethod === 'emailLink') {
    providerId = 'password';
  }
  return {
    claims,
    idToken,
    accessToken,
    refreshToken,
    expirationTime,
    secret: rawCredential?.secret,
    providerId,
    signInMethod,
  };
}

/** Build the complete v2 `AuthBlockingEvent` matching `firebase-functions@7.2.5`. */
export function buildAuthBlockingEvent(
  options: BuildAuthBlockingEventOptions,
): Record<string, unknown> {
  const shortType = shortIdentityEventType(options.eventType);
  const blockingOptions = options.blockingOptions ?? {
    idToken: false,
    accessToken: false,
    refreshToken: false,
  };
  let resolvedTenant: string | undefined;
  if (typeof options.tenantId === 'string' && options.tenantId.length > 0) {
    resolvedTenant = options.tenantId;
  } else if (
    typeof options.userRecord?.tenantId === 'string' &&
    options.userRecord.tenantId.length > 0
  ) {
    resolvedTenant = options.userRecord.tenantId;
  }

  let eventTypeWithMethod: string = options.eventType;
  if (typeof options.signInMethod === 'string' && options.signInMethod.length > 0) {
    eventTypeWithMethod = `${options.eventType}:${options.signInMethod}`;
  }

  let resourceName = `projects/${options.projectId}`;
  if (resolvedTenant !== undefined) {
    resourceName = `projects/${options.projectId}/tenants/${resolvedTenant}`;
  }

  const iatSeconds = Math.floor(options.timestampMs / 1000);
  const timestamp = new Date(iatSeconds * 1000).toUTCString();

  const profile = parseRawProfile(options.rawUserInfo);
  let username: string | undefined;
  if (profile !== undefined) {
    if (options.signInMethod === 'github.com' && typeof profile.login === 'string') {
      username = profile.login;
    } else if (options.signInMethod === 'twitter.com' && typeof profile.screen_name === 'string') {
      username = profile.screen_name;
    }
  }
  let additionalProviderId = options.signInMethod;
  if (options.signInMethod === 'emailLink') {
    additionalProviderId = 'password';
  }

  let effectiveEmail = options.email;
  if (effectiveEmail === undefined && typeof options.userRecord?.email === 'string') {
    effectiveEmail = options.userRecord.email;
  }
  let effectivePhone = options.phoneNumber;
  if (effectivePhone === undefined && typeof options.userRecord?.phoneNumber === 'string') {
    effectivePhone = options.userRecord.phoneNumber;
  }

  const hasUserRecord = options.userRecord !== undefined;
  const authType = hasUserRecord ? 'USER' : 'UNAUTHENTICATED';
  let data: Record<string, unknown> | undefined;
  if (
    hasUserRecord &&
    (shortType === 'beforeCreate' || shortType === 'beforeSignIn') &&
    options.userRecord !== undefined
  ) {
    data = buildAuthUserRecord(options.userRecord);
  }

  return {
    locale: options.locale,
    ipAddress: options.ipAddress ?? '127.0.0.1',
    userAgent: options.userAgent ?? '',
    eventId: options.eventId,
    eventType: eventTypeWithMethod,
    authType,
    resource: {
      service: 'identitytoolkit.googleapis.com',
      name: resourceName,
    },
    timestamp,
    additionalUserInfo: {
      providerId: additionalProviderId,
      profile,
      username,
      isNewUser: shortType === 'beforeCreate',
      recaptchaScore: options.recaptchaScore,
      email: effectiveEmail,
      phoneNumber: effectivePhone,
    },
    credential: buildCredential(
      options.credential,
      blockingOptions,
      options.signInMethod,
      options.timestampMs,
    ),
    emailType: options.emailType,
    smsType: options.smsType,
    params: {},
    data,
  };
}

/** Encode an unsigned GCIP Auth Blocking JWT payload for Express-style handlers and parity tests. */
export function buildAuthBlockingJwt(options: BuildAuthBlockingEventOptions): string {
  const shortType = shortIdentityEventType(options.eventType);
  const blockingOptions = options.blockingOptions ?? {
    idToken: false,
    accessToken: false,
    refreshToken: false,
  };
  const iatSeconds = Math.floor(options.timestampMs / 1000);
  const payload: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${options.projectId}`,
    aud: options.projectId,
    sub: options.userRecord?.uid ?? '',
    iat: iatSeconds,
    exp: iatSeconds + 300,
    event_id: options.eventId,
    event_type: shortType,
    ip_address: options.ipAddress ?? '127.0.0.1',
    user_agent: options.userAgent ?? '',
  };
  if (options.locale !== undefined) payload.locale = options.locale;
  if (options.signInMethod !== undefined) payload.sign_in_method = options.signInMethod;
  if (options.tenantId) payload.tenant_id = options.tenantId;
  if (options.recaptchaScore !== undefined) payload.recaptcha_score = options.recaptchaScore;
  const email = options.email ?? optionalString(options.userRecord?.email);
  if (email !== undefined) payload.email = email;
  const phone = options.phoneNumber ?? optionalString(options.userRecord?.phoneNumber);
  if (phone !== undefined) payload.phone_number = phone;
  if (options.emailType !== undefined) payload.email_type = options.emailType;
  if (options.smsType !== undefined) payload.sms_type = options.smsType;
  if (options.rawUserInfo !== undefined) {
    if (typeof options.rawUserInfo === 'string') {
      payload.raw_user_info = options.rawUserInfo;
    } else {
      payload.raw_user_info = JSON.stringify(options.rawUserInfo);
    }
  }
  if (options.credential?.claims !== undefined) {
    payload.sign_in_attributes = options.credential.claims;
  }
  if (blockingOptions.idToken && options.credential?.idToken !== undefined) {
    payload.oauth_id_token = options.credential.idToken;
  }
  if (blockingOptions.accessToken && options.credential?.accessToken !== undefined) {
    payload.oauth_access_token = options.credential.accessToken;
  }
  if (blockingOptions.refreshToken && options.credential?.refreshToken !== undefined) {
    payload.oauth_refresh_token = options.credential.refreshToken;
  }
  if (options.credential?.expiresInSeconds !== undefined) {
    payload.oauth_expires_in = options.credential.expiresInSeconds;
  }
  if (options.credential?.secret !== undefined) {
    payload.oauth_token_secret = options.credential.secret;
  }
  if (options.userRecord !== undefined) {
    const user = options.userRecord;
    const wireRecord: Record<string, unknown> = {
      uid: user.uid,
      email_verified: Boolean(user.emailVerified),
      disabled: Boolean(user.disabled),
      metadata: {
        creation_time: toUtcTimestampOrNull(user.creationTime),
        last_sign_in_time: toUtcTimestampOrNull(user.lastSignInTime),
      },
      provider_data: (user.providerData ?? []).map((entry) => ({
        uid: entry.uid,
        display_name: optionalString(entry.displayName),
        email: optionalString(entry.email),
        photo_url: optionalString(entry.photoURL),
        provider_id: entry.providerId,
        phone_number: optionalString(entry.phoneNumber),
      })),
    };
    if (typeof user.email === 'string') wireRecord.email = user.email;
    if (typeof user.displayName === 'string') wireRecord.display_name = user.displayName;
    if (typeof user.photoURL === 'string') wireRecord.photo_url = user.photoURL;
    if (typeof user.phoneNumber === 'string') wireRecord.phone_number = user.phoneNumber;
    if (user.passwordHash !== undefined) wireRecord.password_hash = user.passwordHash;
    if (user.passwordSalt !== undefined) wireRecord.password_salt = user.passwordSalt;
    if (user.customClaims !== undefined) wireRecord.custom_claims = user.customClaims;
    if (typeof user.tenantId === 'string' && user.tenantId.length > 0) {
      wireRecord.tenant_id = user.tenantId;
    }
    if (user.tokensValidAfterSeconds !== undefined && user.tokensValidAfterSeconds !== null) {
      wireRecord.tokens_valid_after_time = user.tokensValidAfterSeconds;
    }
    if (user.enrolledFactors && user.enrolledFactors.length > 0) {
      wireRecord.multi_factor = {
        enrolled_factors: user.enrolledFactors.map((factor) => ({
          uid: factor.uid,
          factor_id: factor.factorId,
          display_name: factor.displayName,
          enrollment_time: toUtcTimestampOrNull(factor.enrollmentTime),
          phone_number: factor.phoneNumber,
        })),
      };
    }
    payload.user_record = wireRecord;
  }

  const headerSegment = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${headerSegment}.${payloadSegment}.`;
}
