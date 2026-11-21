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
    next.displayName = response.displayName.length === 0 ? null : response.displayName;
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
    assertNoReservedCustomClaims(response.customClaims);
    next.customClaims = structuredClone(response.customClaims);
  }
  return { init: next, clearPhotoUrl };
}
