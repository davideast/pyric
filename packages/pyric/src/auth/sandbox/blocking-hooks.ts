/**
 * Identity Platform blocking-function hook contract (`beforeUserCreated`,
 * `beforeUserSignedIn`, `beforeEmailSent`, `beforeSmsSent`) and response
 * application primitives for `pyric/auth`.
 */
import { assertNoReservedCustomClaims } from 'pyric/sandbox/internal';
import { makeAuthError } from '../auth-errors.js';
import type { StoredUser } from '../sandbox-backend-types.js';
import { SandboxBackend } from '../sandbox-backend.js';
import { targetOf } from '../target.js';
import type { Auth } from '../types.js';

export interface AuthBlockingProviderInfo {
  uid: string;
  providerId: string;
  displayName?: string | null;
  email?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
}

export interface AuthBlockingUserCandidate {
  uid: string;
  email?: string | null;
  emailVerified: boolean;
  displayName?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
  disabled: boolean;
  creationTime: string;
  lastSignInTime: string | null;
  providerData: AuthBlockingProviderInfo[];
  customClaims?: Record<string, unknown>;
  tenantId?: string | null;
  tokensValidAfterSeconds?: number | null;
}

export interface AuthBlockingCredentialContext {
  claims?: Record<string, unknown>;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  expirationTime?: string;
  secret?: string;
}

export interface AuthBlockingClientContext {
  locale?: string;
  ipAddress?: string;
  userAgent?: string;
  recaptchaScore?: number;
  rawUserInfo?: string | Record<string, unknown>;
  credential?: AuthBlockingCredentialContext;
}

export interface BeforeCreateHookResult {
  displayName?: string;
  disabled?: boolean;
  emailVerified?: boolean;
  photoURL?: string;
  customClaims?: Record<string, unknown>;
  recaptchaActionOverride?: 'ALLOW' | 'BLOCK';
}

export interface BeforeSignInHookResult extends BeforeCreateHookResult {
  sessionClaims?: Record<string, unknown>;
}

export interface BeforeEmailHookResult {
  recaptchaActionOverride?: 'ALLOW' | 'BLOCK';
}

export interface BeforeSmsHookResult {
  recaptchaActionOverride?: 'ALLOW' | 'BLOCK';
}

export interface AuthBlockingCreateHookInput {
  userRecord: AuthBlockingUserCandidate;
  signInMethod: string;
  tenantId: string | null;
  client?: AuthBlockingClientContext;
}

export interface AuthBlockingSignInHookInput {
  userRecord: AuthBlockingUserCandidate;
  signInMethod: string;
  tenantId: string | null;
  client?: AuthBlockingClientContext;
}

export interface AuthBlockingEmailHookInput {
  email: string;
  emailType: 'EMAIL_SIGN_IN' | 'PASSWORD_RESET';
  tenantId: string | null;
  userRecord?: AuthBlockingUserCandidate;
  client?: AuthBlockingClientContext;
}

export interface AuthBlockingSmsHookInput {
  phoneNumber: string;
  smsType: 'SIGN_IN_OR_SIGN_UP' | 'MULTI_FACTOR_SIGN_IN' | 'MULTI_FACTOR_ENROLLMENT';
  tenantId: string | null;
  userRecord?: AuthBlockingUserCandidate;
  client?: AuthBlockingClientContext;
}

export interface AuthBlockingHooks {
  beforeCreate?(input: AuthBlockingCreateHookInput): Promise<BeforeCreateHookResult | void>;
  beforeSignIn?(input: AuthBlockingSignInHookInput): Promise<BeforeSignInHookResult | void>;
  beforeSendEmail?(input: AuthBlockingEmailHookInput): Promise<BeforeEmailHookResult | void>;
  beforeSendSms?(input: AuthBlockingSmsHookInput): Promise<BeforeSmsHookResult | void>;
}

/** Format a blocking function rejection with `@firebase/auth` `BLOCKING_FUNCTION_ERROR_RESPONSE` parity. */
export function makeAuthBlockingRejectionError(payload: {
  status: string;
  message: string;
  details?: unknown;
}): Error {
  const errorBody: Record<string, unknown> = {
    message: payload.message,
    status: payload.status,
  };
  if (payload.details !== undefined) {
    errorBody.details = payload.details;
  }
  const serialized = JSON.stringify({ error: errorBody });
  return makeAuthError(
    'auth/internal-error',
    `HTTP Cloud Function returned an error: ${serialized}`,
  );
}

