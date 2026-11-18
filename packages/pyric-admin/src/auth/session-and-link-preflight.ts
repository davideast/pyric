/**
 * Client-preflight argument validators for `pyric-admin/auth` session cookies
 * and out-of-band email action-link generators (`firebase-admin/auth` v13.10.0).
 */

import {
  CUSTOM_TOKEN_AUDIENCE,
  JWS_SHAPE,
  latin1FromBase64url,
  utf8FromBase64url,
} from 'pyric/sandbox/internal';
import type { PyricAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import {
  assertDeleteUsersPreflight,
  assertGetUsersPreflight,
  assertPhoneNumberPreflight,
  isClientEmail,
  isNonEmptyString,
  isNonNullPlainRecord,
  isWebUrl,
} from './preflight-validation.js';
import type { BaseAuthDelegate, DecodedIdToken } from './types.js';
import type { UserRecord } from './user-record.js';
import { idTokenProjectId } from './validation.js';
import { FirebaseAuthError } from './verify-token.js';

const SESSION_COOKIE_ISSUER_PREFIX = 'https://session.firebase.google.com/';
const MIN_SESSION_COOKIE_DURATION_SEC = 5 * 60;
const MAX_SESSION_COOKIE_DURATION_SEC = 14 * 24 * 60 * 60;

function isValidSessionCookieDurationMs(expiresIn: unknown): expiresIn is number {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return false;
  }
  const durationSec = Math.floor(expiresIn / 1000);
  return (
    durationSec >= MIN_SESSION_COOKIE_DURATION_SEC &&
    durationSec <= MAX_SESSION_COOKIE_DURATION_SEC
  );
}

function assertCreateSessionCookiePreflight(idToken: unknown, options: unknown): void {
  if (!isNonNullPlainRecord(options) || !isValidSessionCookieDurationMs(options.expiresIn)) {
    throw new FirebaseAuthError(
      'invalid-session-cookie-duration',
      'The session cookie duration must be a valid number in milliseconds between 5 minutes and 2 weeks.',
    );
  }
  if (!isNonEmptyString(idToken)) {
    throw new FirebaseAuthError(
      'invalid-id-token',
      'The provided ID token is not a valid Firebase ID token.',
    );
  }
}

function assertVerifySessionCookiePreflight(
  sessionCookie: unknown,
  projectId: string,
): void {
  if (typeof sessionCookie !== 'string') {
    throw new FirebaseAuthError(
      'argument-error',
      'First argument to verifySessionCookie() must be a Firebase session cookie string.',
    );
  }
  if (!JWS_SHAPE.test(sessionCookie)) {
    throw new FirebaseAuthError(
      'argument-error',
      'Decoding Firebase session cookie failed. Make sure you passed the entire string JWT.',
    );
  }
  const parts = sessionCookie.split('.');
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(latin1FromBase64url(parts[0] ?? ''));
    payload = JSON.parse(utf8FromBase64url(parts[1] ?? ''));
  } catch {
    throw new FirebaseAuthError(
      'argument-error',
      'Decoding Firebase session cookie failed. Make sure you passed the entire string JWT.',
    );
  }
  if (!isNonNullPlainRecord(header) || !isNonNullPlainRecord(payload)) {
    throw new FirebaseAuthError(
      'argument-error',
      'Decoding Firebase session cookie failed. Make sure you passed the entire string JWT.',
    );
  }
  if (header.kid === undefined) {
    if (payload.aud === CUSTOM_TOKEN_AUDIENCE) {
      throw new FirebaseAuthError(
        'argument-error',
        'verifySessionCookie() expects a session cookie, but was given a custom token.',
      );
    }
    throw new FirebaseAuthError('argument-error', 'Firebase session cookie has no "kid" claim.');
  }
  if (header.alg !== 'RS256') {
    throw new FirebaseAuthError(
      'argument-error',
      `Firebase session cookie has incorrect algorithm. Expected "RS256" but got "${String(header.alg)}".`,
    );
  }
  if (payload.aud !== projectId) {
    throw new FirebaseAuthError(
      'argument-error',
      'Firebase session cookie has incorrect "aud" (audience) claim.',
    );
  }
  if (payload.iss !== `${SESSION_COOKIE_ISSUER_PREFIX}${projectId}`) {
    throw new FirebaseAuthError(
      'argument-error',
      'Firebase session cookie has incorrect "iss" (issuer) claim.',
    );
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) {
    throw new FirebaseAuthError('argument-error', 'Firebase session cookie has an invalid "sub" claim.');
  }
}

