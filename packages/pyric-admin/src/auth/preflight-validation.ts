/**
 * Client-preflight argument validators for `pyric-admin/auth`, matching
 * `firebase-admin/auth` (`v13.10.0`) before any sandbox mutation or
 * unmodeled-backend deferral runs.
 */

import type {
  CreateUserRequest as SandboxCreateUserRequest,
  UpdateUserRequest as SandboxUpdateUserRequest,
} from 'pyric/auth';
import type { CreateRequest, UpdateRequest } from './types.js';
import { FirebaseAuthError, invalidUid } from './verify-token.js';

const CLIENT_EMAIL_RE = /^[^@]+@[^@]+$/;
const STRICT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PHONE_RE = /^\+[1-9]\d{1,14}$/;
const URL_ILLEGAL_CHAR_RE = /[^a-z0-9:/?#[\]@!$&'()*+,;=.\-_~%]/i;
const URL_HOSTNAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
const URL_IPV6_RE = /^\[[a-fA-F0-9:.]+\]$/;
const URL_PATHNAME_RE = /^(\/[\w\-.~!$'()*+,;=:@%]+)*\/?$/;

const MAX_GET_ACCOUNTS_BATCH_SIZE = 100;
const MAX_DELETE_ACCOUNTS_BATCH_SIZE = 1000;

const UNSUPPORTED_UPDATE_KEYS = [
  'multiFactor',
  'providerToLink',
  'providersToUnlink',
] as const;

export function isNonNullPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isClientEmail(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_EMAIL_RE.test(value);
}

function isStrictEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && STRICT_EMAIL_RE.test(value);
}

function isClientPhoneNumber(value: unknown): value is string {
  return typeof value === 'string' && /^\+/.test(value) && /[\da-zA-Z]+/.test(value);
}

function isE164PhoneNumber(value: unknown): value is string {
  return typeof value === 'string' && E164_PHONE_RE.test(value);
}

function isUtcDateString(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  try {
    return new Date(value).toUTCString() === value;
  } catch {
    return false;
  }
}

export function isWebUrl(urlStr: unknown): urlStr is string {
  if (typeof urlStr !== 'string' || URL_ILLEGAL_CHAR_RE.test(urlStr)) {
    return false;
  }
  try {
    const uri = new URL(urlStr);
    if (uri.protocol !== 'http:' && uri.protocol !== 'https:') {
      return false;
    }
    const hostname = uri.hostname;
    if (!URL_HOSTNAME_RE.test(hostname) && !URL_IPV6_RE.test(hostname)) {
      return false;
    }
    const pathname = uri.pathname;
    if (pathname.length > 0 && pathname !== '/' && !URL_PATHNAME_RE.test(pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateMfaEnrollmentFactors(factors: readonly unknown[], isCreate: boolean): void {
  for (const entry of factors) {
    if (isCreate) {
      // `firebase-admin` checks `'enrollmentTime' in entry` and `'uid' in entry`,
      // which throws `TypeError` on `null` or primitive elements.
      const asObject = entry as Record<string, unknown>;
      if ('enrollmentTime' in asObject) {
        throw new FirebaseAuthError(
          'argument-error',
          '"enrollmentTime" is not supported when adding second factors via "createUser()"',
        );
      }
      if ('uid' in asObject) {
        throw new FirebaseAuthError(
          'argument-error',
          '"uid" is not supported when adding second factors via "createUser()"',
        );
      }
    } else if (entry === undefined || entry === null) {
      // `convertMultiFactorInfoToServerFormat` accesses `entry.enrollmentTime`,
      // throwing `TypeError` on `undefined` or `null`.
      throw new TypeError('Cannot read properties of null or undefined (reading "enrollmentTime").');
    }
    let factor: Record<string, unknown> = {};
    if (isNonNullPlainRecord(entry)) {
      factor = entry;
    }
    if (factor.enrollmentTime !== undefined && !isUtcDateString(factor.enrollmentTime)) {
      throw new FirebaseAuthError(
        'invalid-enrollment-time',
        'The second factor "enrollmentTime" must be a valid UTC date string.',
      );
    }
    if (factor.factorId !== 'phone') {
      throw new FirebaseAuthError(
        'unsupported-second-factor',
        'The request specified an unsupported type of second factor.',
      );
    }
    if (factor.uid !== undefined && !isNonEmptyString(factor.uid)) {
      throw new FirebaseAuthError(
        'invalid-uid',
        'The second factor "uid" must be a valid non-empty string.',
      );
    }
    if (factor.displayName !== undefined && typeof factor.displayName !== 'string') {
      throw new FirebaseAuthError(
        'invalid-display-name',
        'The second factor "displayName" must be a valid string.',
      );
    }
    if (factor.phoneNumber !== undefined) {
      if (!isClientPhoneNumber(factor.phoneNumber)) {
        const renderedPhone = String(factor.phoneNumber);
        throw new FirebaseAuthError(
          'invalid-phone-number',
          `The second factor "phoneNumber" for "${renderedPhone}" must be a non-empty E.164 compliant string.`,
        );
      }
    } else {
      throw new FirebaseAuthError('invalid-enrolled-factors', 'MFAInfo object provided is invalid.');
    }
  }
}

export function validateCreateUserPreflight(rawProperties: unknown): CreateRequest {
  if (!isNonNullPlainRecord(rawProperties)) {
    throw new FirebaseAuthError('argument-error', 'Properties argument must be a non-null object.');
  }
  if (isNonNullPlainRecord(rawProperties.multiFactor)) {
    const enrolled = rawProperties.multiFactor.enrolledFactors;
    if (Array.isArray(enrolled) && enrolled.length > 0) {
      validateMfaEnrollmentFactors(enrolled, true);
    }
  }
  if (rawProperties.customAttributes !== undefined) {
    throw new FirebaseAuthError(
      'argument-error',
      '"customAttributes" cannot be set when creating a new user.',
    );
  }
  if (rawProperties.validSince !== undefined) {
    throw new FirebaseAuthError(
      'argument-error',
      '"validSince" cannot be set when creating a new user.',
    );
  }
  if (rawProperties.tenantId !== undefined) {
    throw new FirebaseAuthError(
      'argument-error',
      '"tenantId" is an invalid "CreateRequest" property.',
    );
  }
  if (rawProperties.displayName !== undefined && typeof rawProperties.displayName !== 'string') {
    throw new FirebaseAuthError('invalid-display-name', 'The displayName field must be a valid string.');
  }
  if (rawProperties.uid !== undefined) {
    const uidErr = invalidUid(rawProperties.uid);
    if (uidErr !== null) throw uidErr;
  }
  if (rawProperties.email !== undefined && !isClientEmail(rawProperties.email)) {
    throw new FirebaseAuthError('invalid-email', 'The email address is improperly formatted.');
  }
  if (rawProperties.phoneNumber !== undefined && !isClientPhoneNumber(rawProperties.phoneNumber)) {
    throw new FirebaseAuthError(
      'invalid-phone-number',
      'The phoneNumber must be a non-empty E.164 standard compliant identifier string.',
    );
  }
  if (
    rawProperties.password !== undefined &&
    (typeof rawProperties.password !== 'string' || rawProperties.password.length < 6)
  ) {
    throw new FirebaseAuthError(
      'invalid-password',
      'The password must be a string with at least 6 characters.',
    );
  }
  if (rawProperties.emailVerified !== undefined && typeof rawProperties.emailVerified !== 'boolean') {
    throw new FirebaseAuthError('invalid-email-verified', 'The emailVerified field must be a boolean.');
  }
  if (rawProperties.photoURL !== undefined && !isWebUrl(rawProperties.photoURL)) {
    throw new FirebaseAuthError('invalid-photo-url', 'The photoURL field must be a valid URL.');
  }
  if (rawProperties.disabled !== undefined && typeof rawProperties.disabled !== 'boolean') {
    throw new FirebaseAuthError('invalid-disabled-field', 'The disabled field must be a boolean.');
  }
  // Server-side Identity Toolkit checks run after all client-preflight checks succeed.
  if (rawProperties.email !== undefined && !isStrictEmail(rawProperties.email)) {
    throw new FirebaseAuthError('invalid-email', 'The email address is improperly formatted.');
  }
  if (rawProperties.phoneNumber !== undefined && !isE164PhoneNumber(rawProperties.phoneNumber)) {
    throw new FirebaseAuthError(
      'invalid-phone-number',
      'The phoneNumber must be a non-empty E.164 standard compliant identifier string.',
    );
  }
  return rawProperties as unknown as CreateRequest;
}

export function validateUpdateUserPreflight(
  uid: unknown,
  rawProperties: unknown,
  notImplemented: (method: string) => Error,
): SandboxUpdateUserRequest {
  if (isNonNullPlainRecord(rawProperties)) {
    const link = rawProperties.providerToLink;
    if (Boolean(link)) {
      const linkRecord = link as { providerId?: unknown; uid?: unknown };
      if (linkRecord.providerId === 'email' && rawProperties.email !== undefined) {
        throw new FirebaseAuthError(
          'argument-error',
          "Both UpdateRequest.email and UpdateRequest.providerToLink.providerId='email' were set.",
        );
      }
      if (linkRecord.providerId === 'phone' && rawProperties.phoneNumber !== undefined) {
        throw new FirebaseAuthError(
          'argument-error',
          "Both UpdateRequest.phoneNumber and UpdateRequest.providerToLink.providerId='phone' were set.",
        );
      }
    }
    if (Boolean(rawProperties.providersToUnlink)) {
      const unlinkTarget = rawProperties.providersToUnlink as { indexOf: (v: string) => number };
      if (unlinkTarget.indexOf('phone') !== -1 && rawProperties.phoneNumber === null) {
        throw new FirebaseAuthError(
          'argument-error',
          "Both UpdateRequest.phoneNumber=null and UpdateRequest.providersToUnlink=['phone'] were set.",
        );
      }
    }
  }

  const uidErr = invalidUid(uid);
  if (uidErr !== null) throw uidErr;
  if (!isNonNullPlainRecord(rawProperties)) {
    throw new FirebaseAuthError('argument-error', 'Properties argument must be a non-null object.');
  }

  const rewritten: Record<string, unknown> = { ...rawProperties };
  if (isNonNullPlainRecord(rewritten.providerToLink)) {
    if (rewritten.providerToLink.providerId === 'email') {
      rewritten.email = rewritten.providerToLink.uid;
      delete rewritten.providerToLink;
    } else if (rewritten.providerToLink.providerId === 'phone') {
      rewritten.phoneNumber = rewritten.providerToLink.uid;
      delete rewritten.providerToLink;
    }
  }

  if (isNonNullPlainRecord(rewritten.providerToLink)) {
    if (!isNonEmptyString(rewritten.providerToLink.providerId)) {
      throw new FirebaseAuthError(
        'argument-error',
        'providerToLink.providerId of properties argument must be a non-empty string.',
      );
    }
    if (!isNonEmptyString(rewritten.providerToLink.uid)) {
      throw new FirebaseAuthError(
        'argument-error',
        'providerToLink.uid of properties argument must be a non-empty string.',
      );
    }
  } else if (rewritten.providersToUnlink !== undefined) {
    if (!Array.isArray(rewritten.providersToUnlink)) {
      throw new FirebaseAuthError(
        'argument-error',
        'providersToUnlink of properties argument must be an array of strings.',
      );
    }
    for (const providerId of rewritten.providersToUnlink) {
      if (!isNonEmptyString(providerId)) {
        throw new FirebaseAuthError(
          'argument-error',
          'providersToUnlink of properties argument must be an array of strings.',
        );
      }
    }
  }

  if (rewritten.providerToLink !== undefined && !isNonNullPlainRecord(rewritten.providerToLink)) {
    if (rewritten.providerToLink === null || typeof rewritten.providerToLink !== 'object') {
      // `updateExistingAccount` assigns `request.linkProviderUserInfo.rawId = ...`,
      // throwing `TypeError` on `null` or primitive `providerToLink` values.
      throw new TypeError('Cannot assign "rawId" on non-object providerToLink value.');
    }
  }

  if (isNonNullPlainRecord(rewritten.multiFactor)) {
    const enrolled = rewritten.multiFactor.enrolledFactors;
    if (Array.isArray(enrolled) && enrolled.length > 0) {
      validateMfaEnrollmentFactors(enrolled, false);
    }
  }

  if (rewritten.tenantId !== undefined) {
    throw new FirebaseAuthError(
      'argument-error',
      '"tenantId" is an invalid "UpdateRequest" property.',
    );
  }
  if (
    rewritten.displayName !== undefined &&
    rewritten.displayName !== null &&
    typeof rewritten.displayName !== 'string'
  ) {
    throw new FirebaseAuthError('invalid-display-name', 'The displayName field must be a valid string.');
  }
  if (rewritten.email !== undefined && !isClientEmail(rewritten.email)) {
    throw new FirebaseAuthError('invalid-email', 'The email address is improperly formatted.');
  }
  if (
    rewritten.phoneNumber !== undefined &&
    rewritten.phoneNumber !== null &&
    !isClientPhoneNumber(rewritten.phoneNumber)
  ) {
    throw new FirebaseAuthError(
      'invalid-phone-number',
      'The phoneNumber must be a non-empty E.164 standard compliant identifier string.',
    );
  }
  if (
    rewritten.password !== undefined &&
    (typeof rewritten.password !== 'string' || rewritten.password.length < 6)
  ) {
    throw new FirebaseAuthError(
      'invalid-password',
      'The password must be a string with at least 6 characters.',
    );
  }
  if (rewritten.emailVerified !== undefined && typeof rewritten.emailVerified !== 'boolean') {
    throw new FirebaseAuthError('invalid-email-verified', 'The emailVerified field must be a boolean.');
  }
  if (
    rewritten.photoURL !== undefined &&
    rewritten.photoURL !== null &&
    !isWebUrl(rewritten.photoURL)
  ) {
    throw new FirebaseAuthError('invalid-photo-url', 'The photoURL field must be a valid URL.');
  }
  if (rewritten.disabled !== undefined && typeof rewritten.disabled !== 'boolean') {
    throw new FirebaseAuthError('invalid-disabled-field', 'The disabled field must be a boolean.');
  }

  if (Array.isArray(rewritten.providerToLink)) {
    throw new FirebaseAuthError(
      'invalid-provider-id',
      'The providerId must be a valid supported provider identifier string.',
    );
  }
  if (isNonNullPlainRecord(rewritten.providerToLink)) {
    const linkInfo = rewritten.providerToLink;
    if (linkInfo.displayName !== undefined && typeof linkInfo.displayName !== 'string') {
      throw new FirebaseAuthError(
        'invalid-display-name',
        'The provider "displayName" must be a valid string.',
      );
    }
    if (linkInfo.email !== undefined && !isClientEmail(linkInfo.email)) {
      throw new FirebaseAuthError('invalid-email', 'The provider "email" must be a valid email string.');
    }
    if (linkInfo.photoUrl !== undefined && !isWebUrl(linkInfo.photoUrl)) {
      throw new FirebaseAuthError(
        'invalid-photo-url',
        'The provider "photoURL" must be a valid URL string.',
      );
    }
  }

  const unsupported = UNSUPPORTED_UPDATE_KEYS.filter(
    (key) => Object.hasOwn(rawProperties, key) && rawProperties[key] !== undefined,
  );
  if (unsupported.length > 0) {
    throw notImplemented(`updateUser({ ${unsupported.join(', ')} })`);
  }

  if (rewritten.email !== undefined && !isStrictEmail(rewritten.email)) {
    throw new FirebaseAuthError('invalid-email', 'The email address is improperly formatted.');
  }
  if (
    rewritten.phoneNumber !== undefined &&
    rewritten.phoneNumber !== null &&
    !isE164PhoneNumber(rewritten.phoneNumber)
  ) {
    throw new FirebaseAuthError(
      'invalid-phone-number',
      'The phoneNumber must be a non-empty E.164 standard compliant identifier string.',
    );
  }

  const typed = rawProperties as unknown as UpdateRequest;
  return {
    displayName: typed.displayName,
    email: typed.email,
    password: typed.password,
    phoneNumber: typed.phoneNumber,
    photoUrl: typed.photoURL,
    disabled: typed.disabled,
    emailVerified: typed.emailVerified,
  };
}

export function assertPhoneNumberPreflight(phoneNumber: unknown): void {
  if (!isClientPhoneNumber(phoneNumber)) {
    throw new FirebaseAuthError(
      'invalid-phone-number',
      'The phoneNumber must be a non-empty E.164 standard compliant identifier string.',
    );
  }
}

export function assertGetUsersPreflight(identifiers: unknown): void {
  if (!Array.isArray(identifiers)) {
    throw new FirebaseAuthError('argument-error', '`identifiers` parameter must be an array');
  }
  if (identifiers.length === 0) {
    return;
  }
  if (identifiers.length > MAX_GET_ACCOUNTS_BATCH_SIZE) {
    throw new FirebaseAuthError(
      'maximum-user-count-exceeded',
      `\`identifiers\` parameter must have <= ${MAX_GET_ACCOUNTS_BATCH_SIZE} entries.`,
    );
  }
  for (const rawId of identifiers) {
    const id = rawId as {
      uid?: unknown;
      email?: unknown;
      phoneNumber?: unknown;
      providerId?: unknown;
      providerUid?: unknown;
    };
    if (id.uid !== undefined) {
      const uidErr = invalidUid(id.uid);
      if (uidErr !== null) throw uidErr;
    } else if (id.email !== undefined) {
      if (!isClientEmail(id.email)) {
        throw new FirebaseAuthError('invalid-email', 'The email address is improperly formatted.');
      }
    } else if (id.phoneNumber !== undefined) {
      assertPhoneNumberPreflight(id.phoneNumber);
    } else if (id.providerId !== undefined && id.providerUid !== undefined) {
      if (!isNonEmptyString(id.providerId)) {
        throw new FirebaseAuthError(
          'invalid-provider-id',
          'The providerId must be a valid supported provider identifier string.',
        );
      }
      if (!isNonEmptyString(id.providerUid)) {
        throw new FirebaseAuthError(
          'invalid-provider-uid',
          'The providerUid must be a valid provider uid string.',
        );
      }
    } else {
      throw new FirebaseAuthError('argument-error', 'Unrecognized identifier: ' + (rawId as string));
    }
  }
}

export function assertDeleteUsersPreflight(uids: unknown): void {
  if (!Array.isArray(uids)) {
    throw new FirebaseAuthError('argument-error', '`uids` parameter must be an array');
  }
  if (uids.length === 0) {
    return;
  }
  if (uids.length > MAX_DELETE_ACCOUNTS_BATCH_SIZE) {
    throw new FirebaseAuthError(
      'maximum-user-count-exceeded',
      `\`uids\` parameter must have <= ${MAX_DELETE_ACCOUNTS_BATCH_SIZE} entries.`,
    );
  }
  for (const uid of uids) {
    const uidErr = invalidUid(uid);
    if (uidErr !== null) throw uidErr;
  }
}
