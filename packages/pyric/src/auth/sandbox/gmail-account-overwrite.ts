/**
 * Trusted `@gmail.com` Google sign-in overwrite semantics on unverified
 * accounts (#1814).
 *
 * Production Firebase Auth / Identity Platform trusts `google.com` as
 * authoritative for `@gmail.com` addresses: when a `@gmail.com` Google sign-in
 * matches an existing unverified account, it overwrites the unverified record
 * (removing any unverified password and unverified federated providers,
 * revoking prior refresh tokens when a password was cleared, and marking
 * `emailVerified: true`). Verified accounts keep their password and linked
 * providers.
 */
import { providerVerifiesEmail } from 'pyric/sandbox/internal';
import type { StoredUser } from '../sandbox-backend-types.js';
import { revokeTokensAt, type AuthProjectStore } from './project-store.js';

const GOOGLE_PROVIDER_ID = 'google.com';
const GMAIL_DOMAIN_SUFFIX = '@gmail.com';

/** True when `providerId` is `'google.com'` and `email` is a canonical `@gmail.com` address. */
function isTrustedGmailGoogleSignIn(
  providerId: string,
  email: string | null | undefined,
): boolean {
  if (providerId !== GOOGLE_PROVIDER_ID || typeof email !== 'string') {
    return false;
  }
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.indexOf('@');
  if (atIndex <= 0) {
    return false;
  }
  return normalized.slice(atIndex) === GMAIL_DOMAIN_SUFFIX;
}

/**
 * Overwrite an unverified `@gmail.com` account on a trusted `google.com`
 * sign-in: clear its password, drop unverified providers in favor of
 * `google.com`, revoke prior refresh tokens if credentials were stripped, and
 * mark `emailVerified = true`. Returns `true` when the overwrite applied.
 */
function overwriteUnverifiedGmailAccount(
  stored: StoredUser,
  store: AuthProjectStore,
  nowMs: number,
): boolean {
  if (stored.emailVerified) {
    return false;
  }
  const hadPassword = stored.password !== null;
  const hadOtherProviders = stored.providerUserInfo.some(
    (entry) => entry.providerId !== GOOGLE_PROVIDER_ID,
  );
  stored.password = null;
  stored.providerUserInfo = [{ providerId: GOOGLE_PROVIDER_ID }];
  stored.emailVerified = true;
  if (hadPassword || hadOtherProviders) {
    revokeTokensAt(store, stored.uid, nowMs);
  }
  return true;
}

/**
 * Apply provider email verification on sign-in:
 * - On `@gmail.com` with `google.com`, overwrite an unverified account.
 * - Otherwise, mark verified only when `providerId` vouches for the email and
 *   the account has no password and no other linked provider.
 */
export function applyProviderEmailVerification(
  stored: StoredUser,
  providerId: string,
  store: AuthProjectStore,
  nowMs: number,
): boolean {
  if (isTrustedGmailGoogleSignIn(providerId, stored.email)) {
    return overwriteUnverifiedGmailAccount(stored, store, nowMs);
  }
  const hasEmail = stored.email !== null;
  const hasPassword = stored.password !== null;
  const hasOtherProvider = stored.providerUserInfo.some(
    (entry) => entry.providerId !== providerId,
  );
  const isProviderIdentityAlone = !hasPassword && !hasOtherProvider;
  const needsMark =
    hasEmail &&
    !stored.emailVerified &&
    isProviderIdentityAlone &&
    providerVerifiesEmail(providerId);
  if (!needsMark) {
    return false;
  }
  stored.emailVerified = true;
  return true;
}
