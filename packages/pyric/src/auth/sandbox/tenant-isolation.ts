/**
 * Multi-tenant lookup keys and cross-tenant identity guards for `SandboxBackend`.
 *
 * Identity Platform partitions email uniqueness and credential sign-in by
 * `(tenantId ?? null, lowerEmail)`, while keeping `uid` globally unique per
 * project. Any attempt to sign in or mint a session for an existing `uid`
 * under a different tenant is refused with `auth/tenant-id-mismatch` before
 * mutating the stored account.
 */
import { makeAuthError } from '../auth-errors.js';

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
