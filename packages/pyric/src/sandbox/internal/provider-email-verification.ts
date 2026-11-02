/**
 * Which federated sign-ins vouch for the account's email address.
 *
 * Firebase Auth treats Google as a trusted email provider: a Google account's
 * address is verified by Google, so a `google.com` sign-in sets
 * `emailVerified: true` on the user and `email_verified: true` on the ID
 * token. The sandbox's sign-in dialog lets a developer type any address for a
 * Google account; it stands for a Google account, so it is verified too.
 * Other federated providers keep the account's own flag.
 */
const EMAIL_VERIFYING_PROVIDERS: ReadonlySet<string> = new Set(['google.com']);

/** True when a sign-in through `providerId` marks the account's email verified. */
export function providerVerifiesEmail(providerId: string): boolean {
  return EMAIL_VERIFYING_PROVIDERS.has(providerId);
}
