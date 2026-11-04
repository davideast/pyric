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
  /** Forget every deletion and revocation: a reset or a full-state restore starts over. */
  forgetHistory(): void;
}

/** The code a refused refresh-token exchange answers, as `@firebase/auth` names it. */
export type RefreshRefusalCode = 'auth/user-disabled' | 'auth/user-token-expired';

/**
 * Whether production refuses a session's refresh-token exchange, and with
 * which code: `USER_DISABLED` (`auth/user-disabled`) for a disabled account,
 * and `USER_NOT_FOUND` or `TOKEN_EXPIRED` (both `auth/user-token-expired` in
 * `@firebase/auth`) for a deleted account or a session authenticated before
 * the account's tokens were revoked. `authenticatedAtMs` is the session's
 * last authentication; compared on a whole second, as production stores the
 * revocation. An `unrecorded` account, such as a session restored into a
 * sandbox that never stored its record (#1515), is not refused.
 */
export function refreshRefusal(standing: AuthAccountStanding, authenticatedAtMs: number | undefined): RefreshRefusalCode | null {
  if (standing.kind === 'disabled') return 'auth/user-disabled';
  if (standing.kind === 'deleted') return 'auth/user-token-expired';
  const validAfterMs = standing.kind === 'active' ? standing.tokensValidAfterMs : null;
  const comparable = validAfterMs !== null && authenticatedAtMs !== undefined;
  const revoked = comparable && Math.floor(authenticatedAtMs / 1000) * 1000 < validAfterMs;
  return revoked ? 'auth/user-token-expired' : null;
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
