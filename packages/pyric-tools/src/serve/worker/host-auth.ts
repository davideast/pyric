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

import { type HostCtx, type PortLike, post, ok, fail } from './host-context.js';
import {
  getAuth,
  sandbox as authSandboxOps,
  type Auth,
  type MintedSession,
  type User,
} from 'pyric/auth';
import {
  serializeUser,
  type OpMessage,
  type AuthSubMessage,
} from './protocol.js';

/**
 * Synthetic password seeded for bridged provider identities (popup/redirect).
 * Provider users never authenticate with a password — this just satisfies the
 * SeedUser shape. Matches `ServeAuthHelper`'s in-page constant in spirit.
 */
const PROVIDER_SYNTHETIC_PASSWORD = '__pyric_popup_no_password__';

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

export function authSubsFor(ctx: HostCtx): Map<PortLike, Map<string, 'authState' | 'idToken'>> {
  let m = _authSubs.get(ctx);
  if (!m) {
    m = new Map();
    _authSubs.set(ctx, m);
  }
  return m;
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
  portSessionsFor(ctx).set(port, session);

  // Prod parity on auth transitions: re-establish this port's session-bound
  // Firestore listeners under the NEW identity, so a sign-out re-evaluates
  // live streams (auth-gated data is revoked, not leaked) and a sign-in
  // grants them. Studio-lens subs (explicit actAs) are untouched.
  ctx.resubscribePortSubs?.(port);

  const serialized = serializeUser(session?.user ?? null);
  const bySubId = authSubsFor(ctx).get(port);
  if (!bySubId) return;
  for (const [subId] of bySubId) {
    post(port, { t: 'snap', subId, value: serialized });
  }
}

/** Tear down a disconnected port's session (called from cleanupPort). */
export function cleanupPortSession(ctx: HostCtx, port: PortLike): void {
  ctx.portSessions?.delete(port);
}

// ─── Auth op handlers ─────────────────────────────────────────────────────

/** Serialized UserCredential reply shape for a minted session. */
function credReply(session: MintedSession, providerId: string | null) {
  return {
    user: serializeUser(session.user),
    providerId,
    operationType: 'signIn' as const,
  };
}

