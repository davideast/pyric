import type { AuthCredential } from 'pyric/auth';
import type { OpMessage } from '../protocol.js';
import type { SerializedAuthCredential } from '../protocol/auth.js';

/** The fields of an `AuthCredential` the served client reads. */
export type SignInCredential = {
  providerId: string;
  signInMethod?: string;
  toJSON?: () => Record<string, unknown>;
};

type CredentialWire = NonNullable<
  Extract<OpMessage, { method: 'auth.signInWithCredential' }>['credential']
>;

/** A credential with no sign-in method sends an empty one, which the host refuses. */
export function credentialWire(credential: SignInCredential): CredentialWire {
  const isEmailCredential = credential.providerId === 'password';
  if (isEmailCredential) {
    const serialized = credential.toJSON?.() ?? {};
    return {
      ...serialized,
      providerId: credential.providerId,
      signInMethod: credential.signInMethod ?? '',
    };
  }
  return federatedCredentialWire(credential);
}

/** A federated credential as the host reads it: its provider and, when it has one, its sign-in method. */
function federatedCredentialWire(credential: {
  providerId: string;
  signInMethod?: string;
}): {
  providerId: string;
  signInMethod?: string;
} {
  const { providerId, signInMethod } = credential;
  if (signInMethod === undefined) {
    return { providerId };
  }
  return { providerId, signInMethod };
}

/**
 * A credential a signed-in user links or reauthenticates with, as it crosses
 * to the host: an email credential as `toJSON()`, with the password or link
 * the engine verifies, and any other as its provider and sign-in method.
 */
export function credentialWireOf(credential: AuthCredential): SerializedAuthCredential {
  const { providerId, signInMethod } = credential;
  if (providerId === 'password') {
    return { ...credential.toJSON(), providerId, signInMethod };
  }
  return { providerId, signInMethod };
}

/**
 * Mirrors `@firebase/auth` `updateProfile` over Identity Toolkit `/v1/accounts:update`:
 * `undefined` and `null` leave the stored attribute intact, while `""` clears to `null`.
 */
export function normalizeWorkerProfileUpdate(profile: {
  displayName?: string | null;
  photoURL?: string | null;
}): { displayName?: string | null; photoURL?: string | null } {
  const out: { displayName?: string | null; photoURL?: string | null } = {};
  if (typeof profile.displayName === 'string') {
    if (profile.displayName.length === 0) {
      out.displayName = null;
    } else {
      out.displayName = profile.displayName;
    }
  }
  if (typeof profile.photoURL === 'string') {
    if (profile.photoURL.length === 0) {
      out.photoURL = null;
    } else {
      out.photoURL = profile.photoURL;
    }
  }
  return out;
}
