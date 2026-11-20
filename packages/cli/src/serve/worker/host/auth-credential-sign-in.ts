import { FirebaseError } from 'pyric/app';
import { AuthCredential, EmailAuthCredential, sandbox, type Auth, type MintedSession } from 'pyric/auth';
import {
  isFederatedProviderId,
  noMockConfiguredError,
  resolveEmailLinkIdentity,
  resolveOidcJwtIdentity,
} from 'pyric/auth/internal';
import { resolveOAuthCredentialUser, type OAuthCredentialPayload } from './auth-session-seeder.js';
import type { ResolvedIdentity } from '../protocol.js';

/** The tenant and page origin a served sign-in mints its session under. */
export interface CredentialSignInScope {
  readonly tenantId: string | null;
  readonly origin?: string;
}

/** Use up the calling port's staged result for a provider, or `null` when none was staged. */
export type TakeStagedSignInResult = (providerId: string) => ResolvedIdentity | null;

/** A credential as it arrives on the wire: nested, or flat on a native client's op message. */
export type CredentialPayload = OAuthCredentialPayload & Record<string, unknown>;

export interface CredentialSignIn {
  readonly session: MintedSession;
  readonly providerId: string | null;
  readonly isNewUser: boolean;
}

const EMAIL_PROVIDER_ID = 'password';
const EMAIL_LINK_METHOD = 'emailLink';

/**
 * Reconstruct a worker-wire credential payload while keeping public
 * `AuthCredential.fromJSON` / `EmailAuthCredential.fromJSON` strict per
 * upstream `firebase/auth` 12.19.0: when `providerId === 'password'` and
 * `signInMethod` is `'password'` or `'emailLink'`, preserve empty or omitted
 * `email` / `password` strings so the engine surfaces `auth/missing-password`
 * or `auth/invalid-email` identically to in-page `signInWithCredential`.
 */
export function credentialFromWirePayload(
  payload: Record<string, unknown>,
): AuthCredential | null {
  const parsed = AuthCredential.fromJSON(payload);
  if (parsed !== null) {
    return parsed;
  }
  const providerId = payload['providerId'];
  const signInMethod = payload['signInMethod'];
  if (providerId !== EMAIL_PROVIDER_ID || typeof signInMethod !== 'string') {
    return null;
  }
  const isSupportedMethod =
    signInMethod === EMAIL_PROVIDER_ID || signInMethod === EMAIL_LINK_METHOD;
  if (!isSupportedMethod) {
    return null;
  }
  let email = '';
  if (typeof payload['email'] === 'string') {
    email = payload['email'];
  }
  let secret = '';
  if (typeof payload['password'] === 'string') {
    secret = payload['password'];
  }
  let tenantId: string | null = null;
  if (typeof payload['tenantId'] === 'string') {
    tenantId = payload['tenantId'];
  }
  return new EmailAuthCredential(email, secret, signInMethod, { tenantId });
}

/**
 * Sign a port in with a credential.
 *
 * An email credential carries its own secret, so the engine checks it here
 * exactly as `signInWithEmailAndPassword` and `signInWithEmailLink` do. A
 * provider id that is not federated (a look-alike of `password`, `emailLink`,
 * `phone`, or an id pyric doesn't know), or a payload whose `signInMethod`
 * differs from its provider, is refused with in-page's
 * `auth/no-mock-configured` before the resolver can find or touch an account
 * (#1466). A federated credential consumes a result the port staged for its
 * provider first; when none is staged, a well-formed OIDC JWT `idToken` with a
 * non-empty `sub` claim decodes as the Firebase Auth Emulator does, while raw
 * payload assertions (`uid`, `email`) without a staged result or valid OIDC
 * JWT are refused with `auth/no-mock-configured`.
 */
