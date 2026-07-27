import type { Auth, User, UserInfo } from './types.js';
import type { Mutable } from './sandbox-backend-types.js';

/**
 * Resolve the bound Auth instance from a User handle.
 * Fallbacks to an in-memory stub if the user handle was synthesized in a test.
 */
export function resolveUserAuth(user: User): Auth {
  return (user as any).auth || { currentUser: user };
}

/**
 * Mutate a User record in place to add or update a linked provider (e.g. phone, MFA).
 * Uses the codebase's official Mutable helper rather than informal any casting.
 */
export function mutateUserProvider(user: User, providerInfo: UserInfo): void {
  const mutable = user as Mutable<User>;
  if (!mutable.providerData) {
    mutable.providerData = [];
  }
  const existingIndex = mutable.providerData.findIndex((p) => p.providerId === providerInfo.providerId);
  if (existingIndex !== -1) {
    mutable.providerData[existingIndex] = providerInfo;
  } else {
    mutable.providerData.push(providerInfo);
  }
}

/**
 * Update a User record's primary phone number in place.
 */
export function mutateUserPhone(user: User, phoneNumber: string | null): void {
  const mutable = user as Mutable<User>;
  mutable.phoneNumber = phoneNumber;
}

export interface MultiFactorInternalState {
  enrolledFactors: Array<{
    uid: string;
    displayName: string;
    factorId: string;
    enrollmentTime: string;
  }>;
}

/**
 * Get or initialize the internal MFA state on a User record.
 */
export function getMultiFactorState(user: User): MultiFactorInternalState {
  const mutable = user as Mutable<User> & { _multiFactor?: MultiFactorInternalState };
  if (!mutable._multiFactor) {
    mutable._multiFactor = { enrolledFactors: [] };
  }
  return mutable._multiFactor;
}
