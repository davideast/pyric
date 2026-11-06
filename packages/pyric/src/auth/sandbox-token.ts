/**
 * Sandbox ID-token string synthesis. Pure, no backend state: the token
 * cache and mint bookkeeping stay on the backend core, which calls this to
 * produce the string.
 */
import { mintIdToken } from 'pyric/sandbox/internal';

/**
 * The ID token for a full claim set, in production's JWT shape (#1836):
 * three base64url segments, so a display name with a space or outside
 * Latin-1 never reaches the token text, and `pyric-admin` `verifyIdToken`
 * decodes it without a network round trip. The tag is the shared sandbox
 * signer (`pyric/sandbox/internal` `id-token.ts`), not an RSA signature.
 *
 * `serial` is the backend's mint counter, so back-to-back refreshes for the
 * same claims still get distinct strings.
 *
 * Claims-sensitivity is locked with uid AND serial held fixed (two
 * independent fresh backends, each at its first mint) in
 * `test/auth/sandbox-token-refresh.test.ts`, "token string is
 * sensitive to claims, not just the mint serial". Every other token
 * test compares mints across a serial bump (refresh, re-sign-in).
 */
export function sandboxTokenFor(claims: Record<string, unknown>, serial: number): string {
  return mintIdToken(claims, serial);
}
