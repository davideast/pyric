/**
 * `beforeUserSignedIn` blocking-hook invocation, permanent user-record mutation
 * application, and transient `sessionClaims` extraction across sign-in flows.
 */
import { makeAuthError } from '../auth-errors.js';
import type { StoredUser } from '../sandbox-backend-types.js';
import { SandboxBackend } from '../sandbox-backend.js';
import {
  getAuthBlockingHooks,
  makeAuthBlockingRejectionError,
  validateBlockingClaimsPayload,
  validateCombinedBlockingClaimsPayload,
  type AuthBlockingClientContext,
  type AuthBlockingCredentialContext,
  type AuthBlockingProviderInfo,
  type AuthBlockingUserCandidate,
} from './blocking-hooks.js';
import { normalizeTenantScope } from './tenant-isolation.js';
import { targetOf } from '../target.js';
import type { Auth, User } from '../types.js';

export interface BlockedSignInOutcome {
  user: User;
  sessionClaims?: Record<string, unknown>;
}

export interface RunBeforeSignInOptions {
  uid: string;
  signInMethod: string;
  tenantId?: string | null;
  client?: AuthBlockingClientContext;
  candidateOverride?: Partial<AuthBlockingUserCandidate>;
  /** Invoked after `beforeSignIn` approves, right before `BeforeSignInResponse` mutations apply. */
  onApproved?: () => void;
  /** Stage transient `sessionClaims` for an immediate in-page `transitionCurrentUser` call. */
  stageForCurrentUser?: boolean;
}

