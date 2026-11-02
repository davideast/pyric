/**
 * Which federated sign-ins vouch for the account's email address.
 *
 * A new Google identity gets a verified email, as Google's ID token asserts
 * `email_verified` for the account's address: the user reports
 * `emailVerified: true` and the Firebase ID token `email_verified: true`. The
 * sandbox's sign-in dialog lets a developer type any address for a Google
 * account; it stands for a Google account, so it is verified too.
 *
 * This does not reach existing accounts. Firebase trusts Google for account
 * linking only on `@gmail.com` addresses, where it overwrites an unverified
 * account and removes its password; for other domains Google is untrusted.
 * The sandbox does neither, so the caller verifies only a record that is the
 * provider's identity alone. Other federated providers keep the account's
 * own flag.
 */
const EMAIL_VERIFYING_PROVIDERS: ReadonlySet<string> = new Set(['google.com']);

/** True when a sign-in through `providerId` marks a new identity's email verified. */
export function providerVerifiesEmail(providerId: string): boolean {
  return EMAIL_VERIFYING_PROVIDERS.has(providerId);
}
