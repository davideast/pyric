/** Project-wide Auth data shared by app-local Auth session backends. */
import type { AuthAccountStanding } from 'pyric/sandbox/internal';
import type { AuthAccountHistory } from '../../sandbox/internal/auth-accounts.js';
import type { StoredUser } from '../sandbox-backend-types.js';
import type { SessionRecord } from './session-ledger.js';

export interface AuthProjectStore {
  readonly usersByEmail: Map<string, StoredUser>;
  readonly usersByUid: Map<string, StoredUser>;
  /**
   * Uids whose record was deleted, by `deleteUser` or `clearUsers`.
   * Production refuses a deleted account's refresh token, while a session
   * whose record this sandbox never stored (a session restored into a fresh
   * sandbox) keeps refreshing (#1515), so a missing record alone does not
   * mean deleted. A reset forgets them; a full-state restore replays the
   * ones its state carries.
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
  /**
   * Every session by its key, with its last authentication: what a revocation
   * is compared with. In-page persistence saves them, so a reload resumes a
   * session with the sign-in time it had (#2018).
   */
  readonly sessionRecords: Map<string, SessionRecord>;
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
    sessionRecords: new Map(),
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

/** Each account's revocation time and the deleted uids, as plain JSON. */
export function accountHistory(store: AuthProjectStore): AuthAccountHistory {
  const uids = [...store.tokensValidAfterMs.keys()].sort();
  return {
    tokensValidAfterMs: Object.fromEntries(uids.map((uid) => [uid, store.tokensValidAfterMs.get(uid)!])),
    deletedUids: [...store.deletedUids].sort(),
  };
}

/** Replace the store's deletions and revocations with `history`'s. */
export function replayAccountHistory(store: AuthProjectStore, history: AuthAccountHistory): void {
  forgetAccountHistory(store);
  for (const [uid, validAfterMs] of Object.entries(history.tokensValidAfterMs)) {
    store.tokensValidAfterMs.set(uid, validAfterMs);
  }
  for (const uid of history.deletedUids) store.deletedUids.add(uid);
}

/** A session as persistence saves it. */
export interface PersistedSession {
  key: string;
  uid: string;
  authenticatedAtMs: number;
}

/**
 * The sessions with a sign-in time of their own. A session restored without
 * one has nothing to save: restoring it again without a match is the same.
 */
export function persistedSessions(store: AuthProjectStore): PersistedSession[] {
  const saved: PersistedSession[] = [];
  for (const record of store.sessionRecords.values()) {
    if (!Number.isFinite(record.authenticatedAtMs)) continue;
    saved.push({ key: record.key, uid: record.uid, authenticatedAtMs: record.authenticatedAtMs });
  }
  return saved;
}

function isPersistedSession(value: unknown): value is PersistedSession {
  const session = value as Partial<PersistedSession> | null;
  return typeof session === 'object' && session !== null
    && typeof session.key === 'string'
    && typeof session.uid === 'string'
    && typeof session.authenticatedAtMs === 'number' && Number.isFinite(session.authenticatedAtMs);
}

/** Add the saved sessions a reload hands back. A session already held keeps its own record. */
export function restorePersistedSessions(store: AuthProjectStore, sessions: unknown): void {
  if (!Array.isArray(sessions)) return;
  for (const session of sessions) {
    const restorable = isPersistedSession(session) && !store.sessionRecords.has(session.key);
    if (!restorable) continue;
    store.sessionRecords.set(session.key, { key: session.key, uid: session.uid, authenticatedAtMs: session.authenticatedAtMs });
  }
}
