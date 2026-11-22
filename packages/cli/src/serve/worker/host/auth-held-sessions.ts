/**
 * Per-port registry of held `MintedSession` handles authenticated on a
 * connection (#1948).
 *
 * A page or client can retain a `User` handle across subsequent sign-ins or
 * `signOut()` and invoke `getIdToken`, `getIdTokenResult`, `updateProfile`,
 * `reload`, `deleteUser`, `updateEmail`, `updatePassword`, reauthentication, or
 * verification email helpers on that held `User`. Keeping every session the
 * port itself authenticated lets the host act on the held user's own session
 * (and `sessionKey` / `tenantId`) without mutating whoever is currently signed
 * in or allowing a port to address a user it never authenticated.
 */

import { FirebaseError } from 'pyric/app';
import { sandbox as authSandboxOps, type Auth, type MintedSession } from 'pyric/auth';
import { sessionKeyOf } from 'pyric/auth/internal';
import type { HostCtx, PortLike } from '../host-context.js';
import { makeNoUserError } from './auth-session-seeder.js';

export interface HeldUserSelector {
  readonly uid?: string;
  readonly tenantId?: string | null;
  readonly sessionKey?: string;
}

export interface ResolvedHeldSession {
  readonly session: MintedSession;
  readonly isCurrent: boolean;
}

interface PortHeldSessions {
  readonly bySessionKey: Map<string, MintedSession>;
  readonly byIdentity: Map<string, MintedSession>;
}

const _heldSessions = new WeakMap<HostCtx, Map<PortLike, PortHeldSessions>>();

function heldMapFor(ctx: HostCtx): Map<PortLike, PortHeldSessions> {
  let map = _heldSessions.get(ctx);
  if (map === undefined) {
    map = new Map();
    _heldSessions.set(ctx, map);
  }
  return map;
}

function portHeldFor(ctx: HostCtx, port: PortLike): PortHeldSessions {
  const map = heldMapFor(ctx);
  let entry = map.get(port);
  if (entry === undefined) {
    entry = { bySessionKey: new Map(), byIdentity: new Map() };
    map.set(port, entry);
  }
  return entry;
}

function identityKey(uid: string, tenantId: string | null): string {
  const tenantPart = tenantId ?? '';
  return `${tenantPart}\0${uid}`;
}

function matchesSelector(session: MintedSession, selector: HeldUserSelector): boolean {
  if (selector.uid !== undefined && session.user.uid !== selector.uid) {
    return false;
  }
  if (selector.tenantId !== undefined && (session.user.tenantId ?? null) !== selector.tenantId) {
    return false;
  }
  if (selector.sessionKey !== undefined) {
    const key = sessionKeyOf(session.user);
    if (key !== selector.sessionKey) {
      return false;
    }
  }
  return true;
}

function isSameActiveSession(
  activeSession: MintedSession | null,
  candidate: MintedSession,
): boolean {
  if (activeSession === null) {
    return false;
  }
  if (activeSession === candidate) {
    return true;
  }
  if (
    activeSession.user.uid !== candidate.user.uid
    || (activeSession.user.tenantId ?? null) !== (candidate.user.tenantId ?? null)
  ) {
    return false;
  }
  const activeKey = sessionKeyOf(activeSession.user);
  const candidateKey = sessionKeyOf(candidate.user);
  if (activeKey !== undefined && candidateKey !== undefined) {
    return activeKey === candidateKey;
  }
  return true;
}

/** Record a session authenticated on `port` so held `User` handles remain actionable. */
export function rememberHeldSession(
  ctx: HostCtx,
  port: PortLike,
  session: MintedSession,
): void {
  const held = portHeldFor(ctx, port);
  const idKey = identityKey(session.user.uid, session.user.tenantId ?? null);
  held.byIdentity.set(idKey, session);
  const key = sessionKeyOf(session.user);
  if (key !== undefined) {
    held.bySessionKey.set(key, session);
  }
}

/** Replace a re-minted held session (after email/password update or reauth). */
export function replaceHeldSession(
  ctx: HostCtx,
  port: PortLike,
  previous: MintedSession,
  next: MintedSession,
): void {
  const held = portHeldFor(ctx, port);
  const prevKey = sessionKeyOf(previous.user);
  const nextKey = sessionKeyOf(next.user);
  if (prevKey !== undefined && prevKey !== nextKey && held.bySessionKey.get(prevKey) === previous) {
    held.bySessionKey.delete(prevKey);
  }
  const prevIdKey = identityKey(previous.user.uid, previous.user.tenantId ?? null);
  const nextIdKey = identityKey(next.user.uid, next.user.tenantId ?? null);
  if (prevIdKey !== nextIdKey && held.byIdentity.get(prevIdKey) === previous) {
    held.byIdentity.delete(prevIdKey);
  }
  rememberHeldSession(ctx, port, next);
}

/** Drop every held session belonging to a disconnected port. */
export function clearHeldSessions(ctx: HostCtx, port: PortLike): void {
  _heldSessions.get(ctx)?.delete(port);
}

