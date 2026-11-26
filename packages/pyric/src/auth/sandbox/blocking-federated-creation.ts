/**
 * Federated `beforeUserCreated` hook invocation and atomic account persistence
 * for OIDC JWT credentials and staged/dialog federated OAuth identities.
 */
import { getClock, providerVerifiesEmail } from 'pyric/sandbox/internal';
import { makeAuthError } from '../auth-errors.js';
import { isFederatedProviderId } from '../providers.js';
import type { ProviderUserInfo, StoredUser, UpdateUserRequest } from '../sandbox-backend-types.js';
import { SandboxBackend } from '../sandbox-backend.js';
import {
  applyBeforeCreateResponseToInit,
  getAuthBlockingHooks,
  type AuthBlockingClientContext,
} from './blocking-hooks.js';
import { runBeforeSignInHook } from './blocking-sign-in.js';
import { isTrustedGmailGoogleSignIn } from './gmail-account-overwrite.js';
import {
  decodeOidcIdTokenClaims,
  type ResolveOidcJwtInput,
  type ResolvedOidcJwtIdentity,
} from './oidc-jwt-credential.js';
import { resolvePhotoUrlForUid } from './photo-origin.js';
import { assertMatchingTenant, normalizeTenantScope } from './tenant-isolation.js';
import { targetOf } from '../target.js';
import type { Auth, User } from '../types.js';

export interface BlockedFederatedIdentityInput {
  readonly providerId: string;
  readonly email?: string | null;
  readonly displayName?: string | null;
  readonly photoURL?: string | null;
  readonly uid?: string | null;
  readonly customClaims?: Record<string, unknown>;
  readonly tenantId?: string | null;
  readonly emailVerified?: boolean;
  readonly preserveExistingProfile?: boolean;
}

export interface BlockedOidcJwtIdentityOutcome extends ResolvedOidcJwtIdentity {
  readonly sessionClaims?: Record<string, unknown>;
}

