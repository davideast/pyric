/** Firebase-shaped Auth sign-in, redirect, persistence, and sign-out operations. */
import { AuthCredential, EmailAuthCredential } from './credentials.js';
import { signInWithEmailLink } from './email-link.js';
import { hasBeforeCreateHook, hasBeforeSignInHook } from './sandbox/blocking-hooks.js';
import {
  extractBlockingCredentialContext,
  signInBlockedEmailPasswordUser,
} from './sandbox/blocking-sign-in.js';
import {
  createBlockedAnonymousUser,
  createBlockedEmailPasswordUser,
} from './sandbox/blocking-user-creation.js';
import {
  resolveBlockedFederatedIdentity,
  resolveBlockedOidcJwtIdentity,
} from './sandbox/blocking-federated-creation.js';
import { resolveOidcJwtIdentity } from './sandbox/oidc-jwt-credential.js';
import { isFederatedProviderId, type AuthProvider } from './providers.js';
import type { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { SandboxBackend, makeAuthError } from './sandbox-backend.js';
import { resolvePersistenceMode } from './sandbox/persistence-options.js';
import { assertMatchingTenant } from './sandbox/tenant-isolation.js';
import { targetOf, type SandboxTarget } from './target.js';
import {
  USER_INTERNAL,
  type Auth,
  type AuthFlowRequest,
  type AuthFlowResolver,
  type Persistence,
  type User,
  type UserCredential,
} from './types.js';

export async function signInAnonymously(auth: Auth): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  backend.assertProviderEnabled('anonymous');
  const existing = backend.getCurrentUser();
  if (existing?.isAnonymous && (existing.tenantId ?? null) === backend.getTenantId()) {
    return {
      user: existing,
      providerId: null,
      operationType: 'signIn',
      _additionalUserInfo: { isNewUser: false, profile: {}, providerId: null },
    };
  }
  let user: User;
  if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
    const outcome = await createBlockedAnonymousUser(auth, { stageForCurrentUser: true });
    user = outcome.user;
  } else {
    user = backend.mintAnonymousUser();
  }
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
  let user: User;
  if (hasBeforeSignInHook(auth)) {
    const outcome = await signInBlockedEmailPasswordUser(auth, {
      email,
      password,
      stageForCurrentUser: true,
    });
    user = outcome.user;
  } else {
    user = backend.buildUserFromStored(backend.validatePassword(email, password));
  }
  await backend.transitionCurrentUser(user, 'password');
  return {
    user,
    providerId: null,
    operationType: 'signIn',
    _additionalUserInfo: { isNewUser: false, profile: {}, providerId: 'password' },
  };
}

export async function createUserWithEmailAndPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  backend.assertProviderEnabled('password');
  let user: User;
  if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
    const outcome = await createBlockedEmailPasswordUser(auth, {
      email,
      password,
      stageForCurrentUser: true,
    });
    user = outcome.user;
  } else {
    user = backend.buildUserFromStored(backend.createEmailPasswordUser(email, password));
  }
  await backend.transitionCurrentUser(user, 'password');
  return {
    user,
    providerId: null,
    operationType: 'signIn',
    _additionalUserInfo: { isNewUser: true, profile: {}, providerId: 'password' },
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
    if ((error as { code?: string }).code === 'app/app-deleted') {
      target.backend.setCurrentUser(null);
      return;
    }
    throw error;
  }
  await target.backend.transitionCurrentUser(null);
}

export async function setPersistence(auth: Auth, persistence: Persistence): Promise<void> {
  const mode = resolvePersistenceMode(persistence, 'setPersistence');
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
  if (resolver) {
    if (kind === 'popup') return resolver.openPopup(request);
    return resolver.openRedirect(request);
  }
  const mock = backend.consumeMockResult(provider.providerId);
  if (mock) return mock;
  const hostResolver = SandboxBackend.hostResolverOf(backend);
  if (hostResolver) {
    if (kind === 'popup') return hostResolver.openPopup(request);
    return hostResolver.openRedirect(request);
  }
  const api = kind === 'popup' ? 'signInWithPopup' : 'signInWithRedirect';
  throw makeAuthError(
    'auth/argument-error',
    `${api}(provider: ${provider.providerId}): no AuthFlowResolver configured. Inject one with sandbox.setAuthFlowResolver(auth, resolver), pass one as the 3rd argument, or pre-stage a result with sandbox.mockSignInResult(auth, {user, providerId: '${provider.providerId}', …}).`,
  );
}