export function setAuthBlockingHooks(auth: Auth, hooks: AuthBlockingHooks | null): void {
  const store = SandboxBackend.projectStoreOf(targetOf(auth).backend);
  store.blockingHooks = hooks;
}

export function getAuthBlockingHooks(auth: Auth): AuthBlockingHooks | null {
  const store = SandboxBackend.projectStoreOf(targetOf(auth).backend);
  return (store.blockingHooks as AuthBlockingHooks | null) ?? null;
}

export function hasBeforeCreateHook(auth: Auth): boolean {
  return typeof getAuthBlockingHooks(auth)?.beforeCreate === 'function';
}

export function hasBeforeSignInHook(auth: Auth): boolean {
  return typeof getAuthBlockingHooks(auth)?.beforeSignIn === 'function';
}

const DISALLOWED_BLOCKING_CLAIMS: readonly string[] = [
  'acr',
  'amr',
  'at_hash',
  'aud',
  'auth_time',
  'azp',
  'cnf',
  'c_hash',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'nonce',
  'sub',
  'firebase',
];

const BLOCKING_CLAIMS_MAX_PAYLOAD_SIZE = 1000;

export function validateBlockingClaimsPayload(
  claims: unknown,
  fieldName: 'customClaims' | 'sessionClaims',
): Record<string, unknown> {
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw makeAuthBlockingRejectionError({
      status: 'INVALID_ARGUMENT',
      message: `The ${fieldName} payload must be a plain object.`,
    });
  }
  const record = claims as Record<string, unknown>;
  const reserved = DISALLOWED_BLOCKING_CLAIMS.filter((claim) =>
    Object.prototype.hasOwnProperty.call(record, claim),
  );
  if (reserved.length > 0) {
    throw makeAuthBlockingRejectionError({
      status: 'INVALID_ARGUMENT',
      message: `The ${fieldName} claims "${reserved.join(',')}" are reserved and cannot be specified.`,
    });
  }
  assertNoReservedCustomClaims(record);
  if (JSON.stringify(record).length > BLOCKING_CLAIMS_MAX_PAYLOAD_SIZE) {
    throw makeAuthBlockingRejectionError({
      status: 'INVALID_ARGUMENT',
      message: `The ${fieldName} payload should not exceed ${BLOCKING_CLAIMS_MAX_PAYLOAD_SIZE} characters.`,
    });
  }
  return structuredClone(record);
}

export function validateCombinedBlockingClaimsPayload(
  customClaims: Record<string, unknown> | undefined,
  sessionClaims: Record<string, unknown> | undefined,
): void {
  if (sessionClaims === undefined) return;
  const combined = {
    ...(customClaims ?? {}),
    ...sessionClaims,
  };
  if (JSON.stringify(combined).length > BLOCKING_CLAIMS_MAX_PAYLOAD_SIZE) {
    throw makeAuthBlockingRejectionError({
      status: 'INVALID_ARGUMENT',
      message: `The customClaims and sessionClaims payloads should not exceed ${BLOCKING_CLAIMS_MAX_PAYLOAD_SIZE} characters combined.`,
    });
  }
}

export function applyBeforeCreateResponseToInit(
  base: Partial<StoredUser> & { uid: string },
  response: BeforeCreateHookResult | void,
): { init: Partial<StoredUser> & { uid: string }; clearPhotoUrl: boolean } {
  const next: Partial<StoredUser> & { uid: string } = { ...base };
  let clearPhotoUrl = false;
  if (!response) {
    return { init: next, clearPhotoUrl };
  }
  if (response.displayName !== undefined) {
    if (response.displayName.length === 0) {
      next.displayName = null;
    } else {
      next.displayName = response.displayName;
    }
  }
  if (response.photoURL !== undefined) {
    if (response.photoURL.length === 0) {
      next.photoUrl = null;
      clearPhotoUrl = true;
    } else {
      next.photoUrl = response.photoURL;
    }
  }
  if (response.emailVerified !== undefined) {
    next.emailVerified = response.emailVerified;
  }
  if (response.disabled !== undefined) {
    next.disabled = response.disabled;
  }
  if (response.customClaims !== undefined) {
    next.customClaims = validateBlockingClaimsPayload(response.customClaims, 'customClaims');
  }
  if (
    response.recaptchaActionOverride !== undefined &&
    response.recaptchaActionOverride !== 'ALLOW' &&
    response.recaptchaActionOverride !== 'BLOCK'
  ) {
    throw makeAuthBlockingRejectionError({
      status: 'INVALID_ARGUMENT',
      message: 'recaptchaActionOverride must be "ALLOW" or "BLOCK".',
    });
  }
  return { init: next, clearPhotoUrl };
}
