/**
 * Provider marker classes.
 *
 * Mirror `firebase/auth`'s provider classes at the static-field level
 * (`PROVIDER_ID`) and the instance-method level (`addScope`,
 * `setCustomParameters`, `credentialFromResult`,
 * `credentialFromError`).
 *
 * Sandbox treats `addScope` / `setCustomParameters` as no-ops — they
 * exist for API-surface parity so consumer code typechecks
 * unchanged. `credentialFromResult` synthesizes a fake
 * {@link AuthCredential} from the result; the credential is opaque
 * and only useful as input to `signInWithCredential`, where the
 * sandbox cross-checks the `providerId` against a pre-staged mock
 * result (see `sandbox.mockSignInResult`).
 */

import type { AuthCredential, UserCredential } from './types.js';

function synthesizeCredential(providerId: string, result: UserCredential | null): AuthCredential | null {
  if (!result) return null;
  return {
    providerId,
    signInMethod: providerId,
  };
}

/** Google OAuth provider. Sandbox marker; no real OAuth flow runs. */
export class GoogleAuthProvider {
  static readonly PROVIDER_ID = 'google.com';
  static readonly GOOGLE_SIGN_IN_METHOD = 'google.com';
  readonly providerId = GoogleAuthProvider.PROVIDER_ID;

  addScope(_scope: string): GoogleAuthProvider { return this; }
  setCustomParameters(_params: Record<string, unknown>): GoogleAuthProvider { return this; }

  static credentialFromResult(result: UserCredential): AuthCredential | null {
    return synthesizeCredential(GoogleAuthProvider.PROVIDER_ID, result);
  }
  static credentialFromError(_err: unknown): AuthCredential | null {
    return null;
  }
  /** Construct a credential directly from an OAuth id_token /
   *  access_token. Sandbox accepts any string; opaque marker only. */
  static credential(_idToken: string | null, _accessToken?: string | null): AuthCredential {
    return { providerId: GoogleAuthProvider.PROVIDER_ID, signInMethod: GoogleAuthProvider.PROVIDER_ID };
  }
}

/** Email + password provider — marker class, used as the
 *  `providerId` on email/password credentials. */
export class EmailAuthProvider {
  static readonly PROVIDER_ID = 'password';
  static readonly EMAIL_PASSWORD_SIGN_IN_METHOD = 'password';
  static readonly EMAIL_LINK_SIGN_IN_METHOD = 'emailLink';
  readonly providerId = EmailAuthProvider.PROVIDER_ID;

  static credential(_email: string, _password: string): AuthCredential {
    return { providerId: EmailAuthProvider.PROVIDER_ID, signInMethod: EmailAuthProvider.EMAIL_PASSWORD_SIGN_IN_METHOD };
  }
  static credentialWithLink(_email: string, _emailLink: string): AuthCredential {
    return { providerId: EmailAuthProvider.PROVIDER_ID, signInMethod: EmailAuthProvider.EMAIL_LINK_SIGN_IN_METHOD };
  }
}

/** Facebook OAuth provider. */
export class FacebookAuthProvider {
  static readonly PROVIDER_ID = 'facebook.com';
  static readonly FACEBOOK_SIGN_IN_METHOD = 'facebook.com';
  readonly providerId = FacebookAuthProvider.PROVIDER_ID;

  addScope(_scope: string): FacebookAuthProvider { return this; }
  setCustomParameters(_params: Record<string, unknown>): FacebookAuthProvider { return this; }

  static credentialFromResult(result: UserCredential): AuthCredential | null {
    return synthesizeCredential(FacebookAuthProvider.PROVIDER_ID, result);
  }
  static credentialFromError(_err: unknown): AuthCredential | null {
    return null;
  }
  static credential(_accessToken: string): AuthCredential {
    return { providerId: FacebookAuthProvider.PROVIDER_ID, signInMethod: FacebookAuthProvider.FACEBOOK_SIGN_IN_METHOD };
  }
}

/** GitHub OAuth provider. */
export class GithubAuthProvider {
  static readonly PROVIDER_ID = 'github.com';
  static readonly GITHUB_SIGN_IN_METHOD = 'github.com';
  readonly providerId = GithubAuthProvider.PROVIDER_ID;

  addScope(_scope: string): GithubAuthProvider { return this; }
  setCustomParameters(_params: Record<string, unknown>): GithubAuthProvider { return this; }

  static credentialFromResult(result: UserCredential): AuthCredential | null {
    return synthesizeCredential(GithubAuthProvider.PROVIDER_ID, result);
  }
  static credentialFromError(_err: unknown): AuthCredential | null {
    return null;
  }
  static credential(_accessToken: string): AuthCredential {
    return { providerId: GithubAuthProvider.PROVIDER_ID, signInMethod: GithubAuthProvider.GITHUB_SIGN_IN_METHOD };
  }
}

/**
 * Generic OAuth provider — constructed with a providerId so callers
 * can target arbitrary OAuth IdPs (Twitter, Apple, etc.) that don't
 * have a dedicated class above.
 */
export class OAuthProvider {
  readonly providerId: string;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  addScope(_scope: string): OAuthProvider { return this; }
  setCustomParameters(_params: Record<string, unknown>): OAuthProvider { return this; }

  credential(_args: { idToken?: string; accessToken?: string; rawNonce?: string }): AuthCredential {
    return { providerId: this.providerId, signInMethod: this.providerId };
  }

  static credentialFromResult(result: UserCredential): AuthCredential | null {
    return synthesizeCredential(result.providerId ?? 'unknown', result);
  }
  static credentialFromError(_err: unknown): AuthCredential | null {
    return null;
  }
}

/**
 * The canonical federated (OAuth) provider ids the sandbox supports as
 * FIRST-CLASS: the dedicated provider classes' `PROVIDER_ID`s
 * ({@link GoogleAuthProvider} / {@link FacebookAuthProvider} /
 * {@link GithubAuthProvider}) plus the standard Firebase IdP set reached
 * through the generic {@link OAuthProvider} (Apple, Twitter, Microsoft,
 * Yahoo — the same federated ids the emulator console recognizes).
 *
 * NOT an allowlist: the backend accepts ANY provider id (custom
 * `OAuthProvider('oidc.acme')` etc. work end-to-end). This constant exists
 * so admin surfaces (Studio's user editor, provider toggles) can enumerate
 * the supported set mechanically instead of hardcoding copies. `password`
 * / `anonymous` / `phone` are deliberately absent — they're credential-
 * derived sign-in methods, not federated links.
 */
export const FEDERATED_PROVIDER_IDS = [
  GoogleAuthProvider.PROVIDER_ID,
  'apple.com',
  FacebookAuthProvider.PROVIDER_ID,
  GithubAuthProvider.PROVIDER_ID,
  'twitter.com',
  'microsoft.com',
  'yahoo.com',
] as const;

/** One of the first-class federated provider ids ({@link FEDERATED_PROVIDER_IDS}). */
export type FederatedProviderId = (typeof FEDERATED_PROVIDER_IDS)[number];

/**
 * Union of all supported provider instance shapes. Used in the
 * `signInWithPopup` / `signInWithRedirect` overloads (the latter is
 * out of scope but the type makes the surface consistent).
 */
export type AuthProvider =
  | GoogleAuthProvider
  | FacebookAuthProvider
  | GithubAuthProvider
  | OAuthProvider
  | { readonly providerId: string };