/**
 * After a resolver/mock hands back a User, ensure `providerData` reflects the
 * linked provider recorded by {@link SandboxBackend.recordProviderSignIn}.
 * Bare helper Users (no `providerData`) are patched in place when possible so
 * `cred.user === auth.currentUser` still holds; otherwise the store-built User
 * replaces them.
 */
function ensureProviderUser(
  backend: SandboxTarget['backend'],
  user: User,
  providerId: string,
): User {
  const internal = (user as { [USER_INTERNAL]?: { target?: SandboxTarget } })[USER_INTERNAL];
  const mintedByOtherBackend = internal !== undefined && internal.target?.backend !== backend;
  if (!mintedByOtherBackend && user.providerData?.some((entry) => entry.providerId === providerId)) {
    return user;
  }
  const stored = backend.findByUid(user.uid);
  if (!stored) return user;
  const rebuilt = backend.buildUserFromStored(stored);
  if (mintedByOtherBackend) {
    return rebuilt;
  }
  const mutable = user as { -readonly [K in keyof User]: User[K] };
  try {
    mutable.providerId = rebuilt.providerId ?? 'firebase';
    mutable.providerData = rebuilt.providerData;
    mutable.emailVerified = rebuilt.emailVerified;
    mutable.photoURL = rebuilt.photoURL;
    mutable.phoneNumber = rebuilt.phoneNumber;
    mutable.getIdToken = (forceRefresh?: boolean) => rebuilt.getIdToken(forceRefresh);
    mutable.getIdTokenResult = (forceRefresh?: boolean) => rebuilt.getIdTokenResult(forceRefresh);
    return user;
  } catch {
    return rebuilt;
  }
}

async function commitProviderSignIn(
  auth: Auth,
  backend: SandboxTarget['backend'],
  credential: UserCredential,
  providerId: string,
): Promise<UserCredential> {
  const existing = backend.findByUid(credential.user.uid);
  if (existing !== undefined) {
    assertMatchingTenant(existing, backend.getTenantId());
  }
  if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
    const resolved = await resolveBlockedFederatedIdentity(auth, {
      providerId,
      uid: credential.user.uid,
      email: credential.user.email,
      displayName: credential.user.displayName,
      photoURL: credential.user.photoURL,
      emailVerified: credential.user.emailVerified,
      tenantId: backend.getTenantId(),
      stageForCurrentUser: true,
    });
    await backend.transitionCurrentUser(resolved.user, providerId);
    return { ...credential, user: resolved.user };
  }
  backend.assertSignInAllowed(credential.user.uid);
  backend.recordProviderSignIn(credential.user, providerId);
  const user = ensureProviderUser(backend, credential.user, providerId);
  await backend.transitionCurrentUser(user, providerId);
  return user === credential.user ? credential : { ...credential, user };
}

