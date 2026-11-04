/**
 * The Auth account table a sandbox's client sign-ins write to, for adapters
 * that answer about those accounts without owning them: `pyric-admin`'s
 * `verifyIdToken(token, true)` and `revokeRefreshTokens`.
 *
 * `pyric/auth` registers each sandbox's table when it creates it; this module
 * holds no Auth state of its own.
 */

/**
 * Where an account stands.
 *
 * - `active`: a stored, enabled account. `tokensValidAfterMs` is production's
 *   `tokensValidAfterTime` in epoch milliseconds, or null when nothing revoked
 *   the account's tokens.
 * - `disabled`: a stored account an administrator disabled.
 * - `deleted`: an account whose record was deleted.
 * - `unrecorded`: no record was ever stored for the uid, such as a session
 *   restored without its record. Its sessions keep refreshing.
 */
export type AuthAccountStanding =
  | { readonly kind: 'active'; readonly tokensValidAfterMs: number | null }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'unrecorded' };

/** One sandbox's Auth account table, as `pyric/auth` exposes it. */
export interface AuthAccounts {
  /** Where the account with `uid` stands. */
  standing(uid: string): AuthAccountStanding;
  /** Revoke the account's refresh tokens at the sandbox clock's now. */
  revokeRefreshTokens(uid: string): void;
}

const accountsBySandbox = new WeakMap<object, AuthAccounts>();

/** Called by `pyric/auth` when it creates a sandbox's account table. */
export function registerAuthAccounts(sandbox: object, accounts: AuthAccounts): void {
  accountsBySandbox.set(sandbox, accounts);
}

/** The sandbox's account table, or undefined when no Auth handle has touched it yet. */
export function authAccountsFor(sandbox: object): AuthAccounts | undefined {
  return accountsBySandbox.get(sandbox);
}