function assertActionCodeSettingsPreflight(actionCodeSettings: unknown): void {
  if (!isNonNullPlainRecord(actionCodeSettings)) {
    throw new FirebaseAuthError('argument-error', '"ActionCodeSettings" must be a non-null object.');
  }
  if (actionCodeSettings.url === undefined) {
    throw new FirebaseAuthError(
      'missing-continue-uri',
      'A continue URL must be provided in the request.',
    );
  }
  if (!isWebUrl(actionCodeSettings.url)) {
    throw new FirebaseAuthError(
      'invalid-continue-uri',
      'The continue URL provided in the request is invalid.',
    );
  }
  if (
    actionCodeSettings.handleCodeInApp !== undefined &&
    typeof actionCodeSettings.handleCodeInApp !== 'boolean'
  ) {
    throw new FirebaseAuthError(
      'argument-error',
      '"ActionCodeSettings.handleCodeInApp" must be a boolean.',
    );
  }
  if (
    actionCodeSettings.dynamicLinkDomain !== undefined &&
    !isNonEmptyString(actionCodeSettings.dynamicLinkDomain)
  ) {
    throw new FirebaseAuthError(
      'invalid-dynamic-link-domain',
      'The provided dynamic link domain is not configured or authorized for the current project.',
    );
  }
  if (actionCodeSettings.linkDomain !== undefined && !isNonEmptyString(actionCodeSettings.linkDomain)) {
    throw new FirebaseAuthError(
      'invalid-hosting-link-domain',
      'The provided hosting link domain is not configured in Firebase Hosting.',
    );
  }
  if (actionCodeSettings.iOS !== undefined) {
    if (!isNonNullPlainRecord(actionCodeSettings.iOS)) {
      throw new FirebaseAuthError(
        'argument-error',
        '"ActionCodeSettings.iOS" must be a valid non-null object.',
      );
    }
    if (actionCodeSettings.iOS.bundleId === undefined) {
      throw new FirebaseAuthError(
        'missing-ios-bundle-id',
        'The request is missing an iOS Bundle ID.',
      );
    }
    if (!isNonEmptyString(actionCodeSettings.iOS.bundleId)) {
      throw new FirebaseAuthError(
        'argument-error',
        '"ActionCodeSettings.iOS.bundleId" must be a valid non-empty string.',
      );
    }
  }
  if (actionCodeSettings.android !== undefined) {
    if (!isNonNullPlainRecord(actionCodeSettings.android)) {
      throw new FirebaseAuthError(
        'argument-error',
        '"ActionCodeSettings.android" must be a valid non-null object.',
      );
    }
    if (actionCodeSettings.android.packageName === undefined) {
      throw new FirebaseAuthError(
        'missing-android-pkg-name',
        'An Android Package Name must be provided if the Android App is required to be installed.',
      );
    }
    if (!isNonEmptyString(actionCodeSettings.android.packageName)) {
      throw new FirebaseAuthError(
        'argument-error',
        '"ActionCodeSettings.android.packageName" must be a valid non-empty string.',
      );
    }
    if (
      actionCodeSettings.android.minimumVersion !== undefined &&
      !isNonEmptyString(actionCodeSettings.android.minimumVersion)
    ) {
      throw new FirebaseAuthError(
        'argument-error',
        '"ActionCodeSettings.android.minimumVersion" must be a valid non-empty string.',
      );
    }
    if (
      actionCodeSettings.android.installApp !== undefined &&
      typeof actionCodeSettings.android.installApp !== 'boolean'
    ) {
      throw new FirebaseAuthError(
        'argument-error',
        '"ActionCodeSettings.android.installApp" must be a valid boolean.',
      );
    }
  }
}

