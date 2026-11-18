import type { ProviderUserInfo } from '../sandbox-backend-types.js';
import type { UserInfo } from '../types.js';

function resolveProviderScopedUid(
  providerId: string,
  accountUid: string,
  email: string | null,
  phoneNumber: string | null,
): string {
  if (providerId === 'password' && email !== null) {
    return email;
  }
  if (providerId === 'phone' && phoneNumber !== null) {
    return phoneNumber;
  }
  return accountUid;
}

export function buildClientUserInfoList(args: {
  readonly isAnonymous: boolean;
  readonly uid: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly phoneNumber: string | null;
  readonly photoURL: string | null;
  readonly providers: readonly ProviderUserInfo[];
}): UserInfo[] {
  if (args.isAnonymous) {
    return [];
  }
  return args.providers.map((provider) => ({
    uid: resolveProviderScopedUid(provider.providerId, args.uid, args.email, args.phoneNumber),
    displayName: args.displayName,
    email: args.email,
    phoneNumber: args.phoneNumber,
    photoURL: args.photoURL,
    providerId: provider.providerId,
  }));
}

/**
 * Mirrors `@firebase/auth` `updateProfile` over Identity Toolkit `/v1/accounts:update`:
 * `undefined` and `null` leave the stored attribute intact (the client SDK sends
 * `{ displayName, photoUrl }` without `deleteAttribute`), while `""` clears to `null`
 * via `response.displayName || null` / `response.photoUrl || null`.
 */
export function normalizeClientProfileUpdate(profile: {
  displayName?: string | null;
  photoURL?: string | null;
}): { displayName?: string | null; photoURL?: string | null } {
  const out: { displayName?: string | null; photoURL?: string | null } = {};
  if (typeof profile.displayName === 'string') {
    if (profile.displayName.length === 0) {
      out.displayName = null;
    } else {
      out.displayName = profile.displayName;
    }
  }
  if (typeof profile.photoURL === 'string') {
    if (profile.photoURL.length === 0) {
      out.photoURL = null;
    } else {
      out.photoURL = profile.photoURL;
    }
  }
  return out;
}
