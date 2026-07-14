/** Firebase-shaped Auth sign-in, redirect, persistence, and sign-out operations. */
import { AuthCredential, EmailAuthCredential } from './credentials.js';
import { signInWithEmailLink } from './email-link.js';
import type { AuthProvider } from './providers.js';
import { makeAuthError } from './sandbox-backend.js';
import { targetOf, type SandboxTarget } from './target.js';
import type {
  Auth,
  AuthFlowRequest,
  AuthFlowResolver,
  Persistence,
  UserCredential,
} from './types.js';

export async function signInAnonymously(auth: Auth): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  backend.assertProviderEnabled('anonymous');
  const existing = backend.getCurrentUser();
  if (existing?.isAnonymous) {
    return {
      user: existing,
      providerId: null,
      operationType: 'signIn',
      _additionalUserInfo: { isNewUser: false, profile: {}, providerId: null },
    };
  }
  const user = backend.mintAnonymousUser();
  await backend.transitionCurrentUser(user, 'anonymous');
  return {
    user,
    providerId: null,
    operationType: 'signIn',
    _additionalUserInfo: { isNewUser: true, profile: {}, providerId: null },
  };
}

export async function signInWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  backend.assertProviderEnabled('password');
  const user = backend.buildUserFromStored(backend.validatePassword(email, password));
  await backend.transitionCurrentUser(user, 'password');
  return {
    user,
    providerId: null,
    operationType: 'signIn',
    _additionalUserInfo: { isNewUser: false, profile: {}, providerId: null },
  };
}

export async function createUserWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  backend.assertProviderEnabled('password');
  const user = backend.buildUserFromStored(backend.createEmailPasswordUser(email, password));
  await backend.transitionCurrentUser(user, 'password');
  return {
    user,
    providerId: null,
    operationType: 'signIn',
    _additionalUserInfo: { isNewUser: true, profile: {}, providerId: null },
  };
}

export async function signOut(auth: Auth): Promise<void> {
  const target = targetOf(auth, true);
  try {
    target.assertAlive?.();
  } catch (error) {
    // Firebase retains a cached Auth handle after deleteApp and makes signOut
    // an idempotent no-op, while every operation that could create or restore
    // identity rejects app/app-deleted.
    if ((error as { code?: string }).code === 'app/app-deleted') return;
    throw error;
  }
  await target.backend.transitionCurrentUser(null);
}

export async function setPersistence(auth: Auth, persistence: Persistence): Promise<void> {
  const mode = ({
    LOCAL: 'LOCAL',
    SESSION: 'SESSION',
    NONE: 'NONE',
    COOKIE: 'LOCAL',
  } as const)[persistence.type];
  if (mode === undefined) {
    throw makeAuthError(
      'auth/argument-error',
      `setPersistence: unrecognized persistence type ${String(persistence.type)}`,
    );
  }
  targetOf(auth).backend.setPersistenceMode(mode);
}

async function resolveFlow(
  backend: SandboxTarget['backend'],
  provider: AuthProvider,
  authType: AuthFlowRequest['authType'],
  perCall: AuthFlowResolver | undefined,
  kind: 'popup' | 'redirect',
): Promise<UserCredential> {
  backend.assertProviderEnabled(provider.providerId);
  const request: AuthFlowRequest = { providerId: provider.providerId, authType };
  const resolver = perCall ?? backend.getResolver();
  if (resolver) return kind === 'popup' ? resolver.openPopup(request) : resolver.openRedirect(request);
  const mock = backend.consumeMockResult(provider.providerId);
  if (mock) return mock;
  const api = kind === 'popup' ? 'signInWithPopup' : 'signInWithRedirect';
  throw makeAuthError(
    'auth/argument-error',
    `${api}(provider: ${provider.providerId}): no AuthFlowResolver configured. Inject one with sandbox.setAuthFlowResolver(auth, resolver), pass one as the 3rd argument, or pre-stage a result with sandbox.mockSignInResult(auth, {user, providerId: '${provider.providerId}', …}).`,
  );
}

export async function signInWithPopup(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  const credential = await resolveFlow(backend, provider, 'signIn', resolver, 'popup');
  const providerId = credential.providerId ?? provider.providerId;
  backend.assertSignInAllowed(credential.user.uid);
  backend.recordProviderSignIn(credential.user, providerId);
  await backend.transitionCurrentUser(credential.user, providerId);
  return credential;
}

export async function signInWithRedirect(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<void> {
  const { backend } = targetOf(auth);
  const credential = await resolveFlow(backend, provider, 'signIn', resolver, 'redirect');
  const providerId = credential.providerId ?? provider.providerId;
  backend.assertSignInAllowed(credential.user.uid);
  backend.recordProviderSignIn(credential.user, providerId);
  await backend.transitionCurrentUser(credential.user, providerId);
  backend.setRedirectResult(credential);
}

export async function getRedirectResult(
  auth: Auth,
  _resolver?: AuthFlowResolver,
): Promise<UserCredential | null> {
  return targetOf(auth).backend.takeRedirectResult();
}

export async function signInWithCredential(
  auth: Auth,
  credential: AuthCredential,
): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  const providerId = credential.providerId;
  backend.assertProviderEnabled(providerId);

  if (credential instanceof EmailAuthCredential) {
    if (credential.password !== null) {
      const user = backend.buildUserFromStored(
        backend.validatePassword(credential.email, credential.password),
      );
      await backend.transitionCurrentUser(user, 'password');
      return {
        user,
        providerId: null,
        operationType: 'signIn',
        _additionalUserInfo: { isNewUser: false, profile: {}, providerId: null },
      };
    }
    if (credential.emailLink !== null) {
      return signInWithEmailLink(auth, credential.email, credential.emailLink);
    }
  }

  const mock = backend.consumeMockResult(providerId);
  if (!mock) {
    throw makeAuthError(
      'auth/no-mock-configured',
      `signInWithCredential(providerId: ${providerId}): no mock configured. Pre-stage with sandbox.mockSignInResult(auth, {user, providerId: '${providerId}', …}).`,
    );
  }
  const credentialProviderId = mock.providerId ?? providerId;
  backend.assertSignInAllowed(mock.user.uid);
  backend.recordProviderSignIn(mock.user, credentialProviderId);
  await backend.transitionCurrentUser(mock.user, credentialProviderId);
  return mock;
}
