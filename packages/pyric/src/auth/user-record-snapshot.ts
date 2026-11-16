/**
 * Builds defensive public `AuthUserRecord` snapshots from internal `StoredUser`
 * rows, including `tokensValidAfterMs` derived from revocation and creation time.
 */

import type { AuthUserRecord, StoredUser } from './sandbox-backend-types.js';

export function toAuthUserRecord(
  u: StoredUser,
  revokedMs: number | undefined,
  cloneClaims: <T>(value: T) => T,
): AuthUserRecord {
  const createdMs = Date.parse(u.createdAt);
  const createdSecMs = Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) * 1000 : undefined;
  let tokensValidAfterMs: number | undefined;
  if (revokedMs !== undefined && createdSecMs !== undefined) {
    tokensValidAfterMs = Math.max(revokedMs, createdSecMs);
  } else {
    tokensValidAfterMs = revokedMs ?? createdSecMs;
  }
  return {
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    phoneNumber: u.phoneNumber,
    photoUrl: u.photoUrl,
    customClaims: cloneClaims(u.customClaims),
    providerUserInfo: u.providerUserInfo.map((p) => ({ ...p })),
    isAnonymous: u.isAnonymous,
    disabled: u.disabled,
    emailVerified: u.emailVerified,
    tenantId: u.tenantId,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    ...(tokensValidAfterMs !== undefined ? { tokensValidAfterMs } : {}),
  };
}
