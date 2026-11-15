/**
 * Email update semantics for `SandboxBackend.updateEmailFor`.
 *
 * When a user's email actually changes (case-insensitive comparison matching
 * Identity Toolkit `canonicalizeEmailAddress`), resets `emailVerified` to
 * `false`, revokes other sessions while keeping the caller's session valid,
 * updates live `User` handles in place, mints a fresh ID token immediately,
 * propagates the refreshed claims to the active rules session, and fires
 * `onIdTokenChanged`. Calling `updateEmail` with the account's current email
 * is an idempotent no-op that preserves `emailVerified` and the cached token.
 */
import type { AuthState } from 'pyric/sandbox';
import { rulesTokenFromIdToken } from 'pyric/sandbox/internal';
import { makeAuthError } from '../auth-errors.js';
import { validateEmailFormat } from '../sandbox-credential-validators.js';
import type { Mutable, StoredUser } from '../sandbox-backend-types.js';
import type { IdTokenResult, User, UserInfo } from '../types.js';
import { revokeTokensAt, type AuthProjectStore } from './project-store.js';
import type { SessionLedger } from './session-ledger.js';

export interface ActiveSessionSlot {
  currentUser: AuthState;
}

/**
 * Update the active rules session's token when `session.currentUser` matches
 * `(uid, tenantId)`, without treating a token refresh as a new sign-in.
 */
export function propagateRefreshedToken(
  session: ActiveSessionSlot,
  uid: string,
  tenantId: string | null,
  minted: IdTokenResult,
  runInTransition: (fn: () => void) => void,
): boolean {
  const current = session.currentUser;
  const matches = current !== null && current.uid === uid && (current.tenant ?? null) === tenantId;
  if (!matches) return false;
  const nextToken = structuredClone(rulesTokenFromIdToken(minted.claims));
  runInTransition(() => {
    session.currentUser = { ...current, token: nextToken };
  });
  return true;
}

/** Whether `nextEmail` differs from the stored email (case-insensitive). */
function isEmailChange(currentEmail: string | null, nextEmail: string): boolean {
  if (currentEmail === null) return true;
  return currentEmail.toLowerCase() !== nextEmail.toLowerCase();
}

/** Mutate a `User`'s email, linked provider email fields, and optional verification reset in place. */
export function applyEmailChangeToUser(user: User, email: string, resetVerified: boolean): void {
  const mutable = user as Mutable<User>;
  mutable.email = email;
  if (resetVerified) mutable.emailVerified = false;
  for (const entry of user.providerData ?? []) {
    (entry as Mutable<UserInfo>).email = email;
  }
}

export interface UserEmailUpdateContext {
  readonly user: User;
  readonly stored: StoredUser | undefined;
  readonly cachedUser: User | null;
  readonly session: ActiveSessionSlot;
  readonly nowMs: number;
  readonly projectStore: AuthProjectStore;
  readonly sessions: SessionLedger;
  readonly assertRecentLogin: () => void;
  readonly persistEmailReset: (email: string) => void;
  readonly applyUserEmail: (target: User, email: string) => void;
  readonly mintFreshToken: () => { token: string; result: IdTokenResult };
  readonly runInTransition: (fn: () => void) => void;
  readonly notifyUsersChanged: () => void;
  readonly notifyIdTokenChanged: () => void;
}

/** Run `updateEmail(user, newEmail)` and return whether the stored address changed. */
export function applyUserEmailUpdate(ctx: UserEmailUpdateContext, newEmail: string): boolean {
  ctx.assertRecentLogin();
  if (ctx.stored === undefined) {
    throw makeAuthError('auth/user-not-found', `No user found for uid ${ctx.user.uid}.`);
  }
  validateEmailFormat(newEmail);
  if (!isEmailChange(ctx.stored.email, newEmail)) return false;

  ctx.persistEmailReset(newEmail);

  // Changing email revokes other sessions while keeping this session valid,
  // preserving `auth_time` and the recent-login window from sign-in.
  revokeTokensAt(ctx.projectStore, ctx.user.uid, ctx.nowMs);
  ctx.sessions.authenticate(ctx.user, ctx.nowMs);
  const cached = ctx.cachedUser;
  const sharesSessionWithCached =
    cached !== null
    && cached !== ctx.user
    && cached.uid === ctx.user.uid
    && ctx.sessions.sameSession(cached, ctx.user);
  if (sharesSessionWithCached) ctx.sessions.authenticate(cached, ctx.nowMs);
  ctx.notifyUsersChanged();

  ctx.applyUserEmail(ctx.user, newEmail);
  (ctx.user as Mutable<User>).emailVerified = false;
  if (cached !== null && cached !== ctx.user && cached.uid === ctx.user.uid) {
    ctx.applyUserEmail(cached, newEmail);
    (cached as Mutable<User>).emailVerified = false;
  }

  const fresh = ctx.mintFreshToken();
  const updatedCurrent = propagateRefreshedToken(
    ctx.session,
    ctx.user.uid,
    ctx.user.tenantId ?? null,
    fresh.result,
    ctx.runInTransition,
  );
  if (updatedCurrent) ctx.notifyIdTokenChanged();
  return true;
}