/** Build an `AuthBlockingUserCandidate` snapshot from a `StoredUser` record. */
export function buildBlockingUserCandidate(
  backend: SandboxBackend,
  stored: StoredUser,
  override?: Partial<AuthBlockingUserCandidate>,
): AuthBlockingUserCandidate {
  const providerData: AuthBlockingProviderInfo[] = [];
  for (const entry of stored.providerUserInfo) {
    let providerUid = stored.uid;
    if (entry.providerId === 'password' && stored.email !== null) {
      providerUid = stored.email;
    }
    providerData.push({
      uid: providerUid,
      providerId: entry.providerId,
      displayName: stored.displayName,
      email: stored.email,
      photoURL: stored.photoUrl,
      phoneNumber: stored.phoneNumber,
    });
  }

  let customClaims: Record<string, unknown> | undefined;
  if (Object.keys(stored.customClaims).length > 0) {
    customClaims = structuredClone(stored.customClaims);
  }

  const tokensValidAfterMs = SandboxBackend.projectStoreOf(backend).tokensValidAfterMs.get(
    stored.uid,
  );
  let tokensValidAfterSeconds: number | null = null;
  if (tokensValidAfterMs !== undefined) {
    tokensValidAfterSeconds = Math.floor(tokensValidAfterMs / 1000);
  }

  const base: AuthBlockingUserCandidate = {
    uid: stored.uid,
    email: stored.email,
    emailVerified: stored.emailVerified,
    displayName: stored.displayName,
    photoURL: stored.photoUrl,
    phoneNumber: stored.phoneNumber,
    disabled: stored.disabled,
    creationTime: stored.createdAt,
    lastSignInTime: stored.lastLoginAt,
    providerData,
    customClaims,
    tenantId: stored.tenantId,
    tokensValidAfterSeconds,
  };
  if (override === undefined) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

function readOptionalTokenField(
  primary: Record<string, unknown>,
  fallback: Record<string, unknown>,
  key: string,
): string | undefined {
  const direct = primary[key];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const nested = fallback[key];
  if (typeof nested === 'string' && nested.length > 0) {
    return nested;
  }
  return undefined;
}

/** Extract optional OAuth token fields from an in-page credential or wire payload. */
export function extractBlockingCredentialContext(
  source: unknown,
  claims?: Record<string, unknown>,
): AuthBlockingCredentialContext | undefined {
  if (typeof source !== 'object' || source === null) {
    if (claims !== undefined) {
      return { claims: structuredClone(claims) };
    }
    return undefined;
  }
  const raw = source as Record<string, unknown> & {
    toJSON?: () => Record<string, unknown>;
  };
  let serialized: Record<string, unknown> = {};
  if (typeof raw.toJSON === 'function') {
    const candidate = raw.toJSON();
    if (typeof candidate === 'object' && candidate !== null) {
      serialized = candidate;
    }
  }
  const out: AuthBlockingCredentialContext = {};
  let hasAnyField = false;
  if (claims !== undefined) {
    out.claims = structuredClone(claims);
    hasAnyField = true;
  }
  const idToken = readOptionalTokenField(raw, serialized, 'idToken');
  if (idToken !== undefined) {
    out.idToken = idToken;
    hasAnyField = true;
  }
  const accessToken = readOptionalTokenField(raw, serialized, 'accessToken');
  if (accessToken !== undefined) {
    out.accessToken = accessToken;
    hasAnyField = true;
  }
  const refreshToken = readOptionalTokenField(raw, serialized, 'refreshToken');
  if (refreshToken !== undefined) {
    out.refreshToken = refreshToken;
    hasAnyField = true;
  }
  const secret = readOptionalTokenField(raw, serialized, 'secret');
  if (secret !== undefined) {
    out.secret = secret;
    hasAnyField = true;
  }
  if (!hasAnyField) {
    return undefined;
  }
  return out;
}

/**
 * Run `beforeSignIn` if active, persist permanent user-record updates, enforce
 * `disabled: true` rejection before session issuance, and return transient
 * `sessionClaims`.
 */
export async function runBeforeSignInHook(
  auth: Auth,
  options: RunBeforeSignInOptions,
): Promise<BlockedSignInOutcome> {
  const { backend } = targetOf(auth);
  const stored = backend.findByUid(options.uid);
  if (stored === undefined) {
    throw makeAuthError('auth/user-not-found', `No user found for uid ${options.uid}.`);
  }
  backend.assertSignInAllowed(stored.uid);

  const beforeSignIn = getAuthBlockingHooks(auth)?.beforeSignIn;
  if (beforeSignIn === undefined) {
    options.onApproved?.();
    const current = backend.findByUid(options.uid) ?? stored;
    backend.assertSignInAllowed(current.uid);
    if (options.stageForCurrentUser === true) {
      SandboxBackend.stageBlockingSessionClaims(backend, current.uid, undefined);
    }
    return { user: backend.buildUserFromStored(current) };
  }

  const rawTenant = options.tenantId === undefined ? backend.getTenantId() : options.tenantId;
  const effectiveTenant = normalizeTenantScope(rawTenant);
  const candidate = buildBlockingUserCandidate(backend, stored, options.candidateOverride);

  const response = await beforeSignIn({
    userRecord: candidate,
    signInMethod: options.signInMethod,
    tenantId: effectiveTenant,
    client: options.client,
  });

  let validatedCustomClaims: Record<string, unknown> | undefined;
  let validatedSessionClaims: Record<string, unknown> | undefined;
  if (response) {
    if (response.customClaims !== undefined) {
      validatedCustomClaims = validateBlockingClaimsPayload(
        response.customClaims,
        'customClaims',
      );
    }
    if (response.sessionClaims !== undefined) {
      validatedSessionClaims = validateBlockingClaimsPayload(
        response.sessionClaims,
        'sessionClaims',
      );
      validateCombinedBlockingClaimsPayload(validatedCustomClaims, validatedSessionClaims);
    }
    if (
      response.recaptchaActionOverride !== undefined &&
      response.recaptchaActionOverride !== 'ALLOW' &&
      response.recaptchaActionOverride !== 'BLOCK'
    ) {
      throw makeAuthBlockingRejectionError({
        status: 'INVALID_ARGUMENT',
        message: 'recaptchaActionOverride must be "ALLOW" or "BLOCK".',
      });
    }
  }

  options.onApproved?.();

  let updatedStored = backend.findByUid(options.uid) ?? stored;
  if (response) {
    updatedStored = SandboxBackend.applyBlockedSignInUpdate(backend, options.uid, {
      displayName: response.displayName,
      photoURL: response.photoURL,
      emailVerified: response.emailVerified,
      disabled: response.disabled,
      customClaims: validatedCustomClaims,
    });
  }

  backend.assertSignInAllowed(updatedStored.uid);
  if (options.stageForCurrentUser === true) {
    SandboxBackend.stageBlockingSessionClaims(
      backend,
      updatedStored.uid,
      validatedSessionClaims,
    );
  }
  return {
    user: backend.buildUserFromStored(updatedStored),
    sessionClaims: validatedSessionClaims,
  };
}

/** Validate email/password credentials and invoke `beforeSignIn` before minting a session. */
export async function signInBlockedEmailPasswordUser(
  auth: Auth,
  input: {
    email: string;
    password: string;
    tenantId?: string | null;
    client?: AuthBlockingClientContext;
    stageForCurrentUser?: boolean;
  },
): Promise<BlockedSignInOutcome> {
  const { backend } = targetOf(auth);
  const rawTenant = input.tenantId === undefined ? backend.getTenantId() : input.tenantId;
  const effectiveTenant = normalizeTenantScope(rawTenant);
  backend.assertProviderEnabled('password');
  const stored = backend.validatePassword(input.email, input.password, effectiveTenant);
  return runBeforeSignInHook(auth, {
    uid: stored.uid,
    signInMethod: 'password',
    tenantId: effectiveTenant,
    client: input.client,
    stageForCurrentUser: input.stageForCurrentUser,
  });
}