/** Reconcile every port's held sessions after a full-state reset, import, or restore. */
export function reconcileHeldSessions(
  ctx: HostCtx,
  reconcile: (session: MintedSession) => MintedSession | null,
): void {
  const map = _heldSessions.get(ctx);
  if (map === undefined) {
    return;
  }
  for (const held of map.values()) {
    const nextByKey = new Map<string, MintedSession>();
    const nextById = new Map<string, MintedSession>();
    const visited = new Map<MintedSession, MintedSession | null>();

    const resolveOnce = (session: MintedSession): MintedSession | null => {
      if (visited.has(session)) {
        return visited.get(session) ?? null;
      }
      const updated = reconcile(session);
      visited.set(session, updated);
      return updated;
    };

    for (const session of held.bySessionKey.values()) {
      const updated = resolveOnce(session);
      if (updated === null) {
        continue;
      }
      const key = sessionKeyOf(updated.user);
      if (key !== undefined) {
        nextByKey.set(key, updated);
      }
      nextById.set(identityKey(updated.user.uid, updated.user.tenantId ?? null), updated);
    }

    for (const session of held.byIdentity.values()) {
      const updated = resolveOnce(session);
      if (updated === null) {
        continue;
      }
      const key = sessionKeyOf(updated.user);
      if (key !== undefined && !nextByKey.has(key)) {
        nextByKey.set(key, updated);
      }
      nextById.set(identityKey(updated.user.uid, updated.user.tenantId ?? null), updated);
    }

    held.bySessionKey.clear();
    for (const [key, session] of nextByKey) {
      held.bySessionKey.set(key, session);
    }
    held.byIdentity.clear();
    for (const [idKey, session] of nextById) {
      held.byIdentity.set(idKey, session);
    }
  }
}

function lookupHeldSession(
  ctx: HostCtx,
  port: PortLike,
  selector: HeldUserSelector,
): MintedSession | null {
  const held = _heldSessions.get(ctx)?.get(port);
  if (held === undefined) {
    return null;
  }
  if (selector.sessionKey !== undefined) {
    const byKey = held.bySessionKey.get(selector.sessionKey);
    if (byKey !== undefined && matchesSelector(byKey, selector)) {
      return byKey;
    }
  }
  if (selector.uid !== undefined) {
    if (selector.tenantId !== undefined) {
      const byId = held.byIdentity.get(identityKey(selector.uid, selector.tenantId));
      if (byId !== undefined) {
        return byId;
      }
      return null;
    }
    for (const candidate of held.byIdentity.values()) {
      if (candidate.user.uid === selector.uid) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveOptionalHeldSession(
  ctx: HostCtx,
  port: PortLike,
  activeSession: MintedSession | null,
  selector: HeldUserSelector,
): ResolvedHeldSession | null {
  const hasExplicitTarget = selector.uid !== undefined || selector.sessionKey !== undefined;
  if (!hasExplicitTarget) {
    if (activeSession === null) {
      return null;
    }
    return { session: activeSession, isCurrent: true };
  }
  if (activeSession !== null && matchesSelector(activeSession, selector)) {
    return { session: activeSession, isCurrent: true };
  }
  const held = lookupHeldSession(ctx, port, selector);
  if (held !== null) {
    return { session: held, isCurrent: isSameActiveSession(activeSession, held) };
  }
  return null;
}

/**
 * Resolve the target session for a user-scoped worker auth op:
 * - No explicit `uid` / `sessionKey`: acts on `activeSession` (legacy/native callers).
 * - Explicit `uid` / `sessionKey`: acts on `activeSession` when it matches, else
 *   the held session this port previously authenticated for that user.
 * - Never allows a port to address a user it never authenticated.
 */
export function requireHeldUserSession(
  ctx: HostCtx,
  port: PortLike,
  activeSession: MintedSession | null,
  selector: HeldUserSelector,
  api: string,
): ResolvedHeldSession {
  const resolved = resolveOptionalHeldSession(ctx, port, activeSession, selector);
  if (resolved !== null) {
    return resolved;
  }
  if (activeSession !== null) {
    throw new FirebaseError('auth/user-mismatch', 'The user does not belong to a session on this connection.');
  }
  throw makeNoUserError(api);
}

/**
 * Resolve the target session for `auth.reload`, preserving `auth/user-token-expired`
 * when a caller reloads a uid that has already been deleted from the pool.
 */
export function requireHeldReloadSession(
  ctx: HostCtx,
  port: PortLike,
  auth: Auth,
  activeSession: MintedSession | null,
  selector: HeldUserSelector,
): ResolvedHeldSession {
  const resolved = resolveOptionalHeldSession(ctx, port, activeSession, selector);
  if (resolved !== null) {
    return resolved;
  }
  if (typeof selector.uid === 'string') {
    const exists = authSandboxOps.listUsers(auth).some((record) => record.uid === selector.uid);
    if (!exists) {
      throw new FirebaseError(
        'auth/user-token-expired',
        "The user's credential is no longer valid. The user must sign in again.",
      );
    }
  }
  if (activeSession !== null) {
    throw new FirebaseError('auth/user-mismatch', 'The user does not belong to a session on this connection.');
  }
  throw makeNoUserError('reload');
}
