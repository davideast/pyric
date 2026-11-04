/** Project-wide Auth data shared by app-local Auth session backends. */
import type { AuthAccountStanding } from 'pyric/sandbox/internal';
import type { StoredUser } from '../sandbox-backend-types.js';

export interface AuthProjectStore {
  readonly usersByEmail: Map<string, StoredUser>;
  readonly usersByUid: Map<string, StoredUser>;
  /**
   * Uids whose record was deleted, by `deleteUser` or `clearUsers`.
   * Production refuses a deleted account's refresh token, while a session
   * whose record this sandbox never stored (a session restored into a fresh
   * sandbox) keeps refreshing (#1515), so a missing record alone does not
   * mean deleted. A reset or a full-state restore forgets them.
   */
  readonly deletedUids: Set<string>;
  /**
   * Production's `tokensValidAfterTime` per uid, in epoch milliseconds on a
   * whole second: a session authenticated before it can no longer refresh.
   * Set by a password change, by `revokeRefreshTokens`, and by deleting the
   * record, so a session held across a delete and a re-create of the uid is
   * refused, as production's new account starts with a new `validSince`.
   */
  readonly tokensValidAfterMs: Map<string, number>;
  readonly userDbSubscribers: Set<() => void>;
  readonly providerConfig: Map<string, boolean>;
  readonly providerConfigSubscribers: Set<() => void>;
  readonly counters: {
    nextAdminUserId: number;
  };
  /**
   * The project the minted ID tokens name in `iss` and `aud`, read at each
   * mint because a served host learns it after Auth starts. `undefined`
   * mints for `SANDBOX_PROJECT_ID`.
   */
  projectId: () => string | undefined;
}

export function createAuthProjectStore(): AuthProjectStore {
  return {
    usersByEmail: new Map(),
    usersByUid: new Map(),
    deletedUids: new Set(),
    tokensValidAfterMs: new Map(),
    userDbSubscribers: new Set(),
    providerConfig: new Map([
      ['password', true],
      ['anonymous', true],
    ]),
    providerConfigSubscribers: new Set(),
    counters: {
      nextAdminUserId: 1,
    },
    projectId: () => undefined,
  };
}

/** Where an account stands for a token refresh or an admin revocation check. */
export function accountStanding(store: AuthProjectStore, uid: string): AuthAccountStanding {
  const stored = store.usersByUid.get(uid);
  const hasRecord = stored !== undefined;
  if (hasRecord && stored.disabled) return { kind: 'disabled' };
  if (hasRecord) return { kind: 'active', tokensValidAfterMs: store.tokensValidAfterMs.get(uid) ?? null };
  if (store.deletedUids.has(uid)) return { kind: 'deleted' };
  return { kind: 'unrecorded' };
}

/**
 * Revoke a uid's refresh tokens at `nowMs`, as production does: it stores the
 * revocation on a whole second, so a session authenticated in that second
 * stays valid.
 */
export function revokeTokensAt(store: AuthProjectStore, uid: string, nowMs: number): void {
  store.tokensValidAfterMs.set(uid, Math.floor(nowMs / 1000) * 1000);
}

/** Record that the uid's record was deleted at `nowMs`. */
export function recordDeletion(store: AuthProjectStore, uid: string, nowMs: number): void {
  store.deletedUids.add(uid);
  revokeTokensAt(store, uid, nowMs);
}

/** Forget every deletion and revocation, for a reset or a full-state restore. */
export function forgetAccountHistory(store: AuthProjectStore): void {
  store.deletedUids.clear();
  store.tokensValidAfterMs.clear();
}