export async function signInWithPopup(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<UserCredential> {
  const { backend } = targetOf(auth);
  const credential = await resolveFlow(backend, provider, 'signIn', resolver, 'popup');
  const providerId = credential.providerId ?? provider.providerId;
  return commitProviderSignIn(auth, backend, credential, providerId);
}

export async function signInWithRedirect(
  auth: Auth,
  provider: AuthProvider,
  resolver?: AuthFlowResolver,
): Promise<void> {
  const { backend } = targetOf(auth);
  const credential = await resolveFlow(backend, provider, 'signIn', resolver, 'redirect');
  const providerId = credential.providerId ?? provider.providerId;
  const committed = await commitProviderSignIn(auth, backend, credential, providerId);
  backend.setRedirectResult(committed);
}

export async function getRedirectResult(
  auth: Auth,
  _resolver?: AuthFlowResolver,
): Promise<UserCredential | null> {
  return targetOf(auth).backend.takeRedirectResult();
}

/**
 * The `auth/no-mock-configured` refusal `signInWithCredential` throws when no
 * sign-in result is staged for the credential's provider. Shared through
 * `pyric/auth/internal` so the served planes refuse with the same code and
 * message.
 */
export function noMockConfiguredError(providerId: string): FirebaseError {
  return makeAuthError(
    'auth/no-mock-configured',
    `signInWithCredential(providerId: ${providerId}): no mock configured. Pre-stage with sandbox.mockSignInResult(auth, {user, providerId: '${providerId}', …}).`,
  );
}

function readCredentialIdToken(credential: AuthCredential): string | null {
  const candidate = (credential as { idToken?: unknown }).idToken;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  return null;
}

function canRedeemFederatedJwt(credential: AuthCredential): boolean {
  if (!isFederatedProviderId(credential.providerId)) {
    return false;
  }
  if (credential.signInMethod === undefined) {
    return true;
  }
  return credential.signInMethod === credential.providerId;
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
      let user: User;
      if (hasBeforeSignInHook(auth)) {
        const outcome = await signInBlockedEmailPasswordUser(auth, {
          email: credential.email,
          password: credential.password,
          stageForCurrentUser: true,
        });
        user = outcome.user;
      } else {
        user = backend.buildUserFromStored(
          backend.validatePassword(credential.email, credential.password),
        );
      }
      await backend.transitionCurrentUser(user, 'password');
      return {
        user,
        providerId: null,
        operationType: 'signIn',
        _additionalUserInfo: { isNewUser: false, profile: {}, providerId: 'password' },
      };
    }
    if (credential.emailLink !== null) {
      return signInWithEmailLink(auth, credential.email, credential.emailLink);
    }
  }

  const mock = backend.consumeMockResult(providerId);
  if (!mock) {
    const idToken = readCredentialIdToken(credential);
    if (idToken !== null && canRedeemFederatedJwt(credential)) {
      const extracted = extractBlockingCredentialContext(credential);
      let resolved: ReturnType<typeof resolveOidcJwtIdentity>;
      if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
        resolved = await resolveBlockedOidcJwtIdentity(auth, {
          providerId,
          idToken,
          accessToken: extracted?.accessToken,
          refreshToken: extracted?.refreshToken,
          secret: extracted?.secret,
          stageForCurrentUser: true,
        });
      } else {
        resolved = resolveOidcJwtIdentity(auth, { providerId, idToken });
      }
      if (resolved !== null) {
        await backend.transitionCurrentUser(resolved.user, providerId);
        return {
          user: resolved.user,
          providerId,
          operationType: 'signIn',
          _additionalUserInfo: {
            isNewUser: resolved.isNewUser,
            profile: resolved.claims,
            providerId,
          },
        };
      }
    }
    throw noMockConfiguredError(providerId);
  }
  const credentialProviderId = mock.providerId ?? providerId;
  const existing = backend.findByUid(mock.user.uid);
  if (existing !== undefined) {
    assertMatchingTenant(existing, backend.getTenantId());
  }
  if (hasBeforeCreateHook(auth) || hasBeforeSignInHook(auth)) {
    const extracted = extractBlockingCredentialContext(credential);
    const resolved = await resolveBlockedFederatedIdentity(
      auth,
      {
        providerId: credentialProviderId,
        uid: mock.user.uid,
        email: mock.user.email,
        displayName: mock.user.displayName,
        photoURL: mock.user.photoURL,
        emailVerified: mock.user.emailVerified,
        tenantId: backend.getTenantId(),
        stageForCurrentUser: true,
      },
      extracted !== undefined ? { credential: extracted } : undefined,
    );
    await backend.transitionCurrentUser(resolved.user, credentialProviderId);
    return { ...mock, user: resolved.user };
  }
  backend.assertSignInAllowed(mock.user.uid);
  backend.recordProviderSignIn(mock.user, credentialProviderId);
  const user = ensureProviderUser(backend, mock.user, credentialProviderId);
  await backend.transitionCurrentUser(user, credentialProviderId);
  if (user === mock.user) {
    return mock;
  }
  return { ...mock, user };
}
