/**
 * SharedWorker host — auth subsystem: PER-PORT SESSIONS (#754).
 *
 * The worker hosts ONE sandbox (one user pool, one data store, one ruleset)
 * but each connected port (tab / client) owns its OWN session: sign-ins mint
 * an authentic identity via `sandbox.mintSession` (credentials validated /
 * identity really created — NOT the impersonation lens) and bind it to the
 * port. Auth-state fan-out is port-scoped: tab A signing in does not fire
 * tab B's `onAuthStateChanged`. Data ops without an explicit Studio lens
 * run under the port's session (see `sessionDb` in host.ts).
 *
 * Session persistence is CLIENT-side: the page records its uid in web
 * storage (SessionStore, honoring setPersistence) and re-establishes it on
 * reload via the `auth.restorePortSession` op. The worker holds no session
 * record — the user POOL still rides the sandbox snapshot (#629).
 *
 * Imports only from `./host-context.js` + external packages (no circular
 * imports).
 */

import { type HostCtx, type PortLike, post, ok, fail, bestEffortFlush } from './host-context.js';
import {
  getAuth,
  sandbox as authSandboxOps,
  type Auth,
  type MintedSession,
} from 'pyric/auth';
import {
  serializeUser,
  type OpMessage,
  type AuthSubMessage,
} from './protocol.js';
import {
  PROVIDER_SYNTHETIC_PASSWORD,
  seedPhotoUrl,
  credReply,
  makeNoUserError,
  requirePortSession,
  remintSessionWithClaims,
  applyProfileToUser,
  resolveOAuthCredentialUser,
} from './host/auth-session-seeder.js';

// ─── Auth: per-port sessions + port-scoped fan-out ────────────────────────

/**
 * Per-port auth subscription registry. Map<port, Map<subId, target>>.
 *
 * SEPARATE FROM `ctx.subs` (Firestore listeners): auth subs are routing
 * entries only. With per-port sessions there is no worker-wide auth
 * listener at all — a port's session changes fan out to THAT port's subs
 * (see {@link setPortSession}).
 */
const _authSubs = new WeakMap<HostCtx, Map<PortLike, Map<string, 'authState' | 'idToken'>>>();
const _portTenants = new WeakMap<HostCtx, Map<PortLike, string | null>>();
const _lastAuthStateUid = new WeakMap<PortLike, string | null>();

export function authSubsFor(ctx: HostCtx): Map<PortLike, Map<string, 'authState' | 'idToken'>> {
  let m = _authSubs.get(ctx);
  if (!m) {
    m = new Map();
    _authSubs.set(ctx, m);
  }
  return m;
}

function portTenantsFor(ctx: HostCtx): Map<PortLike, string | null> {
  let m = _portTenants.get(ctx);
  if (!m) {
    m = new Map();
    _portTenants.set(ctx, m);
  }
  return m;
}

export function portTenant(ctx: HostCtx, port: PortLike): string | null {
  return portTenantsFor(ctx).get(port) ?? null;
}

/**
 * Lazily create the ONE shared auth handle — the user pool + admin surface.
 * Calling `getAuth(sandbox)` also (re)registers the auth service with the
 * persistence registry, so the user DB rides the snapshot (#629). Its
 * `currentUser` is never set in served mode; sessions live per-port.
 *
 * Idempotent: returns the cached `ctx.auth` on repeat calls.
 */
export function ensureAuth(ctx: HostCtx): Auth {
  if (ctx.auth) return ctx.auth;
  ctx.auth = getAuth(ctx.sandbox);
  if (ctx.sessionMode === undefined) ctx.sessionMode = 'LOCAL';
  return ctx.auth;
}

function portSessionsFor(ctx: HostCtx): Map<PortLike, MintedSession | null> {
  return (ctx.portSessions ??= new Map());
}

/** The port's signed-in session, or null (absent from the map = signed out). */
export function portSession(ctx: HostCtx, port: PortLike): MintedSession | null {
  return portSessionsFor(ctx).get(port) ?? null;
}

/**
 * Bind (or clear) a port's session and fan the change out to THAT PORT's
 * authState/idToken subs — the per-port analog of the old cross-tab
 * broadcast. Every sign-in mints a fresh token (mintSession did), so the
 * idToken stream fires alongside authState, matching the real observers.
 */
