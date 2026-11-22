/**
 * Staged sign-in results for the worker client plane (#1466, #1491, #1505).
 *
 * Kept engine-free (no runtime imports from `pyric/auth`) so `@pyric/cli/serve/worker`
 * remains a leaf browser bundle for Studio and Playground.
 */

import { FirebaseError } from 'pyric/app';
import type { ResolvedIdentity, SerializedUserCredential } from '../protocol.js';
import { hydrateCred, type ClientAuth, type ClientUserCredential } from './auth.js';
import { nextId, rpc } from './core.js';

const FEDERATED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'google.com',
  'apple.com',
  'facebook.com',
  'github.com',
  'twitter.com',
  'microsoft.com',
  'yahoo.com',
]);

const NON_FEDERATED_IDENTITY_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'password',
  'phone',
  'anonymous',
]);

const CUSTOM_FEDERATED_PROVIDER_ID = /^(oidc|saml)\.\S+$/;

function isFederatedProvider(providerId: string): boolean {
  return FEDERATED_PROVIDER_IDS.has(providerId) || CUSTOM_FEDERATED_PROVIDER_ID.test(providerId);
}

function isSupportedIdentityProvider(providerId: string): boolean {
  return isFederatedProvider(providerId) || NON_FEDERATED_IDENTITY_PROVIDER_IDS.has(providerId);
}

/** The parts of a staged `UserCredential` the host needs: who signs in, and through which provider. */
interface StagedSignInResult {
  readonly user: {
    readonly uid: string;
    readonly email?: string | null;
    readonly displayName?: string | null;
    readonly photoURL?: string | null;
    readonly emailVerified?: boolean;
  };
  readonly providerId: string | null;
}

/** A staged profile field the host accepts: a string, or null when absent. Anything else throws at the call. */
function profileField(value: unknown): string | null {
  const isAbsent = value === undefined || value === null;
  if (isAbsent) return null;
  const isString = typeof value === 'string';
  if (!isString) {
    throw new FirebaseError(
      'invalid-argument',
      'sandbox.mockSignInResult: result.user.email, displayName and photoURL must be strings or null.',
    );
  }
  return value;
}

/**
 * Stage the user this port's next federated sign-in (`signInWithCredential` or
 * `signInWithPopup` / `signInWithRedirect`) for `result.providerId` signs in as
 * (served `sandbox.mockSignInResult`, #1466, #1491, #1505).
 * Sent without waiting, as the `tenantId` setter is: the port delivers in order,
 * so the host has it before the next sign-in. The checks the host would make run
 * here first, so a malformed result throws at the call.
 */
export function stageSignInResult(auth: ClientAuth, result: StagedSignInResult): void {
  const providerId = result.providerId;
  const uid = result.user?.uid;
  const hasProvider = typeof providerId === 'string' && providerId.trim() !== '';
  const hasUid = typeof uid === 'string' && uid.trim() !== '';
  if (!hasProvider || !hasUid) {
    throw new FirebaseError(
      'invalid-argument',
      'sandbox.mockSignInResult: result.providerId and result.user.uid must be non-empty strings.',
    );
  }
  if (!isSupportedIdentityProvider(providerId)) {
    throw new FirebaseError(
      'invalid-argument',
      `sandbox.mockSignInResult: unsupported providerId "${providerId}".`,
    );
  }
  const identity: ResolvedIdentity = {
    uid,
    providerId,
    email: profileField(result.user.email),
    displayName: profileField(result.user.displayName),
    photoURL: profileField(result.user.photoURL),
    customClaims: {},
    // In-page, a staged user without the flag is unverified; the wire says so.
    emailVerified: result.user.emailVerified === true,
  };
  // The signature is void, so an error reply (a deleted app, a refused send)
  // has nowhere to go; the next sign-in reports auth/no-mock-configured.
  rpc(auth.port, { t: 'op', id: nextId(), method: 'auth.mockSignInResult', identity }).catch(() => {});
}

/**
 * Consume this port's staged result for a federated provider before opening
 * the served sign-in picker (#1505). Returns `null` when nothing is staged for
 * `providerId`; propagates provider-config (`auth/operation-not-allowed`) and
 * blocking-hook errors directly.
 */
export async function consumeStagedSignIn(
  auth: ClientAuth,
  providerId: string,
): Promise<ClientUserCredential | null> {
  if (!isFederatedProvider(providerId)) {
    return null;
  }
  try {
    const raw = (await rpc(auth.port, {
      t: 'op',
      id: nextId(),
      method: 'auth.signInWithCredential',
      credential: { providerId, signInMethod: providerId },
      tenantId: auth.tenantId,
    })) as SerializedUserCredential;
    return hydrateCred(auth, raw);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'auth/no-mock-configured') {
      return null;
    }
    throw error;
  }
}
