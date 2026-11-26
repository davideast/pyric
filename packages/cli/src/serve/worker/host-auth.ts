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

import { type HostCtx, type PortLike, post, ok, fail, bestEffortFlush, clearRtdbSessionHandles, hostProjectId } from './host-context.js';
import {
  deleteUser,
  getAuth,
  reload,
  sandbox as authSandboxOps,
  updatePassword,
  type Auth,
  type MintedSession,
} from 'pyric/auth';
import {
  type OpMessage,
  type AuthSubMessage,
} from './protocol.js';
import {
  credReply,
  remintSessionWithClaims,
  applyProfileToUser,
  resolveOAuthCredentialUser,
  serializeIdTokenResultForWire,
  serializeSessionUser as serializeUser,
} from './host/auth-session-seeder.js';
import {
  clearHeldSessions,
  reconcileHeldSessions,
  rememberHeldSession,
  replaceHeldSession,
  requireHeldReloadSession,
  requireHeldUserSession,
} from './host/auth-held-sessions.js';
import {
  signInWithBlockedCredentialPayload,
  type CredentialPayload,
} from './host/auth-credential-sign-in.js';
import {
  cleanupPortAuthBlocking,
  handleAuthBlockingRespond,
  handleAuthBlockingSub,
  handleAuthBlockingUnsub,
} from './host/auth-blocking.js';
import { authStateFromServerIdToken } from 'pyric/app/internal';
import { getClock, isPastIdTokenRefreshPoint, rulesTokenFromIdToken } from 'pyric/sandbox/internal';
import {
  createBlockedAnonymousUser,
  createBlockedEmailPasswordUser,
  hasBeforeCreateHook,
  hasBeforeSignInHook,
  resolveBlockedFederatedIdentity,
  sessionKeyOf,
  signInBlockedEmailPasswordUser,
} from 'pyric/auth/internal';
import { isPlainRecord, STANDARD_TOKEN_CLAIMS } from '../repro/token-claims.js';

import { linkSessionProvider } from './host/auth-linking.js';
import { reauthenticateSession } from './host/auth-reauthentication.js';
import { alignSessionTenant, updatePortSessionEmail } from './host/auth-session-tenant.js';
import { handleAuthAdminOp, isAuthAdminOp } from './host/auth-admin.js';
import { createStagedSignInResults, type StagedSignInResults } from './host/staged-sign-in-results.js';

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
const _portOrigins = new WeakMap<PortLike, string>();

export function authSubsFor(ctx: HostCtx): Map<PortLike, Map<string, 'authState' | 'idToken'>> {
  let m = _authSubs.get(ctx);
  if (!m) {
    m = new Map();
    _authSubs.set(ctx, m);
  }
  return m;
}

const _stagedSignInResults = new WeakMap<HostCtx, StagedSignInResults>();

