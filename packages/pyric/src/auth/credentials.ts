/**
 * Auth credential classes — `AuthCredential` and its two concrete
 * subclasses, plus `getAdditionalUserInfo`.
 *
 * ─── Why these are CLASSES that carry a secret ─────────────────────
 * Before the linking / reauth climb, `pyric/auth` modeled a credential
 * as a bare `{ providerId, signInMethod }` marker: an opaque token whose
 * only job was to be matched against a pre-staged `mockSignInResult`.
 * That is sufficient for OAuth, where the secret genuinely lives with
 * the identity provider and the sandbox has nothing to check.
 *
 * It is NOT sufficient for the two flows this climb adds. Both
 * `linkWithCredential(user, cred)` and
 * `reauthenticateWithCredential(user, cred)` have to ANSWER A QUESTION
 * about the credential — "does this password actually belong to this
 * account?" — and a marker with no secret in it cannot be asked. An
 * email/password credential carries its own secret, so those two flows
 * are decidable entirely inside the sandbox, with no resolver and no
 * mock: the backend already stores and verifies passwords.
 *
 * Hence {@link EmailAuthCredential} carries the email plus EITHER a
 * password or an email link, and the sandbox validates against the user
 * DB exactly as `signInWithEmailAndPassword` does.
 * {@link OAuthCredential} carries the IdP tokens, which the sandbox
 * still cannot verify — those flows keep going through the resolver /
 * mock seam, which is the honest model (the sandbox is not Google).
 *
 * The `{ providerId, signInMethod }` shape is preserved exactly, so
 * every existing consumer (`signInWithCredential`'s provider match, the
 * mock registry) keeps working unchanged.
 */

import { ProviderId, SignInMethod } from './enums.js';
import type { UserCredential } from './types.js';

/**
 * Base auth credential. Mirrors `firebase/auth`'s abstract
 * `AuthCredential`: an opaque token identifying a provider and the
 * method used to sign in with it.
 *
 * Concrete, not abstract, so `instanceof AuthCredential` narrowing and
 * direct construction both work in consumer code. Upstream marks it
 * abstract, but nothing in the modular surface constructs a bare
 * `AuthCredential` — the providers' static factories do.
 */
export class AuthCredential {
  /** Provider identifier (e.g. `'google.com'`, `'password'`). */
  readonly providerId: string;
  /** Sign-in method identifier. Distinct from {@link providerId}: the
   *  `'password'` provider signs in via `'password'` OR `'emailLink'`. */
  readonly signInMethod: string;

  constructor(providerId: string, signInMethod: string) {
    this.providerId = providerId;
    this.signInMethod = signInMethod;
  }

  /** Serialize. Mirrors upstream's `AuthCredential.toJSON()`. */
  toJSON(): Record<string, unknown> {
    return { providerId: this.providerId, signInMethod: this.signInMethod };
  }

  /**
   * Deserialize a credential previously produced by {@link toJSON}.
   * Returns `null` for input that isn't a credential payload — matching
   * upstream, which never throws here.
   */
  static fromJSON(json: string | Record<string, unknown>): AuthCredential | null {
    const obj = typeof json === 'string' ? safeParse(json) : json;
    if (!obj) return null;
    const providerId = obj['providerId'];
    const signInMethod = obj['signInMethod'];
    if (typeof providerId !== 'string' || typeof signInMethod !== 'string') return null;
    if (providerId === ProviderId.PASSWORD) {
      const email = typeof obj['email'] === 'string' ? obj['email'] : '';
      const secret = typeof obj['password'] === 'string' ? obj['password'] : '';
      return new EmailAuthCredential(email, secret, signInMethod);
    }
    return new AuthCredential(providerId, signInMethod);
  }
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Email/password (or email-link) credential. Mirrors `firebase/auth`'s
 * `EmailAuthCredential`.
 *
 * Carries the SECRET — which is the whole reason the linking and reauth
 * families are decidable in the sandbox without a resolver (see the file
 * docstring). The secret is `password` for the `'password'` sign-in
 * method and the email LINK for the `'emailLink'` method.
 *
 * `_secret` is deliberately non-enumerable: it must not leak into a
 * `JSON.stringify(cred)` in host/log code. {@link toJSON} exposes it
 * only for the round-trip upstream also supports.
 */
export class EmailAuthCredential extends AuthCredential {
  /** The account this credential is for. */
  readonly email: string;