/** Resolve or create a federated OIDC JWT account, running `beforeCreate` (if new) and `beforeSignIn`. */
export async function resolveBlockedOidcJwtIdentity(
  auth: Auth,
  input: ResolveOidcJwtInput & {
    accessToken?: string;
    refreshToken?: string;
    secret?: string;
    stageForCurrentUser?: boolean;
  },
  client?: AuthBlockingClientContext,
): Promise<BlockedOidcJwtIdentityOutcome | null> {
  if (!isFederatedProviderId(input.providerId)) {
    return null;
  }
  const decoded = decodeOidcIdTokenClaims(input.idToken);
  if (decoded === null) {
    return null;
  }
  const target = targetOf(auth);
  const { backend } = target;
  const rawTenant = input.tenantId === undefined ? backend.getTenantId() : input.tenantId;
  const effectiveTenant = normalizeTenantScope(rawTenant);

  const mergedClient: AuthBlockingClientContext = {
    ...client,
    rawUserInfo: client?.rawUserInfo ?? decoded.claims,
    credential: {
      claims: decoded.claims,
      idToken: input.idToken,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      secret: input.secret,
      ...client?.credential,
    },
  };

  let existing = backend.findByUid(decoded.sub);
  if (existing !== undefined) {
    assertMatchingTenant(existing, effectiveTenant);
  } else if (decoded.email !== null) {
    existing = backend.findByEmail(decoded.email, effectiveTenant);
  }

  if (existing !== undefined) {
    const matchedExisting = existing;
    backend.assertSignInAllowed(matchedExisting.uid);
    const outcome = await runBeforeSignInHook(auth, {
      uid: matchedExisting.uid,
      signInMethod: input.providerId,
      tenantId: effectiveTenant,
      client: mergedClient,
      onApproved: () => {
        backend.createSignInCredential({
          providerId: input.providerId,
          uid: matchedExisting.uid,
          verifyEmail: decoded.emailVerified !== false,
        });
        const updateReq: UpdateUserRequest = {};
        let hasUpdate = false;
        if (decoded.displayName !== null && decoded.displayName !== matchedExisting.displayName) {
          updateReq.displayName = decoded.displayName;
          hasUpdate = true;
        }
        if (matchedExisting.email === null && decoded.email !== null) {
          if (backend.findByEmail(decoded.email, effectiveTenant) === undefined) {
            updateReq.email = decoded.email;
            hasUpdate = true;
          }
        }
        if (decoded.emailVerified === true && !matchedExisting.emailVerified) {
          const hasOtherProvider = matchedExisting.providerUserInfo.some(
            (entry) => entry.providerId !== input.providerId,
          );
          if (matchedExisting.password === null && !hasOtherProvider) {
            updateReq.emailVerified = true;
            hasUpdate = true;
          }
        }
        if (hasUpdate) {
          backend.updateUser(matchedExisting.uid, updateReq);
        }
        if (decoded.photoURL !== null) {
          let nextDisplayName = matchedExisting.displayName;
          if (decoded.displayName !== null) {
            nextDisplayName = decoded.displayName;
          }
          backend.updateProfileByUid(matchedExisting.uid, {
            photoURL: decoded.photoURL,
            displayName: nextDisplayName,
          });
        }
      },
      stageForCurrentUser: input.stageForCurrentUser,
    });
    return {
      user: outcome.user,
      uid: outcome.user.uid,
      isNewUser: false,
      claims: decoded.claims,
      sessionClaims: outcome.sessionClaims,
    };
  }

  let initialEmailVerified = false;
  if (decoded.emailVerified !== undefined) {
    initialEmailVerified = decoded.emailVerified;
  } else if (decoded.email !== null) {
    initialEmailVerified = providerVerifiesEmail(input.providerId);
  }

  const beforeCreate = getAuthBlockingHooks(auth)?.beforeCreate;
  const createdAtIso = new Date(getClock(target.sandbox).now()).toISOString();
  const providerUserInfo: ProviderUserInfo[] = [{ providerId: input.providerId }];
  const baseInit: Partial<StoredUser> & { uid: string } = {
    uid: decoded.sub,
    email: decoded.email,
    displayName: decoded.displayName,
    photoUrl: decoded.photoURL,
    emailVerified: initialEmailVerified,
    disabled: false,
    tenantId: effectiveTenant,
    providerUserInfo,
  };
  let finalInit = baseInit;
  let clearPhotoUrl = false;
  if (beforeCreate !== undefined) {
    const candidatePhotoUrl = resolvePhotoUrlForUid(
      SandboxBackend.projectStoreOf(backend),
      decoded.sub,
      decoded.photoURL,
    );
    const response = await beforeCreate({
      userRecord: {
        uid: decoded.sub,
        email: decoded.email,
        emailVerified: initialEmailVerified,
        displayName: decoded.displayName,
        photoURL: candidatePhotoUrl,
        phoneNumber: null,
        disabled: false,
        creationTime: createdAtIso,
        lastSignInTime: null,
        providerData: [
          {
            uid: decoded.sub,
            email: decoded.email,
            displayName: decoded.displayName,
            photoURL: candidatePhotoUrl,
            providerId: input.providerId,
          },
        ],
        tenantId: effectiveTenant,
      },
      signInMethod: input.providerId,
      tenantId: effectiveTenant,
      client: mergedClient,
    });
    const applied = applyBeforeCreateResponseToInit(baseInit, response);
    finalInit = applied.init;
    clearPhotoUrl = applied.clearPhotoUrl;
  }

  const created = SandboxBackend.commitBlockedAccount(backend, finalInit, {
    signInProviderId: input.providerId,
    clearPhotoUrl,
  });
  backend.assertSignInAllowed(created.uid);
  const outcome = await runBeforeSignInHook(auth, {
    uid: created.uid,
    signInMethod: input.providerId,
    tenantId: effectiveTenant,
    client: mergedClient,
    stageForCurrentUser: input.stageForCurrentUser,
  });
  return {
    user: outcome.user,
    uid: outcome.user.uid,
    isNewUser: true,
    claims: decoded.claims,
    sessionClaims: outcome.sessionClaims,
  };
}