function setPortSession(ctx: HostCtx, port: PortLike, session: MintedSession | null): void {
  const tenant = portTenant(ctx, port);
  if (session) {
    session.state.tenant = tenant ?? undefined;
    (session.user as { tenantId?: string | null }).tenantId = tenant ?? null;
  }
  portSessionsFor(ctx).set(port, session);

  // Clear cached session handles so they rebuild with the new session/tenant state
  ctx.sessionDbs?.clear();
  ctx.sessionRtdbs?.clear();
  ctx.sessionStorages?.clear();

  // Prod parity on auth transitions: re-establish this port's session-bound
  // Firestore/RTDB listeners under the NEW identity, so a sign-out re-evaluates
  // live streams (auth-gated data is revoked, not leaked) and a sign-in
  // grants them. Studio-lens subs (explicit actAs) are untouched.
  ctx.resubscribePortSubs?.(port);

  const newUid = session?.user.uid ?? null;
  const lastUid = _lastAuthStateUid.has(port) ? _lastAuthStateUid.get(port)! : null;
  const uidChanged = newUid !== lastUid;
  _lastAuthStateUid.set(port, newUid);

  const serialized = serializeUser(session?.user ?? null);
  const bySubId = authSubsFor(ctx).get(port);
  if (!bySubId) return;
  for (const [subId, target] of bySubId) {
    if (target === 'authState') {
      if (uidChanged) {
        post(port, { t: 'snap', subId, value: serialized });
      }
    } else {
      post(port, { t: 'snap', subId, value: serialized });
    }
  }
}

/** Apply a forced ID-token refresh to this port's data authorization state. */
function refreshPortAuthorization(
  ctx: HostCtx,
  port: PortLike,
  session: MintedSession,
  claims: Record<string, unknown>,
): void {
  session.state.token = { ...claims };

  // Frozen sandbox.withAuth handles capture the old token. Clear all
  // session-handle caches so this port and any same-uid sibling rebuild from
  // their own current session state on the next operation.
  ctx.sessionDbs?.clear();
  ctx.sessionRtdbs?.clear();
  ctx.sessionStorages?.clear();

  // Existing Firestore/RTDB streams must reauthorize under the refreshed
  // claims. A token refresh is not an auth-state transition, so notify only
  // onIdTokenChanged observers with the still-current user.
  ctx.resubscribePortSubs?.(port);
  const serialized = serializeUser(session.user);
  for (const [subId, target] of authSubsFor(ctx).get(port) ?? []) {
    if (target === 'idToken') post(port, { t: 'snap', subId, value: serialized });
  }
}

/** Tear down a disconnected port's session (called from cleanupPort). */
export function cleanupPortSession(ctx: HostCtx, port: PortLike): void {
  ctx.portSessions?.delete(port);
  portTenantsFor(ctx).delete(port);
  _lastAuthStateUid.delete(port);
}

// ─── Auth op handlers ─────────────────────────────────────────────────────