/** The sign-in results each of this host's ports staged (`auth.mockSignInResult`). */
export function stagedSignInResultsFor(ctx: HostCtx): StagedSignInResults {
  let staged = _stagedSignInResults.get(ctx);
  if (!staged) {
    staged = createStagedSignInResults();
    _stagedSignInResults.set(ctx, staged);
  }
  return staged;
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

/** Record the page origin an app port's client stated in its `appConfig`. */
export function setPortOrigin(port: PortLike, origin: string): void {
  _portOrigins.set(port, origin);
}

/** The port's page origin as a mint-request scope, empty when unknown. */
export function portOriginScope(port: PortLike): { origin?: string } {
  const origin = _portOrigins.get(port);
  return origin === undefined ? {} : { origin };
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
  // Minted ID tokens name the served project in `iss` and `aud`, as the
  // page's in-page plane does from `app.options.projectId`.
  authSandboxOps.setProjectIdSource(ctx.auth, () => hostProjectId(ctx));
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

export function resolveSignInTenant(
  ctx: HostCtx,
  port: PortLike,
  explicitTenantId: string | null | undefined,
): string | null {
  if (explicitTenantId === null) {
    portTenantsFor(ctx).delete(port);
    return null;
  }
  if (explicitTenantId !== undefined) {
    return explicitTenantId;
  }
  return portTenant(ctx, port);
}

/**
 * Bind (or clear) a port's session and fan the change out to THAT PORT's
 * authState/idToken subs — the per-port analog of the old cross-tab
 * broadcast. Every sign-in mints a fresh token (mintSession did), so the
 * idToken stream fires alongside authState, matching the real observers.
 */
function setPortSession(
  ctx: HostCtx,
  port: PortLike,
  session: MintedSession | null,
  options?: { skipResubscribe?: boolean },
): void {
  if (session) {
    alignSessionTenant(session);
    rememberHeldSession(ctx, port, session);
  }
  portSessionsFor(ctx).set(port, session);

  // Clear cached session handles so they rebuild with the new session/tenant state
  ctx.sessionDbs?.clear();
  clearRtdbSessionHandles(ctx);
  ctx.sessionStorages?.clear();

  // Prod parity on auth transitions: re-establish this port's session-bound
  // Firestore/RTDB listeners under the NEW identity, so a sign-out re-evaluates
  // live streams (auth-gated data is revoked, not leaked) and a sign-in
  // grants them. Studio-lens subs (explicit actAs) are untouched.
  if (!options?.skipResubscribe) {
    ctx.resubscribePortSubs?.(port);
  }

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

export { setPortSession };

/**
 * `@firebase/auth`'s `_logoutIfInvalidated` for one port: a refresh or an
 * account lookup refused with `auth/user-disabled` or `auth/user-token-expired`
 * signs the port's user out, so the page's auth listeners see null, before
 * the error reaches the caller.
 */
function signOutPortIfInvalidated(ctx: HostCtx, port: PortLike, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  const invalidated = code === 'auth/user-disabled' || code === 'auth/user-token-expired';
  const hasSession = portSession(ctx, port) !== null;
  if (invalidated && hasSession) setPortSession(ctx, port, null);
}

/** Reconcile every connected port's session with `ctx.auth` after a full-state reset, import, or restore. */
export function reconcilePortSessions(ctx: HostCtx): Set<PortLike> {
  ctx.sessionDbs?.clear();
  clearRtdbSessionHandles(ctx);
  ctx.sessionStorages?.clear();
  const changed = new Set<PortLike>();
  const auth = ensureAuth(ctx);
  reconcileHeldSessions(ctx, (session) => reconciledSession(auth, session));
  if (!ctx.portSessions || ctx.portSessions.size === 0) return changed;
  for (const [port, session] of [...ctx.portSessions]) {
    if (session === null) continue;
    const refreshed = reconciledSession(auth, session);
    setPortSession(ctx, port, refreshed, { skipResubscribe: true });
    changed.add(port);
  }
  return changed;
}

/**
 * A port session minted again from the account store, or null to sign the
 * port out. The mint is a refresh-token exchange: a missing account, or one
 * the refresh check refuses (disabled, deleted, or revoked after the session
 * authenticated), signs the port out.
 */
function reconciledSession(auth: Auth, session: MintedSession): MintedSession | null {
  const providerClaim = (session.state.token?.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider;
  const kind = providerClaim === 'custom' ? 'custom' : 'uid';
  try {
    return authSandboxOps.mintSession(auth, {
      kind,
      uid: session.user.uid,
      tenantId: session.user.tenantId ?? null,
      from: session.user,
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const signsOut = code === 'auth/user-not-found' || code === 'auth/user-disabled' || code === 'auth/user-token-expired';
    if (signsOut) return null;
    throw error;
  }
}

/**
 * Whether this port's session holds a token past its refresh point, so the
 * read it just made minted a new one (or returned one a sibling port with the
 * same identity minted). A sign-in on another port does not count: this
 * port's own token is still current.
 */
function sessionTokenExpired(ctx: HostCtx, session: MintedSession): boolean {
  return isPastIdTokenRefreshPoint(session.state.token, getClock(ctx.sandbox).now());
}

/** Apply a refreshed ID token to this port's data authorization state. */
function refreshPortAuthorization(
  ctx: HostCtx,
  port: PortLike,
  session: MintedSession,
  claims: Record<string, unknown>,
): void {
  // Rules read the token's full claim set, JWT registered claims included,
  // as the in-process session does.
  session.state.token = rulesTokenFromIdToken(claims);

  // Frozen sandbox.withAuth handles capture the old token. Clear all
  // session-handle caches so this port and any same-uid sibling rebuild from
  // their own current session state on the next operation.
  ctx.sessionDbs?.clear();
  clearRtdbSessionHandles(ctx);
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
  clearHeldSessions(ctx, port);
  portTenantsFor(ctx).delete(port);
  _lastAuthStateUid.delete(port);
  stagedSignInResultsFor(ctx).clear(port);
  cleanupPortAuthBlocking(ctx, ctx.auth, port);
}

function resolveServerTokenProjectId(
  ctx: HostCtx,
  rawExpectedProjectId: unknown,
): { ok: true; projectId: string | undefined } | { ok: false } {
  const hostProject = hostProjectId(ctx);
  let clientProject: string | undefined;
  if (rawExpectedProjectId !== undefined) {
    if (typeof rawExpectedProjectId !== 'string' || rawExpectedProjectId.length === 0) {
      return { ok: false };
    }
    clientProject = rawExpectedProjectId;
  }
  if (hostProject !== undefined && clientProject !== undefined && hostProject !== clientProject) {
    return { ok: false };
  }
  if (hostProject !== undefined) {
    return { ok: true, projectId: hostProject };
  }
  return { ok: true, projectId: clientProject };
}

function restoreServerIdTokenSession(
  ctx: HostCtx,
  port: PortLike,
  auth: Auth,
  rawRestore: Record<string, unknown>,
): MintedSession | null {
  const rawToken = rawRestore.authIdToken;
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    return null;
  }
  const projectResolution = resolveServerTokenProjectId(ctx, rawRestore.expectedProjectId);
  if (!projectResolution.ok) {
    return null;
  }
  const verifiedState = authStateFromServerIdToken(
    rawToken,
    projectResolution.projectId,
    ctx.sandbox,
  );
  if (verifiedState === null) {
    return null;
  }
  const tokenTenantId = verifiedState.tenant ?? null;
  let verifiedSession: MintedSession | null = null;
  try {
    verifiedSession = authSandboxOps.mintSession(auth, {
      kind: 'uid',
      uid: verifiedState.uid,
      tenantId: tokenTenantId,
      restore: {},
      ...portOriginScope(port),
    });
  } catch (err) {
    // Unknown, disabled, deleted, or cross-tenant accounts fail closed.
    void err;
    return null;
  }
  verifiedSession.state.token = verifiedState.token;
  verifiedSession.state.tenant = verifiedState.tenant;
  return verifiedSession;
}

// ─── Auth op handlers ─────────────────────────────────────────────────────

export async function handleAuthOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  const auth = ensureAuth(ctx);
  if (isAuthAdminOp(msg)) {
    await handleAuthAdminOp(ctx, port, auth, msg);
    return;
  }

  switch (msg.method) {
    case 'auth.createUser': {
      try {
        const tenantId = resolveSignInTenant(ctx, port, msg.tenantId);
        let session: MintedSession;
        if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
          const created = await createBlockedEmailPasswordUser(auth, {
            email: msg.email,
            password: msg.password,
            tenantId,
          });
          session = authSandboxOps.mintSession(auth, {
            kind: 'provider',
            uid: created.user.uid,
            providerId: 'password',
            tenantId,
            sessionClaims: created.sessionClaims,
            ...portOriginScope(port),
          });
        } else {
          session = authSandboxOps.mintSession(auth, {
            kind: 'createPassword', email: msg.email, password: msg.password,
            tenantId, ...portOriginScope(port),
          });
        }
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx, msg.method); // new user record must be durable at ack
        ok(port, msg.id, credReply(session, null, true));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signInEmail': {
      try {
        const tenantId = resolveSignInTenant(ctx, port, msg.tenantId);
        let session: MintedSession;
        if (hasBeforeSignInHook(auth)) {
          const signedIn = await signInBlockedEmailPasswordUser(auth, {
            email: msg.email,
            password: msg.password,
            tenantId,
          });
          session = authSandboxOps.mintSession(auth, {
            kind: 'provider',
            uid: signedIn.user.uid,
            providerId: 'password',
            tenantId,
            sessionClaims: signedIn.sessionClaims,
            ...portOriginScope(port),
          });
        } else {
          session = authSandboxOps.mintSession(auth, {
            kind: 'password', email: msg.email, password: msg.password,
            tenantId, ...portOriginScope(port),
          });
        }
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, credReply(session, null, false));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.signInAnonymously': {
      try {
        const tenantId = resolveSignInTenant(ctx, port, msg.tenantId);
        const existing = portSession(ctx, port);
        const hasAnonymousSession =
          existing !== null
          && existing.user.isAnonymous
          && (existing.user.tenantId ?? null) === tenantId;
        if (hasAnonymousSession) {
          ok(port, msg.id, credReply(existing, null, false));
          break;
        }
        let session: MintedSession;
        if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
          const created = await createBlockedAnonymousUser(auth, { tenantId });
          session = authSandboxOps.mintSession(auth, {
            kind: 'provider',
            uid: created.user.uid,
            providerId: 'anonymous',
            tenantId,
            sessionClaims: created.sessionClaims,
            ...portOriginScope(port),
          });
        } else {
          session = authSandboxOps.mintSession(auth, {
            kind: 'anonymous', tenantId, ...portOriginScope(port),
          });
        }
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, credReply(session, null, true));
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
        const rawRestore = msg as unknown as Record<string, unknown>;
        if (Object.hasOwn(rawRestore, 'authIdToken') && rawRestore.authIdToken !== undefined) {
          const verifiedSession = restoreServerIdTokenSession(ctx, port, auth, rawRestore);
          setPortSession(ctx, port, verifiedSession);
          let restoredUser = null;
          if (verifiedSession !== null) {
            restoredUser = serializeUser(verifiedSession.user);
          }
          ok(port, msg.id, restoredUser);
          break;
        }
        const tenantId = resolveSignInTenant(ctx, port, msg.tenantId);
        const hasRecordedClaims =
          (Object.hasOwn(rawRestore, 'customClaims') && rawRestore.customClaims !== undefined)
          || rawRestore.hasCustomClaims === true;
        const recordedClaims: Record<string, unknown> = isPlainRecord(rawRestore.customClaims)
          ? rawRestore.customClaims
          : {};
        const recordedProvider =
          typeof rawRestore.signInProvider === 'string' && rawRestore.signInProvider.length > 0
            ? rawRestore.signInProvider
            : undefined;
        let session: MintedSession | null = null;
        try {
          // A reload hands back the key of the session the page held, which
          // resumes it with the authentication time it had (#1950). Repro
          // replay also passes the recorded unrefreshed customClaims snapshot.
          session = authSandboxOps.mintSession(auth, {
            kind: 'uid',
            uid: msg.uid,
            tenantId,
            restore: {
              sessionKey: msg.sessionKey,
              ...(hasRecordedClaims ? { customClaims: recordedClaims } : {}),
              ...(recordedProvider !== undefined ? { signInProvider: recordedProvider } : {}),
            } as { sessionKey?: string },
            ...portOriginScope(port),
          });
        } catch {
          session = null;
        }
        if (session !== null && (hasRecordedClaims || recordedProvider !== undefined) && session.state.token) {
          const nextToken: Record<string, unknown> = {};
          for (const [claimKey, claimVal] of Object.entries(session.state.token)) {
            if (STANDARD_TOKEN_CLAIMS.has(claimKey)) {
              Object.defineProperty(nextToken, claimKey, {
                value: claimVal,
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
          }
          if (recordedProvider !== undefined && isPlainRecord(nextToken.firebase)) {
            nextToken.firebase = { ...nextToken.firebase, sign_in_provider: recordedProvider };
          }
          if (hasRecordedClaims) {
            for (const [claimKey, claimVal] of Object.entries(recordedClaims)) {
              if (!STANDARD_TOKEN_CLAIMS.has(claimKey)) {
                Object.defineProperty(nextToken, claimKey, {
                  value: claimVal,
                  writable: true,
                  enumerable: true,
                  configurable: true,
                });
              }
            }
          }
          session.state.token = nextToken;
        }
        setPortSession(ctx, port, session);
        const restoredSession = session;
        const hasSession = restoredSession !== null;
        ok(port, msg.id, hasSession ? serializeUser(restoredSession.user) : null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.getIdToken': {
      let isCurrent = false;
      try {
        const target = requireHeldUserSession(ctx, port, portSession(ctx, port), msg, 'getIdToken');
        isCurrent = target.isCurrent;
        const session = target.session;
        const result = await session.user.getIdTokenResult(msg.forceRefresh);
        const refreshesClaims = msg.forceRefresh === true || sessionTokenExpired(ctx, session);
        if (refreshesClaims) {
          if (isCurrent) {
            refreshPortAuthorization(ctx, port, session, result.claims);
          } else {
            session.state.token = rulesTokenFromIdToken(result.claims);
          }
        }
        ok(port, msg.id, result.token);
      } catch (e) {
        if (isCurrent) signOutPortIfInvalidated(ctx, port, e);
        fail(port, msg.id, e);
      }
      break;
    }

    case 'auth.getIdTokenResult': {
      let isCurrent = false;
      try {
        const target = requireHeldUserSession(ctx, port, portSession(ctx, port), msg, 'getIdTokenResult');
        isCurrent = target.isCurrent;
        const session = target.session;
        const r = await session.user.getIdTokenResult(msg.forceRefresh);
        const refreshesClaims = msg.forceRefresh === true || sessionTokenExpired(ctx, session);
        if (refreshesClaims) {
          if (isCurrent) {
            refreshPortAuthorization(ctx, port, session, r.claims);
          } else {
            session.state.token = rulesTokenFromIdToken(r.claims);
          }
        }
        ok(port, msg.id, serializeIdTokenResultForWire(r));
      } catch (e) {
        if (isCurrent) signOutPortIfInvalidated(ctx, port, e);
        fail(port, msg.id, e);
      }
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
        if (msg.tenantId === null) {
          portTenantsFor(ctx).delete(port);
        } else {
          portTenantsFor(ctx).set(port, msg.tenantId);
        }
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updateProfile': {
      try {
        const { session } = requireHeldUserSession(ctx, port, portSession(ctx, port), msg, 'updateProfile');
        const profile = { displayName: msg.displayName, photoURL: msg.photoURL };
        authSandboxOps.updateProfile(auth, session.user.uid, profile);
        applyProfileToUser(session.user, profile);
        await bestEffortFlush(ctx, msg.method);
        const serialized = serializeUser(session.user);
        ok(port, msg.id, serialized);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.reload': {
      let isCurrent = false;
      try {
        const target = requireHeldReloadSession(ctx, port, auth, portSession(ctx, port), msg);
        isCurrent = target.isCurrent;
        const session = target.session;
        // `reload(user)` refreshes `User` profile properties in-place via
        // `accounts:lookup` without exchanging the refresh token or minting a
        // new ID token (`auth-request-auth-per-sign-in.json`).
        await reload(session.user);
        const serialized = serializeUser(session.user);
        if (isCurrent) {
          for (const [subId, targetSub] of authSubsFor(ctx).get(port) ?? []) {
            const isTokenSubscription = targetSub === 'idToken';
            if (isTokenSubscription) {
              post(port, { t: 'snap', subId, value: serialized });
            }
          }
        }
        ok(port, msg.id, serialized);
      } catch (e) {
        if (isCurrent) signOutPortIfInvalidated(ctx, port, e);
        fail(port, msg.id, e);
      }
      break;
    }

    case 'auth.deleteUser': {
      try {
        const { session, isCurrent } = requireHeldUserSession(
          ctx,
          port,
          portSession(ctx, port),
          msg,
          'deleteUser',
        );
        const uid = session.user.uid;
        const accountExists = authSandboxOps.listUsers(auth).some((record) => record.uid === uid);
        // An account removed out of band reports `auth/user-not-found`
        // through the store's own delete; a live account goes through the
        // engine's deleteUser so the recent-login gate applies.
        if (accountExists) await deleteUser(session.user);
        else authSandboxOps.deleteUser(auth, uid);
        if (isCurrent) setPortSession(ctx, port, null);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updateEmail': {
      try {
        const { session, isCurrent } = requireHeldUserSession(
          ctx,
          port,
          portSession(ctx, port),
          msg,
          'updateEmail',
        );
        const email = msg.email ?? msg.newEmail ?? '';
        const { session: nextSession, changed } = await updatePortSessionEmail(auth, session, email);
        if (changed) {
          replaceHeldSession(ctx, port, session, nextSession);
          if (isCurrent) setPortSession(ctx, port, nextSession);
          await bestEffortFlush(ctx, msg.method);
        }
        ok(port, msg.id, serializeUser(nextSession.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updatePassword': {
      try {
        const { session, isCurrent } = requireHeldUserSession(
          ctx,
          port,
          portSession(ctx, port),
          msg,
          'updatePassword',
        );
        const password = msg.password ?? msg.newPassword ?? '';
        await updatePassword(session.user, password);
        const freshSession = remintSessionWithClaims(auth, session);
        replaceHeldSession(ctx, port, session, freshSession);
        if (isCurrent) setPortSession(ctx, port, freshSession);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, serializeUser(freshSession.user));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.updateCurrentUser': {
      try {
        const uid = msg.uid;
        const signsOut = uid === null;
        if (signsOut) {
          setPortSession(ctx, port, null);
          ok(port, msg.id, null);
        } else {
          const tenantId = resolveSignInTenant(ctx, port, msg.tenantId);
          // The user's session continues: the one its key names, or this
          // port's own when it holds the uid. Without either the session has
          // no sign-in time of its own, so a revocation refuses it (#1950).
          const held = portSession(ctx, port)?.user;
          const heldKey = held?.uid === uid ? sessionKeyOf(held) : undefined;
          const freshSession = authSandboxOps.mintSession(auth, {
            kind: 'uid',
            uid,
            tenantId,
            restore: { sessionKey: msg.sessionKey ?? heldKey },
          });
          setPortSession(ctx, port, freshSession);
          ok(port, msg.id, serializeUser(freshSession.user));
        }
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.reauthenticateWithCredential':
    case 'auth.reauthenticateWithProvider': {
      try {
        const target = requireHeldUserSession(ctx, port, portSession(ctx, port), msg, msg.method);
        const { session, providerId } = await reauthenticateSession(target.session, msg);
        replaceHeldSession(ctx, port, target.session, session);
        const stillOwnsSession = target.isCurrent && portSession(ctx, port) === target.session;
        if (stillOwnsSession) setPortSession(ctx, port, session);
        ok(port, msg.id, { ...credReply(session, providerId), operationType: 'reauthenticate' });
      } catch (error) { fail(port, msg.id, error); }
      break;
    }

    case 'auth.linkWithCredential':
    case 'auth.unlink': {
      try {
        const original = portSession(ctx, port);
        const session = await linkSessionProvider(auth, original, msg);
        await bestEffortFlush(ctx, msg.method);
        const stillOwnsSession = portSession(ctx, port) === original;
        if (stillOwnsSession) setPortSession(ctx, port, session);
        const isLink = msg.method === 'auth.linkWithCredential';
        if (isLink) {
          const isPassword = msg.credential.providerId === 'password';
          const providerId = isPassword ? null : msg.credential.providerId;
          ok(port, msg.id, { ...credReply(session, providerId), operationType: 'link' });
        } else {
          ok(port, msg.id, serializeUser(session.user));
        }
      } catch (error) { fail(port, msg.id, error); }
      break;
    }

    case 'auth.signInWithCredential': {
      try {
        const rawMsg: Record<string, unknown> = msg;
        const hasProvider = typeof rawMsg.providerId === 'string';
        const cred = (msg.credential ?? (hasProvider ? rawMsg : undefined)) as
          | CredentialPayload
          | undefined;
        const hasNoCredential = cred === undefined || !cred.providerId;
        if (hasNoCredential) {
          throw new Error('auth.signInWithCredential requires credential payload or providerId');
        }
        const tenantId = resolveSignInTenant(ctx, port, msg.tenantId);
        const takeStaged = (providerId: string) => stagedSignInResultsFor(ctx).take(port, providerId);
        const { session, providerId, isNewUser } = await signInWithBlockedCredentialPayload(auth, cred, {
          tenantId, ...portOriginScope(port),
        }, takeStaged);
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, credReply(session, providerId, isNewUser));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.acceptIdentity': {
      try {
        const tenantId = resolveSignInTenant(ctx, port, msg.tenantId);
        const { providerId, photoURL, ...identity } = msg.identity;
        let resolved: { uid: string; isNewUser: boolean; sessionClaims?: Record<string, unknown> };
        if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
          resolved = await resolveBlockedFederatedIdentity(auth, {
            ...identity, providerId, photoURL: photoURL ?? undefined, tenantId,
          });
        } else {
          resolved = resolveOAuthCredentialUser(auth, {
            ...identity, providerId, photoURL: photoURL ?? undefined, tenantId,
          });
        }
        const { uid, isNewUser, sessionClaims } = resolved;
        const session = authSandboxOps.mintSession(auth, {
          kind: 'provider',
          uid,
          providerId,
          tenantId,
          sessionClaims,
          ...portOriginScope(port),
        });
        setPortSession(ctx, port, session);
        await bestEffortFlush(ctx, msg.method);
        ok(port, msg.id, credReply(session, providerId, isNewUser));
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.mockSignInResult': {
      try {
        stagedSignInResultsFor(ctx).stage(port, msg.identity);
        ok(port, msg.id, null);
      } catch (e) { fail(port, msg.id, e); }
      break;
    }

    case 'auth.blockingRespond': {
      handleAuthBlockingRespond(ctx, port, msg);
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
  const auth = ensureAuth(ctx);
  if (msg.target === 'authBlocking') {
    handleAuthBlockingSub(ctx, auth, port, msg);
    return;
  }
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
  if (ctx.auth !== undefined && handleAuthBlockingUnsub(ctx, ctx.auth, port, subId)) {
    return true;
  }
  const subs = authSubsFor(ctx);
  const bySubId = subs.get(port);
  if (!bySubId || !bySubId.has(subId)) return false;
  bySubId.delete(subId);
  if (bySubId.size === 0) subs.delete(port);
  return true;
}
