/**
 * What a stored user record contributes to an identity the surface holds.
 *
 * A user is created with a tenant and custom claims, and those are what that
 * user signs in with. An impersonation that named only a tenant used to hold
 * the tenant and nothing else, so a user created with `{ role: 'billingAdmin' }`
 * lost the role the moment a tenant was named, every later call was refused by
 * rules that read the role, and the session spent a call repairing an identity
 * that was already correct in the user pool.
 *
 * So the stored record is the base and the call's arguments sit over it, field
 * by field: a named tenant replaces the stored tenant, a named claim replaces
 * that claim, and everything unnamed is kept.
 *
 * The same lookup answers a simulation named by uid, which is why it lives
 * here rather than inside either caller.
 */
import { getAuth, sandbox as authSandbox } from 'pyric/auth';

import type { IdentityInput } from './identity.js';
import type { SurfaceContext } from './types.js';

/** The tenant and claims one user record holds, as a caller may override them. */
export interface NamedIdentity {
  tenant?: string;
  claims?: Record<string, unknown>;
}

/**
 * The tenant and claims stored on a user record. A user seeded outside this
 * session has no remembered projection, and without this lookup it would act
 * untenanted and unclaimed, and the verdict would explain the wrong denial.
 */
export function storedIdentity(ctx: SurfaceContext, uid: string): NamedIdentity {
  const stored = authSandbox.exportUsers(getAuth(ctx.sandbox)).find((user) => user.uid === uid);
  const identity: NamedIdentity = {};
  if (stored?.tenantId !== undefined) identity.tenant = stored.tenantId;
  if (stored?.customClaims !== undefined) identity.claims = stored.customClaims;
  return identity;
}

/**
 * The identity an impersonation holds: the stored user record, with whatever
 * the call named written over it field by field.
 */
export function impersonatedIdentity(
  ctx: SurfaceContext,
  uid: string,
  named: NamedIdentity,
): IdentityInput {
  const stored = storedIdentity(ctx, uid);
  const identity: IdentityInput = { mode: 'uid', uid };

  const tenant = named.tenant ?? stored.tenant;
  if (tenant !== undefined) identity.tenant = tenant;

  const hasClaims = named.claims !== undefined || stored.claims !== undefined;
  if (hasClaims) identity.claims = { ...stored.claims, ...named.claims };

  return identity;
}