/** Resolve or create a staged/dialog federated OAuth identity, running `beforeCreate` (if new) and `beforeSignIn`. */
export async function resolveBlockedFederatedIdentity(
  auth: Auth,
  credential: BlockedFederatedIdentityInput & { stageForCurrentUser?: boolean },
  client?: AuthBlockingClientContext,
): Promise<{ uid: string; user: User; isNewUser: boolean; sessionClaims?: Record<string, unknown> }> {
  const target = targetOf(auth);
  const { backend } = target;
  backend.assertProviderEnabled(credential.providerId);
  const effectiveTenant = normalizeTenantScope(credential.tenantId);

  let targetUid: string | null = null;
  if (typeof credential.uid === 'string' && credential.uid.length > 0) {
    targetUid = credential.uid;
  }
  if (targetUid === null && credential.email) {
    const byEmail = backend.findByEmail(credential.email, effectiveTenant);
    if (byEmail !== undefined) {
      targetUid = byEmail.uid;
    }
  }
  if (targetUid === null) {
    const emailPart = credential.email || 'user';
    if (effectiveTenant !== null) {
      targetUid = `oauth-${effectiveTenant}-${credential.providerId}-${emailPart}`;
    } else {
      targetUid = `oauth-${credential.providerId}-${emailPart}`;
    }
  }

  const resolvedTargetUid = targetUid;
  const existing = backend.findByUid(resolvedTargetUid);
  const callerDecidesVerification = credential.emailVerified !== undefined;
  if (existing !== undefined) {
    assertMatchingTenant(existing, effectiveTenant);
    backend.assertSignInAllowed(existing.uid);
    const outcome = await runBeforeSignInHook(auth, {
      uid: resolvedTargetUid,
      signInMethod: credential.providerId,
      tenantId: effectiveTenant,
      client,
      onApproved: () => {
        const shouldVerifyEmail =
          !callerDecidesVerification ||
          (credential.emailVerified === true &&
            isTrustedGmailGoogleSignIn(credential.providerId, existing.email));
        backend.createSignInCredential({
          providerId: credential.providerId,
          uid: resolvedTargetUid,
          verifyEmail: shouldVerifyEmail,
        });
        if (credential.preserveExistingProfile === true) {
          return;
        }
        backend.updateUser(resolvedTargetUid, {
          displayName: credential.displayName ?? existing.displayName,
          email: credential.email ?? existing.email ?? undefined,
        });
        if (credential.photoURL !== undefined) {
          backend.updateProfileByUid(resolvedTargetUid, {
            photoURL: credential.photoURL,
            displayName: credential.displayName ?? existing.displayName,
          });
        }
      },
      stageForCurrentUser: credential.stageForCurrentUser,
    });
    return {
      uid: resolvedTargetUid,
      user: outcome.user,
      isNewUser: false,
      sessionClaims: outcome.sessionClaims,
    };
  }

  let initialEmailVerified = false;
  if (callerDecidesVerification) {
    initialEmailVerified = Boolean(credential.emailVerified);
  } else if (credential.email) {
    initialEmailVerified = providerVerifiesEmail(credential.providerId);
  }

  const beforeCreate = getAuthBlockingHooks(auth)?.beforeCreate;
  const createdAtIso = new Date(getClock(target.sandbox).now()).toISOString();
  const baseInit: Partial<StoredUser> & { uid: string } = {
    uid: resolvedTargetUid,
    email: credential.email ?? null,
    displayName: credential.displayName ?? null,
    photoUrl: credential.photoURL ?? null,
    customClaims: credential.customClaims ?? {},
    emailVerified: initialEmailVerified,
    disabled: false,
    tenantId: effectiveTenant,
    providerUserInfo: [{ providerId: credential.providerId }],
  };
  let finalInit = baseInit;
  let clearPhotoUrl = false;
  if (beforeCreate !== undefined) {
    const candidatePhotoUrl = resolvePhotoUrlForUid(
      SandboxBackend.projectStoreOf(backend),
      resolvedTargetUid,
      credential.photoURL ?? null,
    );
    const response = await beforeCreate({
      userRecord: {
        uid: resolvedTargetUid,
        email: credential.email ?? null,
        emailVerified: initialEmailVerified,
        displayName: credential.displayName ?? null,
        photoURL: candidatePhotoUrl,
        phoneNumber: null,
        disabled: false,
        creationTime: createdAtIso,
        lastSignInTime: null,
        providerData: [
          {
            uid: resolvedTargetUid,
            email: credential.email ?? null,
            displayName: credential.displayName ?? null,
            photoURL: candidatePhotoUrl,
            providerId: credential.providerId,
          },
        ],
        customClaims: credential.customClaims,
        tenantId: effectiveTenant,
      },
      signInMethod: credential.providerId,
      tenantId: effectiveTenant,
      client,
    });
    const applied = applyBeforeCreateResponseToInit(baseInit, response);
    finalInit = applied.init;
    clearPhotoUrl = applied.clearPhotoUrl;
  }

  const created = SandboxBackend.commitBlockedAccount(backend, finalInit, {
    signInProviderId: credential.providerId,
    clearPhotoUrl,
  });
  backend.assertSignInAllowed(created.uid);
  const outcome = await runBeforeSignInHook(auth, {
    uid: created.uid,
    signInMethod: credential.providerId,
    tenantId: effectiveTenant,
    client,
    stageForCurrentUser: credential.stageForCurrentUser,
  });
  return {
    uid: created.uid,
    user: outcome.user,
    isNewUser: true,
    sessionClaims: outcome.sessionClaims,
  };
}