function assertEmailActionLinkPreflight(
  requestType: 'PASSWORD_RESET' | 'VERIFY_EMAIL' | 'EMAIL_SIGNIN' | 'VERIFY_AND_CHANGE_EMAIL',
  email: unknown,
  actionCodeSettings?: unknown,
  newEmail?: unknown,
): void {
  if (requestType === 'EMAIL_SIGNIN' && actionCodeSettings === undefined) {
    throw new FirebaseAuthError(
      'argument-error',
      "`actionCodeSettings` is required when `requestType` === 'EMAIL_SIGNIN'",
    );
  }
  if (actionCodeSettings !== undefined || requestType === 'EMAIL_SIGNIN') {
    assertActionCodeSettingsPreflight(actionCodeSettings);
  }
  if (requestType === 'VERIFY_AND_CHANGE_EMAIL' && newEmail === undefined) {
    throw new FirebaseAuthError(
      'argument-error',
      "`newEmail` is required when `requestType` === 'VERIFY_AND_CHANGE_EMAIL'",
    );
  }
  if (!isClientEmail(email)) {
    throw new FirebaseAuthError('invalid-email', 'The email address is improperly formatted.');
  }
  if (newEmail !== undefined && !isClientEmail(newEmail)) {
    throw new FirebaseAuthError('invalid-new-email', 'The new email address is improperly formatted.');
  }
}

type UnmodeledAuthMethodNames =
  | 'getUserByPhoneNumber'
  | 'getUserByProviderUid'
  | 'getUsers'
  | 'deleteUsers'
  | 'importUsers'
  | 'createSessionCookie'
  | 'verifySessionCookie'
  | 'generatePasswordResetLink'
  | 'generateEmailVerificationLink'
  | 'generateSignInWithEmailLink'
  | 'generateVerifyAndChangeEmailLink'
  | 'createProviderConfig'
  | 'getProviderConfig'
  | 'listProviderConfigs'
  | 'updateProviderConfig'
  | 'deleteProviderConfig';

export function buildUnmodeledAuthPreflightMethods(
  app: PyricAdminApp,
  notImplemented: (method: string) => Error,
): Pick<BaseAuthDelegate, UnmodeledAuthMethodNames> {
  return {
    getUserByPhoneNumber(phoneNumber?: unknown): Promise<UserRecord> {
      assertAdminAppActive(app);
      try {
        assertPhoneNumberPreflight(phoneNumber);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('getUserByPhoneNumber'));
    },
    getUserByProviderUid(): Promise<UserRecord> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('getUserByProviderUid'));
    },
    getUsers(identifiers?: unknown): Promise<unknown> {
      assertAdminAppActive(app);
      assertGetUsersPreflight(identifiers);
      return Promise.reject(notImplemented('getUsers'));
    },
    deleteUsers(uids?: unknown): Promise<unknown> {
      assertAdminAppActive(app);
      assertDeleteUsersPreflight(uids);
      return Promise.reject(notImplemented('deleteUsers'));
    },
    importUsers(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('importUsers'));
    },
    createSessionCookie(idToken?: unknown, sessionCookieOptions?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertCreateSessionCookiePreflight(idToken, sessionCookieOptions);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('createSessionCookie'));
    },
    verifySessionCookie(sessionCookie?: unknown): Promise<DecodedIdToken> {
      assertAdminAppActive(app);
      if (typeof sessionCookie !== 'string') {
        throw new FirebaseAuthError(
          'argument-error',
          'First argument to verifySessionCookie() must be a Firebase session cookie string.',
        );
      }
      try {
        assertVerifySessionCookiePreflight(sessionCookie, idTokenProjectId(app));
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('verifySessionCookie'));
    },
    generatePasswordResetLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight('PASSWORD_RESET', email, actionCodeSettings);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generatePasswordResetLink'));
    },
    generateEmailVerificationLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight('VERIFY_EMAIL', email, actionCodeSettings);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generateEmailVerificationLink'));
    },
    generateSignInWithEmailLink(email?: unknown, actionCodeSettings?: unknown): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight('EMAIL_SIGNIN', email, actionCodeSettings);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generateSignInWithEmailLink'));
    },
    generateVerifyAndChangeEmailLink(
      email?: unknown,
      newEmail?: unknown,
      actionCodeSettings?: unknown,
    ): Promise<string> {
      assertAdminAppActive(app);
      try {
        assertEmailActionLinkPreflight(
          'VERIFY_AND_CHANGE_EMAIL',
          email,
          actionCodeSettings,
          newEmail,
        );
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.reject(notImplemented('generateVerifyAndChangeEmailLink'));
    },
    createProviderConfig(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('createProviderConfig'));
    },
    getProviderConfig(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('getProviderConfig'));
    },
    listProviderConfigs(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('listProviderConfigs'));
    },
    updateProviderConfig(): Promise<unknown> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('updateProviderConfig'));
    },
    deleteProviderConfig(): Promise<void> {
      assertAdminAppActive(app);
      return Promise.reject(notImplemented('deleteProviderConfig'));
    },
  };
}
