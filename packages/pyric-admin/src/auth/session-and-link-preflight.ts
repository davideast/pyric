/**
 * Client-preflight argument validators for unmodeled `pyric-admin/auth`
 * batch user, phone lookup, and out-of-band email action-link methods
 * (`firebase-admin/auth`).
 */

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
import type { BaseAuthDelegate } from './types.js';
import type { UserRecord } from './user-record.js';
import { FirebaseAuthError } from './verify-token.js';

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
        'missing-android-package-name',
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
