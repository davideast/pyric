/**
 * Unsigned and OIDC JWT payload decoding for federated `signInWithCredential`
 * calls when no explicit `sandbox.mockSignInResult` override is staged.
 *
 * Matches the Firebase Auth Emulator (`signInWithIdp` OIDC `id_token` path):
 * accepts 2-segment (`header.payload`) or 3-segment (`header.payload.sig`)
 * base64/base64url JWTs whose header and payload decode to JSON objects with a
 * non-empty `sub` claim, mapping `sub`, `email`, `email_verified`, `name`, and
 * `picture` onto the sandbox user store. Non-JWT opaque strings, malformed
 * segments, or payloads without `sub` return `null` so callers fall through to
 * `auth/no-mock-configured`.
 */

import { parseClaimJson, providerVerifiesEmail, utf8FromBase64url } from 'pyric/sandbox/internal';
import { makeAuthError } from '../auth-errors.js';
import { isFederatedProviderId } from '../providers.js';
import type { CreateUserRequest, UpdateUserRequest } from '../sandbox-backend-types.js';
import { assertMatchingTenant, normalizeTenantScope } from './tenant-isolation.js';
import { targetOf } from '../target.js';
import type { Auth, User } from '../types.js';

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const BASE64_SIGNATURE_SEGMENT = /^[A-Za-z0-9+/_=-]+$/;

export interface DecodedOidcIdToken {
  readonly sub: string;
  readonly email: string | null;
  readonly emailVerified: boolean | undefined;
  readonly displayName: string | null;
  readonly photoURL: string | null;
  readonly claims: Record<string, unknown>;
}

export interface ResolveOidcJwtInput {
  readonly providerId: string;
  readonly idToken: string;
  readonly tenantId?: string | null;
}

export interface ResolvedOidcJwtIdentity {
  readonly user: User;
  readonly uid: string;
  readonly isNewUser: boolean;
  readonly claims: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBase64urlSegment(segment: string): string | null {
  const normalized = segment
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (normalized.length === 0) {
    return null;
  }
  if (!BASE64URL_SEGMENT.test(normalized)) {
    return null;
  }
  return normalized;
}

function decodeBase64JsonObject(segment: string): Record<string, unknown> | null {
  const normalized = normalizeBase64urlSegment(segment);
  if (normalized === null) {
    return null;
  }
  try {
    const decodedText = utf8FromBase64url(normalized);
    const parsed: unknown = parseClaimJson(decodedText);
    if (!isPlainRecord(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseOptionalEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (raw.trim().length === 0) {
    return null;
  }
  return raw;
}

function parseOptionalNonEmptyString(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  if (raw.length === 0) {
    return null;
  }
  return raw;
}

function parseOptionalBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  return undefined;
}

/**
 * Decode an unsigned or OIDC JWT `idToken` into standard identity claims, or
 * return `null` when `idToken` is not a well-formed JWT carrying a non-empty `sub`.
 */
export function decodeOidcIdTokenClaims(idToken: unknown): DecodedOidcIdToken | null {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return null;
  }
  const segments = idToken.split('.');
  if (segments.length !== 2 && segments.length !== 3) {
    return null;
  }
  const rawHeader = segments[0];
  const rawPayload = segments[1];
  const rawSignature = segments[2];
  if (rawHeader === undefined || rawPayload === undefined) {
    return null;
  }
  if (rawHeader.length === 0 || rawPayload.length === 0) {
    return null;
  }
  if (rawSignature !== undefined && rawSignature.length > 0) {
    if (!BASE64_SIGNATURE_SEGMENT.test(rawSignature)) {
      return null;
    }
  }
  const header = decodeBase64JsonObject(rawHeader);
  if (header === null) {
    return null;
  }
  const claims = decodeBase64JsonObject(rawPayload);
  if (claims === null) {
    return null;
  }
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.trim().length === 0) {
    return null;
  }
  return {
    sub,
    email: parseOptionalEmail(claims['email']),
    emailVerified: parseOptionalBoolean(claims['email_verified']),
    displayName: parseOptionalNonEmptyString(claims['name']),
    photoURL: parseOptionalNonEmptyString(claims['picture']),
    claims: { ...claims },
  };
}

function resolveNewAccountEmailVerified(
  decoded: DecodedOidcIdToken,
  providerId: string,
): boolean {
  if (decoded.emailVerified !== undefined) {
    return decoded.emailVerified;
  }
  if (decoded.email === null) {
    return false;
  }
  return providerVerifiesEmail(providerId);
}

/**
 * Resolve or upsert a federated user from an OIDC JWT `idToken` without
 * mutating the backend's active `currentUser` session. Returns `null` when the
 * provider is non-federated or `idToken` is not a valid OIDC JWT with `sub`.
 */
export function resolveOidcJwtIdentity(
  auth: Auth,
  input: ResolveOidcJwtInput,
): ResolvedOidcJwtIdentity | null {
  if (!isFederatedProviderId(input.providerId)) {
    return null;
  }
  const decoded = decodeOidcIdTokenClaims(input.idToken);
  if (decoded === null) {
    return null;
  }
  const target = targetOf(auth);
  const { backend } = target;
  let rawTenant = input.tenantId;
  if (rawTenant === undefined) {
    rawTenant = backend.getTenantId();
  }
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
      verifyEmail: decoded.emailVerified !== false,
    });

    const updateReq: UpdateUserRequest = {};
    let hasUpdate = false;
    if (decoded.displayName !== null && decoded.displayName !== existing.displayName) {
      updateReq.displayName = decoded.displayName;
      hasUpdate = true;
    }
    if (existing.email === null && decoded.email !== null) {
      const takenByOther = backend.findByEmail(decoded.email, effectiveTenant);
      if (takenByOther === undefined) {
        updateReq.email = decoded.email;
        hasUpdate = true;
      }
    }
    if (decoded.emailVerified === true && !existing.emailVerified) {
      const hasPassword = existing.password !== null;
      const hasOtherProvider = existing.providerUserInfo.some(
        (entry) => entry.providerId !== input.providerId,
      );
      if (!hasPassword && !hasOtherProvider) {
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

  const createReq: CreateUserRequest & { tenantId?: string | null } = {
    uid: decoded.sub,
    emailVerified: resolveNewAccountEmailVerified(decoded, input.providerId),
    providerUserInfo: [{ providerId: input.providerId }],
  };
  if (decoded.email !== null) {
    createReq.email = decoded.email;
  }
  if (decoded.displayName !== null) {
    createReq.displayName = decoded.displayName;
  }
  if (decoded.photoURL !== null) {
    createReq.photoUrl = decoded.photoURL;
  }
  if (effectiveTenant !== null) {
    createReq.tenantId = effectiveTenant;
  }
  backend.createUser(createReq);

  const created = backend.findByUid(decoded.sub);
  if (created === undefined) {
    throw makeAuthError(
      'auth/internal-error',
      'signInWithCredential: could not materialize OIDC account.',
    );
  }
  return {
    user: backend.buildUserFromStored(created),
    uid: created.uid,
    isNewUser: true,
    claims: decoded.claims,
  };
}