export async function handleAuthOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  const auth = ensureAuth(ctx);

  switch (msg.method) {
    case 'auth.createUser': {
      try {
        const session = authSandboxOps.mintSession(auth, {
          kind: 'createPassword', email: msg.email, password: msg.password,
        });
        setPortSession(ctx, port, session);
        ok(port, msg.id, credReply(session, null));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signInEmail': {
      try {
        const session = authSandboxOps.mintSession(auth, {
          kind: 'password', email: msg.email, password: msg.password,
        });
        setPortSession(ctx, port, session);
        ok(port, msg.id, credReply(session, null));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signInAnonymously': {
      try {
        // Match `firebase/auth` semantics per session: if THIS PORT is
        // already anonymous, reuse that identity (StrictMode double-mounts
        // must not leak a fresh uid per mount). Other ports' anonymous
        // sessions are other users — that's the multi-user point.
        const existing = portSession(ctx, port);
        if (existing && existing.user.isAnonymous) {
          ok(port, msg.id, credReply(existing, null));
          break;
        }
        const session = authSandboxOps.mintSession(auth, { kind: 'anonymous' });
        setPortSession(ctx, port, session);
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
      // Per-tab reload restore (#754): soft — an unknown/disabled uid means
      // signed out (null), never an error. The page clears its stale record.
      try {
        let session: MintedSession | null = null;
        try {
          session = authSandboxOps.mintSession(auth, { kind: 'uid', uid: msg.uid });
        } catch {
          session = null;
        }
        if (session) setPortSession(ctx, port, session);
        ok(port, msg.id, session ? serializeUser(session.user) : null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.getIdToken': {
      try {
        const user = requireSessionUser(ctx, port, 'getIdToken');
        const token = await user.getIdToken(msg.forceRefresh);
        ok(port, msg.id, token);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.getIdTokenResult': {
      try {
        const user = requireSessionUser(ctx, port, 'getIdTokenResult');
        const r = await user.getIdTokenResult(msg.forceRefresh);
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
      // Accepted for surface parity; the CLIENT's SessionStore owns where
      // (or whether) the session uid is recorded. Nothing to do worker-side.
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

    case 'auth.updateProfile': {
      // Update THIS PORT's signed-in user's profile (displayName / photoURL).
      // Updates the stored record (by uid) via the sandbox op, then mutates the
      // port session's `User` in place so a subsequent `auth.getCurrentUser`
      // (and the client mirror hydrated from the reply) is consistent. Does NOT
      // fire onAuthStateChanged/onIdTokenChanged — matching firebase/auth.
      try {
        const session = portSession(ctx, port);
        if (!session) throw makeNoUserError('updateProfile');
        const profile = { displayName: msg.displayName, photoURL: msg.photoURL };
        authSandboxOps.updateProfile(auth, session.user.uid, profile);
        applyProfileToUser(session.user, profile);
        ok(port, msg.id, serializeUser(session.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.acceptIdentity': {
      // Provider sign-in bridge: the page resolved a popup/redirect identity
      // in-page (ServeAuthHelper) and hands it here. Seed it into the user DB
      // (so rules `request.auth.token.*` claims resolve AND it shows in the
      // picker next time), then mint THIS PORT's session for it — provider
      // users have no password. Mirrors ServeAuthHelper.add's seeding.
      try {
        const { uid, email, displayName, customClaims, providerId } = msg.identity;
        authSandboxOps.seedUsers(auth, [{
          uid,
          email: email ?? '',
          password: PROVIDER_SYNTHETIC_PASSWORD,
          displayName: displayName ?? undefined,
          customClaims: customClaims ?? {},
          providerId,
        }]);
        const session = authSandboxOps.mintSession(auth, { kind: 'uid', uid });
        setPortSession(ctx, port, session);
        ok(port, msg.id, credReply(session, providerId));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.listUsers': {
      // Admin user-DB enumeration (Pyric Studio data browse).
      try {
        ok(port, msg.id, authSandboxOps.listUsers(auth));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminCreateUser': {
      try {
        ok(port, msg.id, authSandboxOps.createUser(
          auth,
          msg.request as Parameters<typeof authSandboxOps.createUser>[1],
        ));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminUpdateUser': {
      try {
        ok(port, msg.id, authSandboxOps.updateUser(
          auth,
          msg.uid,
          msg.request as Parameters<typeof authSandboxOps.updateUser>[2],
        ));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminDeleteUser': {
      try {
        authSandboxOps.deleteUser(auth, msg.uid);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.adminClearUsers': {
      try {
        authSandboxOps.clearUsers(auth);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown auth method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}

/** The port session's User, or throw `auth/no-current-user`. */
function requireSessionUser(ctx: HostCtx, port: PortLike, api: string): User {
  const session = portSession(ctx, port);
  if (!session) throw makeNoUserError(api);
  return session.user;
}

/**
 * Mutate a port session's `User` `displayName` / `photoURL` (and the first
 * `providerData` entry's) in place so a subsequent `auth.getCurrentUser`
 * reflects an `auth.updateProfile`. Fields are `readonly` at the type level
 * but plain data at runtime; only an explicitly-provided field is applied
 * (`null` clears, `undefined` leaves untouched).
 */
function applyProfileToUser(
  user: User,
  profile: { displayName?: string | null; photoURL?: string | null },
): void {
  const mutable = user as { -readonly [K in keyof User]: User[K] };
  if (profile.displayName !== undefined) mutable.displayName = profile.displayName;
  if (profile.photoURL !== undefined) mutable.photoURL = profile.photoURL;
  const provider0 = user.providerData?.[0] as
    | { -readonly [K in keyof NonNullable<User['providerData']>[number]]: NonNullable<User['providerData']>[number][K] }
    | undefined;
  if (provider0) {
    if (profile.displayName !== undefined) provider0.displayName = profile.displayName;
    if (profile.photoURL !== undefined) provider0.photoURL = profile.photoURL;
  }
}

/** Build an `auth/no-current-user`-style error for token ops with no user. */
function makeNoUserError(api: string): Error & { code: string } {
  const err = new Error(`${api}: no current user is signed in.`) as Error & { code: string };
  err.code = 'auth/no-current-user';
  return err;
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

  // Initial fire — mirror the real observers, which invoke the callback once
  // with the current state on registration. Per-port: THIS port's session.
  post(port, { t: 'snap', subId: msg.subId, value: serializeUser(portSession(ctx, port)?.user ?? null) });
}

export function handleAuthUnsub(ctx: HostCtx, port: PortLike, subId: string): boolean {
  const subs = authSubsFor(ctx);
  const bySubId = subs.get(port);
  if (!bySubId || !bySubId.has(subId)) return false;
  bySubId.delete(subId);
  if (bySubId.size === 0) subs.delete(port);
  return true;
}