export function signInWithCredentialPayload(
  auth: Auth,
  payload: CredentialPayload,
  scope: CredentialSignInScope,
  takeStaged: TakeStagedSignInResult,
): CredentialSignIn {
  const isEmailCredential = payload.providerId === EMAIL_PROVIDER_ID;
  if (isEmailCredential) return signInWithEmailCredential(auth, payload, scope);
  // In-page checks enablement before anything else, so a disabled provider is operation-not-allowed.
  sandbox.assertAuthProviderEnabled(auth, payload.providerId);
  const isFederated = isFederatedProviderId(payload.providerId);
  const signInMethod = payload.signInMethod;
  const hasOtherSignInMethod = signInMethod !== undefined && signInMethod !== payload.providerId;
  if (!isFederated || hasOtherSignInMethod) throw noMockConfiguredError(payload.providerId);
  const staged = takeStaged(payload.providerId);
  if (staged !== null) {
    if (staged.uid === '') throw noMockConfiguredError(payload.providerId);
    return signInAsStaged(auth, staged, scope);
  }
  const oidcSignIn = signInWithOidcJwtPayload(auth, payload, scope);
  if (oidcSignIn !== null) {
    return oidcSignIn;
  }
  throw noMockConfiguredError(payload.providerId);
}

function signInWithOidcJwtPayload(
  auth: Auth,
  payload: CredentialPayload,
  scope: CredentialSignInScope,
): CredentialSignIn | null {
  const rawIdToken = payload['idToken'];
  if (typeof rawIdToken !== 'string' || rawIdToken.length === 0) {
    return null;
  }
  const resolved = resolveOidcJwtIdentity(auth, {
    providerId: payload.providerId,
    idToken: rawIdToken,
    tenantId: scope.tenantId,
  });
  if (resolved === null) {
    return null;
  }
  const sessionArgs: Parameters<typeof sandbox.mintSession>[1] = {
    kind: 'provider',
    uid: resolved.uid,
    providerId: payload.providerId,
    tenantId: scope.tenantId,
  };
  if (scope.origin !== undefined) {
    sessionArgs.origin = scope.origin;
  }
  const session = sandbox.mintSession(auth, sessionArgs);
  return {
    session,
    providerId: payload.providerId,
    isNewUser: resolved.isNewUser,
  };
}

/** Sign in as the staged identity: find or create its uid and link the provider, as `auth.acceptIdentity` does. */
function signInAsStaged(auth: Auth, staged: ResolvedIdentity, scope: CredentialSignInScope): CredentialSignIn {
  const { photoURL, ...identity } = staged;
  const { uid, isNewUser } = resolveOAuthCredentialUser(auth, {
    ...identity,
    photoURL: photoURL ?? undefined,
    tenantId: scope.tenantId,
  });
  const session = sandbox.mintSession(auth, { kind: 'provider', uid, providerId: staged.providerId, ...scope });
  return { session, providerId: staged.providerId, isNewUser };
}

/** Rebuild the email credential and let the engine verify its password or link. A missing secret fails closed. */
function signInWithEmailCredential(
  auth: Auth,
  payload: CredentialPayload,
  scope: CredentialSignInScope,
): CredentialSignIn {
  const credential = credentialFromWirePayload(payload);
  const isEmail = credential instanceof EmailAuthCredential;
  if (!isEmail) throw invalidCredential();
  const usesPassword = credential.password !== null;
  if (usesPassword) {
    const session = sandbox.mintSession(auth, {
      kind: 'password', email: credential.email, password: credential.password, ...scope,
    });
    return { session, providerId: null, isNewUser: false };
  }
  const link = credential.emailLink;
  const usesLink = link !== null;
  if (!usesLink) throw invalidCredential();
  const { user, isNewUser } = resolveEmailLinkIdentity(auth, credential.email, link, scope.tenantId);
  const session = sandbox.mintSession(auth, {
    kind: 'provider', uid: user.uid, providerId: EMAIL_PROVIDER_ID, ...scope,
  });
  return { session, providerId: null, isNewUser };
}

function invalidCredential(): FirebaseError {
  return new FirebaseError('auth/invalid-credential', 'signInWithCredential: the email credential is invalid.');
}