export async function handleAuthOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  const auth = ensureAuth(ctx);

  switch (msg.method) {
    case 'auth.createUser': {
      try {
        const session = authSandboxOps.mintSession(auth, {
          kind: 'createPassword', email: msg.email, password: msg.password,
          tenantId: msg.tenantId ?? null,
        });
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx); // new user record must be durable at ack
        ok(port, msg.id, credReply(session, null));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signInEmail': {
      try {
        const session = authSandboxOps.mintSession(auth, {
          kind: 'password', email: msg.email, password: msg.password,
          tenantId: msg.tenantId ?? null,
        });
        setPortSession(ctx, port, session);
        ok(port, msg.id, credReply(session, null));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signInAnonymously': {
      try {
        const existing = portSession(ctx, port);
        if (existing && existing.user.isAnonymous) {
          ok(port, msg.id, credReply(existing, null));
          break;
        }
        const session = authSandboxOps.mintSession(auth, {
          kind: 'anonymous', tenantId: msg.tenantId ?? null,
        });
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx);
        ok(port, msg.id, credReply(session, null));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signOut': {
      try {
        setPortSession(ctx, port, null);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.restorePortSession': {
      try {
        let session: MintedSession | null = null;
        try {
          session = authSandboxOps.mintSession(auth, {
            kind: 'uid', uid: msg.uid, tenantId: msg.tenantId ?? null,
          });
        } catch {
          session = null;
        }
        setPortSession(ctx, port, session);
        ok(port, msg.id, session ? serializeUser(session.user) : null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.getIdToken': {
      try {
        const session = requirePortSession(portSession(ctx, port), 'getIdToken');
        const user = session.user;
        const token = await user.getIdToken(msg.forceRefresh);
        if (msg.forceRefresh) {
          const result = await user.getIdTokenResult(false);
          refreshPortAuthorization(ctx, port, session, result.claims);
        }
        ok(port, msg.id, token);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.getIdTokenResult': {
      try {
        const session = requirePortSession(portSession(ctx, port), 'getIdTokenResult');
        const user = session.user;
        const r = await user.getIdTokenResult(msg.forceRefresh);
        if (msg.forceRefresh) refreshPortAuthorization(ctx, port, session, r.claims);
        ok(port, msg.id, {
          token: r.token,
          claims: r.claims,
          expirationTime: r.expirationTime,
          issuedAtTime: r.issuedAtTime,
          authTime: r.authTime,
          signInProvider: r.signInProvider ?? null,
        });
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.setPersistence': {
      ctx.sessionMode = msg.mode;
      ok(port, msg.id, null);
      break;
    }

    case 'auth.getCurrentUser': {
      try {
        ok(port, msg.id, serializeUser(portSession(ctx, port)?.user ?? null));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.setTenantId': {
      try {
        portTenantsFor(ctx).set(port, msg.tenantId);
        const session = portSession(ctx, port);
        if (session) {
          session.state.tenant = msg.tenantId ?? undefined;
          (session.user as { tenantId?: string | null }).tenantId = msg.tenantId ?? null;
          ctx.sessionDbs?.clear();
          ctx.sessionRtdbs?.clear();
          ctx.sessionStorages?.clear();
          ctx.resubscribePortSubs?.(port);
          const serialized = serializeUser(session.user);
          for (const [subId, target] of authSubsFor(ctx).get(port) ?? []) {
            if (target === 'idToken') post(port, { t: 'snap', subId, value: serialized });
          }
        }
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updateProfile': {
      try {
        const session = portSession(ctx, port);
        if (!session) throw makeNoUserError('updateProfile');
        const profile = { displayName: msg.displayName, photoURL: msg.photoURL };
        authSandboxOps.updateProfile(auth, session.user.uid, profile);
        applyProfileToUser(session.user, profile);
        await bestEffortFlush(ctx);
        const serialized = serializeUser(session.user);
        for (const [subId, target] of authSubsFor(ctx).get(port) ?? []) {
          if (target === 'idToken') {
            post(port, { t: 'snap', subId, value: serialized });
          }
        }
        ok(port, msg.id, serialized);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.reload': {
      try {
        const session = requirePortSession(portSession(ctx, port), 'reload');
        const freshSession = remintSessionWithClaims(auth, session);
        setPortSession(ctx, port, freshSession);
        ok(port, msg.id, serializeUser(freshSession.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.deleteUser': {
      try {
        const session = requirePortSession(portSession(ctx, port), 'deleteUser');
        authSandboxOps.deleteUser(auth, session.user.uid);
        setPortSession(ctx, port, null);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updateEmail': {
      try {
        const session = requirePortSession(portSession(ctx, port), 'updateEmail');
        authSandboxOps.updateUser(auth, session.user.uid, { email: msg.email });
        const freshSession = remintSessionWithClaims(auth, session);
        setPortSession(ctx, port, freshSession);
        await bestEffortFlush(ctx);
        ok(port, msg.id, serializeUser(freshSession.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updatePassword': {
      try {
        const session = requirePortSession(portSession(ctx, port), 'updatePassword');
        authSandboxOps.updateUser(auth, session.user.uid, { password: msg.password });
        const freshSession = remintSessionWithClaims(auth, session);
        setPortSession(ctx, port, freshSession);
        await bestEffortFlush(ctx);
        ok(port, msg.id, serializeUser(freshSession.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updateCurrentUser': {
      try {
        if (msg.uid === null) {
          setPortSession(ctx, port, null);
          ok(port, msg.id, null);
        } else {
          const freshSession = authSandboxOps.mintSession(auth, {
            kind: 'uid',
            uid: msg.uid,
          });
          setPortSession(ctx, port, freshSession);
          ok(port, msg.id, serializeUser(freshSession.user));
        }
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signInWithCredential': {
      try {
        const uid = resolveOAuthCredentialUser(auth, msg.credential);
        const session = authSandboxOps.mintSession(auth, { kind: 'uid', uid });
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx);
        ok(port, msg.id, credReply(session, msg.credential.providerId));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updateEmail': {
      try {
        const session = portSession(ctx, port);
        if (!session) throw makeNoUserError('updateEmail');
        const email = msg.email ?? (msg as { newEmail?: string }).newEmail ?? '';
        authSandboxOps.updateUser(auth, session.user.uid, { email });
        (session.user as { email: string | null }).email = email;
        await bestEffortFlush(ctx);
        ok(port, msg.id, serializeUser(session.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updatePassword': {
      try {
        const session = portSession(ctx, port);
        if (!session) throw makeNoUserError('updatePassword');
        const password = msg.password ?? (msg as { newPassword?: string }).newPassword ?? '';
        authSandboxOps.updateUser(auth, session.user.uid, { password });
        await bestEffortFlush(ctx);
        ok(port, msg.id, serializeUser(session.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.deleteUser': {
      try {
        const session = portSession(ctx, port);
        if (!session) throw makeNoUserError('deleteUser');
        authSandboxOps.deleteUser(auth, session.user.uid);
        setPortSession(ctx, port, null);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.acceptIdentity': {
      try {
        const { uid, email, displayName, photoURL, customClaims, providerId } = msg.identity;
        authSandboxOps.assertAuthProviderEnabled(auth, providerId);
        authSandboxOps.seedUsers(auth, [{
          uid,
          email: email ?? '',
          password: PROVIDER_SYNTHETIC_PASSWORD,
          displayName: displayName ?? undefined,
          photoUrl: seedPhotoUrl(auth, uid, photoURL),
          customClaims: customClaims ?? {},
          providerId,
        }]);
        const session = authSandboxOps.mintSession(auth, {
          kind: 'uid', uid, tenantId: msg.tenantId ?? null,
        });
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx);
        ok(port, msg.id, credReply(session, providerId));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.listUsers': {
      try {
        ok(port, msg.id, authSandboxOps.listUsers(auth));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminCreateUser': {
      try {
        const created = authSandboxOps.createUser(
          auth,
          msg.request as Parameters<typeof authSandboxOps.createUser>[1],
        );
        await bestEffortFlush(ctx);
        ok(port, msg.id, created);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminUpdateUser': {
      try {
        const updated = authSandboxOps.updateUser(
          auth,
          msg.uid,
          msg.request as Parameters<typeof authSandboxOps.updateUser>[2],
        );
        await bestEffortFlush(ctx);
        ok(port, msg.id, updated);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminDeleteUser': {
      try {
        authSandboxOps.deleteUser(auth, msg.uid);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminClearUsers': {
      try {
        authSandboxOps.clearUsers(auth);
        await bestEffortFlush(ctx);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.getProviderConfig': {
      try {
        ok(port, msg.id, authSandboxOps.getAuthProviderConfig(auth));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.setProviderConfig': {
      try {
        authSandboxOps.setAuthProviderConfig(auth, msg.providerId, msg.enabled);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown auth method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}

export function isAuthOp(method: OpMessage['method']): boolean {
  return method.startsWith('auth.');
}

// ─── Auth subscription handlers ───────────────────────────────────────────

/**
 * Register an auth subscription for a port. A routing entry only — the
 * port's session changes (its own sign-ins/outs) fan out to it via
 * {@link setPortSession}. Fires the PORT's current session immediately
 * (initial-fire parity with onAuthStateChanged/onIdTokenChanged).
 */
export function handleAuthSub(ctx: HostCtx, port: PortLike, msg: AuthSubMessage): void {
  ensureAuth(ctx);
  const subs = authSubsFor(ctx);
  let bySubId = subs.get(port);
  if (!bySubId) {
    bySubId = new Map();
    subs.set(port, bySubId);
  }
  if (bySubId.has(msg.subId)) return; // idempotent
  bySubId.set(msg.subId, msg.target);

  const currentUser = portSession(ctx, port)?.user ?? null;
  if (msg.target === 'authState' && !_lastAuthStateUid.has(port)) {
    _lastAuthStateUid.set(port, currentUser?.uid ?? null);
  }

  // Initial fire — mirror the real observers, which invoke the callback once
  // with the current state on registration. Per-port: THIS port's session.
  post(port, { t: 'snap', subId: msg.subId, value: serializeUser(currentUser) });
}

export function handleAuthUnsub(ctx: HostCtx, port: PortLike, subId: string): boolean {
  const subs = authSubsFor(ctx);
  const bySubId = subs.get(port);
  if (!bySubId || !bySubId.has(subId)) return false;
  bySubId.delete(subId);
  if (bySubId.size === 0) subs.delete(port);
  return true;
}
