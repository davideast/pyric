import { FirebaseError } from 'pyric/app';
import { AuthCredential, EmailAuthCredential, sandbox, type Auth, type MintedSession } from 'pyric/auth';
import { resolveEmailLinkIdentity } from 'pyric/auth/internal';
import { resolveOAuthCredentialUser, type OAuthCredentialPayload } from './auth-session-seeder.js';

/** The tenant and page origin a served sign-in mints its session under. */
export interface CredentialSignInScope {
  readonly tenantId: string | null;
  readonly origin?: string;
}

/** A credential as it arrives on the wire: nested, or flat on a native client's op message. */
export type CredentialPayload = OAuthCredentialPayload & Record<string, unknown>;

export interface CredentialSignIn {
  readonly session: MintedSession;
  readonly providerId: string | null;
  readonly isNewUser: boolean;
}

const EMAIL_PROVIDER_ID = 'password';

/**
 * Sign a port in with a credential.
 *
 * An email credential carries its own secret, so the engine checks it here
 * exactly as `signInWithEmailAndPassword` and `signInWithEmailLink` do. An
 * OAuth credential keeps the served behavior: the identity it asserts is
 * signed in, because the sandbox has no identity provider to redeem a token
 * against.
 */
export function signInWithCredentialPayload(
  auth: Auth,
  payload: CredentialPayload,
  scope: CredentialSignInScope,
): CredentialSignIn {
  const isEmailCredential = payload.providerId === EMAIL_PROVIDER_ID;
  if (isEmailCredential) return signInWithEmailCredential(auth, payload, scope);
  const { uid, isNewUser } = resolveOAuthCredentialUser(auth, payload);
  const session = sandbox.mintSession(auth, { kind: 'provider', uid, providerId: payload.providerId, ...scope });
  return { session, providerId: payload.providerId, isNewUser };
}

/** Rebuild the email credential and let the engine verify its password or link. A missing secret fails closed. */
function signInWithEmailCredential(
  auth: Auth,
  payload: CredentialPayload,
  scope: CredentialSignInScope,
): CredentialSignIn {
  const credential = AuthCredential.fromJSON(payload);
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
  const { user, isNewUser } = resolveEmailLinkIdentity(auth, credential.email, link);
  const session = sandbox.mintSession(auth, {
    kind: 'provider', uid: user.uid, providerId: EMAIL_PROVIDER_ID, ...scope,
  });
  return { session, providerId: null, isNewUser };
}

function invalidCredential(): FirebaseError {
  return new FirebaseError('auth/invalid-credential', 'signInWithCredential: the email credential is invalid.');
}
