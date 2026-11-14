/**
 * Multi-tenant lookup keys, cross-tenant identity guards, and tenant-scoped
 * email directory mutations for `SandboxBackend`.
 *
 * Identity Platform partitions email uniqueness and credential sign-in by
 * `(tenantId ?? null, lowerEmail)`, while keeping `uid` globally unique per
 * project. Any attempt to sign in or mint a session for an existing `uid`
 * under a different tenant is refused with `auth/tenant-id-mismatch` before
 * mutating the stored account.
 */
import { makeAuthError } from '../auth-errors.js';
import { validateEmailFormat, validatePasswordStrength } from '../sandbox-credential-validators.js';

export interface TenantDirectoryAccount {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  password: string | null;
  tenantId: string | null;
  isAnonymous: boolean;
  providerUserInfo: Array<{ providerId: string }>;
}

/** Normalize optional or empty tenant strings to `string | null`. */
export function normalizeTenantScope(tenantId: string | null | undefined): string | null {
  if (typeof tenantId === 'string' && tenantId.length > 0) {
    return tenantId;
  }
  return null;
}

/** Collision-free map key partitioning `usersByEmail` by `(tenantId ?? null, lowerEmail)`. */
export function tenantEmailKey(tenantId: string | null | undefined, email: string): string {
  return JSON.stringify([normalizeTenantScope(tenantId), email.toLowerCase()]);
}

/** Throw `auth/tenant-id-mismatch` when `stored.tenantId` belongs to a different tenant pool. */
export function assertMatchingTenant(
  stored: { readonly tenantId?: string | null },
  targetTenant: string | null | undefined,
): void {
  if (normalizeTenantScope(stored.tenantId) !== normalizeTenantScope(targetTenant)) {
    throw makeAuthError(
      'auth/tenant-id-mismatch',
      "The provided tenant ID does not match the Auth instance's tenant ID",
    );
  }
}

/** Remove `stored` from `usersByEmail` under its tenant scope when it still owns that email slot. */
export function unindexStoredUserEmail<
  T extends { readonly tenantId?: string | null; readonly email?: string | null },
>(usersByEmail: Map<string, T>, stored: T): void {
  if (!stored.email) return;
  const oldKey = tenantEmailKey(stored.tenantId, stored.email);
  if (usersByEmail.get(oldKey) === stored) {
    usersByEmail.delete(oldKey);
  }
}

/** Reassign an account's email address within its tenant scope and mark it verified. */
export function moveStoredUserEmail<T extends TenantDirectoryAccount>(
  usersByEmail: Map<string, T>,
  stored: T,
  toEmail: string,
): void {
  validateEmailFormat(toEmail);
  const targetTenant = normalizeTenantScope(stored.tenantId);
  const toKey = tenantEmailKey(targetTenant, toEmail);
  const existing = usersByEmail.get(toKey);
  if (existing && existing.uid !== stored.uid) {
    throw makeAuthError('auth/email-already-in-use', `An account already exists for ${toEmail}.`);
  }
  if (stored.email) {
    usersByEmail.delete(tenantEmailKey(targetTenant, stored.email));
  }
  stored.email = toEmail;
  stored.emailVerified = true;
  usersByEmail.set(toKey, stored);
}

/** Resolve or create a verified passwordless email-link account inside `tenantId`. */
export function upsertTenantEmailLinkAccount<T extends TenantDirectoryAccount>(input: {
  usersByEmail: Map<string, T>;
  usersByUid: Map<string, T>;
  email: string;
  tenantId: string | null | undefined;
  buildAccount: (fields: {
    uid: string;
    email: string;
    tenantId: string | null;
    providerUserInfo: Array<{ providerId: string }>;
  }) => T;
}): { stored: T; isNewUser: boolean } {
  validateEmailFormat(input.email);
  const normalizedTenant = normalizeTenantScope(input.tenantId);
  const key = tenantEmailKey(normalizedTenant, input.email);
  const existing = input.usersByEmail.get(key);
  if (existing !== undefined) {
    const needsPasswordProvider = !existing.providerUserInfo.some(
      (provider) => provider.providerId === 'password',
    );
    if (needsPasswordProvider) {
      existing.providerUserInfo.push({ providerId: 'password' });
    }
    existing.emailVerified = true;
    return { stored: existing, isNewUser: false };
  }
  const uid = `email-${globalThis.crypto.randomUUID()}`;
  const record = input.buildAccount({
    uid,
    email: input.email,
    tenantId: normalizedTenant,
    providerUserInfo: [{ providerId: 'password' }],
  });
  record.emailVerified = true;
  input.usersByEmail.set(key, record);
  input.usersByUid.set(uid, record);
  return { stored: record, isNewUser: true };
}

/** Validate and index an email/password identity being linked onto `stored` within its tenant. */
export function linkTenantEmailIdentity<T extends TenantDirectoryAccount>(
  usersByEmail: Map<string, T>,
  stored: T,
  identity: { email?: string; password?: string | null; emailVerified?: boolean } | undefined,
): void {
  const email = identity?.email;
  if (!email) return;
  validateEmailFormat(email);
  const targetTenant = normalizeTenantScope(stored.tenantId);
  const key = tenantEmailKey(targetTenant, email);
  const owner = usersByEmail.get(key);
  if (owner && owner.uid !== stored.uid) {
    throw makeAuthError('auth/email-already-in-use', `An account already exists for ${email}.`);
  }
  if (identity.password !== undefined && identity.password !== null) {
    validatePasswordStrength(identity.password);
    stored.password = identity.password;
  }
  if (stored.email && stored.email.toLowerCase() !== email.toLowerCase()) {
    usersByEmail.delete(tenantEmailKey(targetTenant, stored.email));
  }
  stored.email = email;
  usersByEmail.set(key, stored);
  if (identity.emailVerified !== undefined) {
    stored.emailVerified = identity.emailVerified;
  }
}

/** Validate and create an email/password account inside `tenantId`. */
export function createTenantEmailPasswordAccount<T extends TenantDirectoryAccount>(input: {
  usersByEmail: Map<string, T>;
  usersByUid: Map<string, T>;
  email: string;
  password: string;
  tenantId: string | null | undefined;
  buildAccount: (fields: {
    uid: string;
    email: string;
    password: string;
    tenantId: string | null;
    providerUserInfo: Array<{ providerId: string }>;
  }) => T;
}): T {
  validateEmailFormat(input.email);
  validatePasswordStrength(input.password);
  const normalizedTenant = normalizeTenantScope(input.tenantId);
  const key = tenantEmailKey(normalizedTenant, input.email);
  if (input.usersByEmail.has(key)) {
    throw makeAuthError(
      'auth/email-already-in-use',
      `An account already exists for ${input.email}.`,
    );
  }
  const uid = `email-${globalThis.crypto.randomUUID()}`;
  const record = input.buildAccount({
    uid,
    email: input.email,
    password: input.password,
    tenantId: normalizedTenant,
    providerUserInfo: [{ providerId: 'password' }],
  });
  input.usersByEmail.set(key, record);
  input.usersByUid.set(uid, record);
  return record;
}
