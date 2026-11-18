/**
 * Field-level user record mutation helpers for admin `createUser` and
 * `updateUser` on the in-process Auth sandbox backend.
 */
import { makeAuthError } from '../auth-errors.js';
import type { StoredUser, UpdateUserRequest } from '../sandbox-backend-types.js';
import { validateEmailFormat } from '../sandbox-credential-validators.js';
import { tenantEmailKey, unindexStoredUserEmail } from './tenant-isolation.js';

export function assertTenantPhoneAvailable(
  usersByUid: ReadonlyMap<string, StoredUser>,
  phoneNumber: string,
  tenantId: string | null,
  excludeUser?: StoredUser,
): void {
  const taken = [...usersByUid.values()].some(
    (user) =>
      user !== excludeUser &&
      user.phoneNumber === phoneNumber &&
      (user.tenantId ?? null) === tenantId,
  );
  if (taken) {
    throw makeAuthError(
      'auth/phone-number-already-exists',
      'The user with the provided phoneNumber already exists.',
    );
  }
}

export function applyAdminUserUpdateFields(params: {
  stored: StoredUser;
  update: UpdateUserRequest;
  usersByUid: ReadonlyMap<string, StoredUser>;
  usersByEmail: Map<string, StoredUser>;
  photoOriginByUid: Map<string, string>;
}): void {
  const { stored, update, usersByUid, usersByEmail, photoOriginByUid } = params;
  const targetTenant = stored.tenantId ?? null;

  if (update.email !== undefined) {
    validateEmailFormat(update.email);
    const key = update.email.toLowerCase();
    const emailTakenInTenant = [...usersByUid.values()].some(
      (user) =>
        user !== stored &&
        user.email?.toLowerCase() === key &&
        (user.tenantId ?? null) === targetTenant,
    );
    if (emailTakenInTenant) {
      throw makeAuthError(
        'auth/email-already-in-use',
        `An account already exists for ${update.email}.`,
      );
    }
    unindexStoredUserEmail(usersByEmail, stored);
    stored.email = update.email;
    usersByEmail.set(tenantEmailKey(targetTenant, update.email), stored);
  }

  if (update.phoneNumber !== undefined) {
    if (update.phoneNumber === null) {
      stored.phoneNumber = null;
      stored.providerUserInfo = stored.providerUserInfo.filter(
        (provider) => provider.providerId !== 'phone',
      );
    } else {
      assertTenantPhoneAvailable(usersByUid, update.phoneNumber, targetTenant, stored);
      stored.phoneNumber = update.phoneNumber;
      const hasPhoneProvider = stored.providerUserInfo.some(
        (provider) => provider.providerId === 'phone',
      );
      if (!hasPhoneProvider) {
        stored.providerUserInfo.push({ providerId: 'phone' });
      }
    }
  }

  if (update.photoUrl !== undefined) {
    stored.photoUrl = update.photoUrl;
    photoOriginByUid.delete(stored.uid);
  }
  if (update.displayName !== undefined) stored.displayName = update.displayName;
  if (update.disabled !== undefined) stored.disabled = update.disabled;
  if (update.emailVerified !== undefined) stored.emailVerified = update.emailVerified;
}