  /** The password, or (for `signInMethod === 'emailLink'`) the link.
   *  Assigned via `defineProperty` in the constructor (to make it
   *  non-enumerable), which TS cannot see — hence the `!`. */
  private readonly secret!: string;

  constructor(email: string, secret: string, signInMethod: string = SignInMethod.EMAIL_PASSWORD) {
    super(ProviderId.PASSWORD, signInMethod);
    this.email = email;
    // Non-enumerable so an accidental `JSON.stringify(user.credential)`
    // in host or log code does not print the password.
    Object.defineProperty(this, 'secret', {
      value: secret,
      enumerable: false,
      writable: false,
    });
  }

  /** The password carried by a `'password'`-method credential, else `null`. */
  get password(): string | null {
    return this.signInMethod === SignInMethod.EMAIL_PASSWORD ? this.secret : null;
  }

  /** The email link carried by an `'emailLink'`-method credential, else `null`. */
  get emailLink(): string | null {
    return this.signInMethod === SignInMethod.EMAIL_LINK ? this.secret : null;
  }

  override toJSON(): Record<string, unknown> {
    return {
      providerId: this.providerId,
      signInMethod: this.signInMethod,
      email: this.email,
      password: this.secret,
    };
  }
}

/**
 * OAuth credential. Mirrors `firebase/auth`'s `OAuthCredential`.
 *
 * Carries the IdP tokens the real flow would have obtained. The sandbox
 * does NOT and cannot verify them — it is not the identity provider —
 * so flows consuming one of these still resolve through the
 * `AuthFlowResolver` / `mockSignInResult` seam. Keeping the tokens on
 * the object anyway means a resolver implementation (a playground
 * picker, a test fixture) can read whatever the caller passed.
 */
export class OAuthCredential extends AuthCredential {
  readonly idToken?: string;
  readonly accessToken?: string;
  readonly secret?: string;

  constructor(
    providerId: string,
    signInMethod: string,
    tokens: { idToken?: string; accessToken?: string; secret?: string } = {},
  ) {
    super(providerId, signInMethod);
    this.idToken = tokens.idToken;
    this.accessToken = tokens.accessToken;
    this.secret = tokens.secret;
  }

  override toJSON(): Record<string, unknown> {
    return {
      providerId: this.providerId,
      signInMethod: this.signInMethod,
      idToken: this.idToken,
      accessToken: this.accessToken,
      secret: this.secret,
    };
  }
}

/**
 * Per-provider extra data attached to a sign-in. Mirrors
 * `firebase/auth`'s `AdditionalUserInfo`.
 */
export interface AdditionalUserInfo {
  /** Was this credential produced by a sign-UP rather than a sign-IN? */
  readonly isNewUser: boolean;
  /** IdP-specific profile blob. Empty object for the sandbox's own
   *  providers — there is no real IdP behind them to return a profile. */
  readonly profile: Record<string, unknown> | null;
  /** The provider that authenticated this user, or `null` for the
   *  anonymous and custom-token paths (neither is a federated provider —
   *  see the `ProviderId` docstring in `enums.ts`). */
  readonly providerId: string | null;
  /** Present only for GitHub / Twitter. */
  readonly username?: string | null;
}

/**
 * `getAdditionalUserInfo(userCredential)` — mirror of `firebase/auth`.
 *
 * Reads the info the sandbox recorded on the credential when it minted
 * it. `isNewUser` is true only when the credential came from a flow that
 * CREATED the identity (`createUserWithEmailAndPassword`,
 * `signInAnonymously`, a first-time email-link sign-in, a link that
 * upgraded an anonymous account).
 *
 * Oracle (`observations/auth/auth-additional-user-info-shape.json`):
 * against prod an anonymous sign-in yields
 * `{ isNewUser: true, providerId: null, profile: {} }` — note
 * `providerId: null`, not `'anonymous'`, because anonymous is not a
 * federated provider.
 */
export function getAdditionalUserInfo(userCredential: UserCredential): AdditionalUserInfo | null {
  const carried = (userCredential as { _additionalUserInfo?: AdditionalUserInfo })._additionalUserInfo;
  if (carried) return carried;
  // A credential minted before this field existed (a host-synthesized
  // one, an older mockSignInResult). Derive what we honestly can rather
  // than fabricating an isNewUser we never observed: a credential we did
  // not mint is, by definition, not a fresh sign-up.
  return {
    isNewUser: false,
    profile: {},
    providerId: userCredential.providerId,
  };
}
