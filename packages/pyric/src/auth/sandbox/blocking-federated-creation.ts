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
import {
  decodeOidcIdTokenClaims,
  type ResolveOidcJwtInput,
  type ResolvedOidcJwtIdentity,
} from './oidc-jwt-credential.js';
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
}

/** Resolve or create a federated OIDC JWT account, running `beforeCreate` on first-time users. */
export async function resolveBlockedOidcJwtIdentity(
  auth: Auth,
  input: ResolveOidcJwtInput & { accessToken?: string; refreshToken?: string; secret?: string },
  client?: AuthBlockingClientContext,
): Promise<ResolvedOidcJwtIdentity | null> {
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

  let existing = backend.findByUid(decoded.sub);
  if (existing !== undefined) {
    assertMatchingTenant(existing, effectiveTenant);
  } else if (decoded.email !== null) {
    existing = backend.findByEmail(decoded.email, effectiveTenant);
  }

  if (existing !== undefined) {
    backend.assertSignInAllowed(existing.uid);
    backend.createSignInCredential({
      providerId: input.providerId,
      uid: existing.uid,
      verifyEmail: decoded.emailVerified === undefined,
    });
    const updateReq: UpdateUserRequest = {};
    let hasUpdate = false;
    if (decoded.displayName !== null && decoded.displayName !== existing.displayName) {
      updateReq.displayName = decoded.displayName;
      hasUpdate = true;
    }
    if (existing.email === null && decoded.email !== null) {
      if (backend.findByEmail(decoded.email, effectiveTenant) === undefined) {
        updateReq.email = decoded.email;
        hasUpdate = true;
      }
    }
    if (decoded.emailVerified === true && !existing.emailVerified) {
      const hasOtherProvider = existing.providerUserInfo.some(
        (entry) => entry.providerId !== input.providerId,
      );
      if (existing.password === null && !hasOtherProvider) {
        updateReq.emailVerified = true;
        hasUpdate = true;
      }
    }
    if (hasUpdate) {
      backend.updateUser(existing.uid, updateReq);
    }
    if (decoded.photoURL !== null) {
      let nextDisplayName = existing.displayName;
      if (decoded.displayName !== null) {
        nextDisplayName = decoded.displayName;
      }
      backend.updateProfileByUid(existing.uid, {
        photoURL: decoded.photoURL,
        displayName: nextDisplayName,
      });
    }
    const refreshed = backend.findByUid(existing.uid);
    if (refreshed === undefined) {
      throw makeAuthError(
        'auth/internal-error',
        'signInWithCredential: could not reload resolved OIDC account.',
      );
    }
    return {
      user: backend.buildUserFromStored(refreshed),
      uid: refreshed.uid,
      isNewUser: false,
      claims: decoded.claims,
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
    const response = await beforeCreate({
      userRecord: {
        uid: decoded.sub,
        email: decoded.email,
        emailVerified: initialEmailVerified,
        displayName: decoded.displayName,
        photoURL: decoded.photoURL,
        phoneNumber: null,
        disabled: false,
        creationTime: createdAtIso,
        lastSignInTime: null,
        providerData: [
          {
            uid: decoded.sub,
            email: decoded.email,
            displayName: decoded.displayName,
            photoURL: decoded.photoURL,
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
  return {
    user: backend.buildUserFromStored(created),
    uid: created.uid,
    isNewUser: true,
    claims: decoded.claims,
  };
}

/** Resolve or create a staged/dialog federated OAuth identity, running `beforeCreate` on new users. */
export async function resolveBlockedFederatedIdentity(
  auth: Auth,
  credential: BlockedFederatedIdentityInput,
  client?: AuthBlockingClientContext,
): Promise<{ uid: string; user: User; isNewUser: boolean }> {
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

  const existing = backend.findByUid(targetUid);
  const callerDecidesVerification = credential.emailVerified !== undefined;
  if (existing !== undefined) {
    assertMatchingTenant(existing, effectiveTenant);
    backend.assertSignInAllowed(existing.uid);
    backend.createSignInCredential({
      providerId: credential.providerId,
      uid: targetUid,
      verifyEmail: !callerDecidesVerification,
    });
    backend.updateUser(targetUid, {
      displayName: credential.displayName ?? existing.displayName,
      email: credential.email ?? existing.email ?? undefined,
    });
    if (credential.photoURL !== undefined) {
      backend.updateProfileByUid(targetUid, {
        photoURL: credential.photoURL,
        displayName: credential.displayName ?? existing.displayName,
      });
    }
    const refreshed = backend.findByUid(targetUid);
    if (refreshed === undefined) {
      throw makeAuthError('auth/internal-error', 'Could not reload federated identity.');
    }
    return { uid: targetUid, user: backend.buildUserFromStored(refreshed), isNewUser: false };
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
    uid: targetUid,
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
    const response = await beforeCreate({
      userRecord: {
        uid: targetUid,
        email: credential.email ?? null,
        emailVerified: initialEmailVerified,
        displayName: credential.displayName ?? null,
        photoURL: credential.photoURL ?? null,
        phoneNumber: null,
        disabled: false,
        creationTime: createdAtIso,
        lastSignInTime: null,
        providerData: [
          {
            uid: targetUid,
            email: credential.email ?? null,
            displayName: credential.displayName ?? null,
            photoURL: credential.photoURL ?? null,
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
  return { uid: targetUid, user: backend.buildUserFromStored(created), isNewUser: true };
}
