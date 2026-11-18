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

import { ActionCodeURL } from './action-code-url.js';
import { buildActionLink } from './action-codes.js';
import { ProviderId, SignInMethod } from './enums.js';
import type { UserCredential } from './types.js';

interface EmailCredentialSecret {
  readonly secret: string;
  readonly rawLink: string | null;
}

const EMAIL_CREDENTIAL_SECRETS = new WeakMap<EmailAuthCredential, EmailCredentialSecret>();

function parseJsonRecord(json: string | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof json === 'string') {
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    return json;
  }
  return null;
}

/**
 * Base auth credential. Mirrors `firebase/auth`'s abstract
 * `AuthCredential`: an opaque token identifying a provider and the
 * method used to sign in with it.
 *
 * Concrete, not abstract, so `instanceof AuthCredential` narrowing and
 * direct construction both work in consumer code. Upstream marks it
 * abstract, but nothing in the modular surface constructs a bare
 * `AuthCredential` -- the providers' static factories do.
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
   * Returns `null` for input that isn't a credential payload -- matching
   * upstream, which never throws here.
   */
  static fromJSON(json: string | Record<string, unknown>): AuthCredential | null {
    const obj = parseJsonRecord(json);
    if (obj === null) {
      return null;
    }
    const emailCred = EmailAuthCredential.fromJSON(obj);
    if (emailCred !== null) {
      return emailCred;
    }
    const oauthCred = OAuthCredential.fromJSON(obj);
    if (oauthCred !== null) {
      return oauthCred;
    }
    const providerId = obj['providerId'];
    const signInMethod = obj['signInMethod'];
    if (typeof providerId !== 'string' || typeof signInMethod !== 'string') {
      return null;
    }
    if (providerId === ProviderId.PASSWORD) {
      return null;
    }
    return new AuthCredential(providerId, signInMethod);
  }
}

/**
 * Email/password (or email-link) credential. Mirrors `firebase/auth`'s
 * `EmailAuthCredential`.
 *
 * Carries the secret off-instance in a private `WeakMap` so `Object.keys`
 * and object spreads never enumerate it, while {@link toJSON} and
 * {@link fromJSON} round-trip `{ email, password, signInMethod, tenantId }`
 * identically to upstream `firebase/auth` (where `password` holds the
 * password for `'password'` credentials and the parsed `oobCode` for
 * `'emailLink'` credentials).
 */
export class EmailAuthCredential extends AuthCredential {
  /** The account this credential is for. */
  readonly email: string;
  /** Tenant scope serialized by upstream `EmailAuthCredential.toJSON()`. */
  readonly tenantId: string | null;

  constructor(
    email: string,
    secret: string,
    signInMethod: string = SignInMethod.EMAIL_PASSWORD,
    options: { tenantId?: string | null; rawLink?: string | null } = {},
  ) {
    super(ProviderId.PASSWORD, signInMethod);
    this.email = email;
    let resolvedTenant: string | null = null;
    if (typeof options.tenantId === 'string') {
      resolvedTenant = options.tenantId;
    }
    this.tenantId = resolvedTenant;
    let resolvedLink: string | null = null;
    if (typeof options.rawLink === 'string') {
      resolvedLink = options.rawLink;
    }
    EMAIL_CREDENTIAL_SECRETS.set(this, {
      secret,
      rawLink: resolvedLink,
    });
  }

  /** The password carried by a `'password'`-method credential, else `null`. */
  get password(): string | null {
    if (this.signInMethod !== SignInMethod.EMAIL_PASSWORD) {
      return null;
    }
    const entry = EMAIL_CREDENTIAL_SECRETS.get(this);
    if (entry === undefined) {
      return null;
    }
    return entry.secret;
  }

  /** The email link carried by an `'emailLink'`-method credential, else `null`. */
  get emailLink(): string | null {
    if (this.signInMethod !== SignInMethod.EMAIL_LINK) {
      return null;
    }
    const entry = EMAIL_CREDENTIAL_SECRETS.get(this);
    if (entry === undefined || entry.secret.length === 0) {
      return null;
    }
    if (entry.rawLink !== null) {
      return entry.rawLink;
    }
    if (ActionCodeURL.parseLink(entry.secret) !== null) {
      return entry.secret;
    }
    return buildActionLink('signIn', entry.secret, null);
  }

  override toJSON(): Record<string, unknown> {
    const entry = EMAIL_CREDENTIAL_SECRETS.get(this);
    let serializedSecret = '';
    if (entry !== undefined) {
      serializedSecret = entry.secret;
    }
    return {
      email: this.email,
      password: serializedSecret,
      signInMethod: this.signInMethod,
      tenantId: this.tenantId,
    };
  }

  static override fromJSON(json: string | Record<string, unknown>): EmailAuthCredential | null {
    const obj = parseJsonRecord(json);
    if (obj === null) {
      return null;
    }
    const email = obj['email'];
    const secret = obj['password'];
    const signInMethod = obj['signInMethod'];
    if (
      typeof email !== 'string' ||
      typeof secret !== 'string' ||
      typeof signInMethod !== 'string'
    ) {
      return null;
    }
    const isSupportedMethod =
      signInMethod === SignInMethod.EMAIL_PASSWORD || signInMethod === SignInMethod.EMAIL_LINK;
    if (!isSupportedMethod || email.length === 0 || secret.length === 0) {
      return null;
    }
    let tenantId: string | null = null;
    if (typeof obj['tenantId'] === 'string') {
      tenantId = obj['tenantId'];
    }
    return new EmailAuthCredential(email, secret, signInMethod, { tenantId });
  }
}

/**
 * OAuth credential. Mirrors `firebase/auth`'s `OAuthCredential`.
 */
export class OAuthCredential extends AuthCredential {
  readonly idToken?: string;
  readonly accessToken?: string;
  readonly secret?: string;
  readonly nonce?: string;
  private readonly pendingToken: string | null;

  constructor(
    providerId: string,
    signInMethod: string,
    tokens: {
      idToken?: string;
      accessToken?: string;
      secret?: string;
      rawNonce?: string;
      pendingToken?: string | null;
    } = {},
  ) {
    super(providerId, signInMethod);
    this.idToken = tokens.idToken;
    this.accessToken = tokens.accessToken;
    this.secret = tokens.secret;
    this.nonce = tokens.rawNonce;
    let resolvedPending: string | null = null;
    if (typeof tokens.pendingToken === 'string') {
      resolvedPending = tokens.pendingToken;
    }
    this.pendingToken = resolvedPending;
  }

  override toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.idToken !== undefined) {
      out['idToken'] = this.idToken;
    }
    if (this.accessToken !== undefined) {
      out['accessToken'] = this.accessToken;
    }
    if (this.secret !== undefined) {
      out['secret'] = this.secret;
    }
    if (this.nonce !== undefined) {
      out['nonce'] = this.nonce;
    }
    out['pendingToken'] = this.pendingToken;
    out['providerId'] = this.providerId;
    out['signInMethod'] = this.signInMethod;
    return out;
  }

  static override fromJSON(json: string | Record<string, unknown>): OAuthCredential | null {
    const obj = parseJsonRecord(json);
    if (obj === null) {
      return null;
    }
    const providerId = obj['providerId'];
    const signInMethod = obj['signInMethod'];
    if (typeof providerId !== 'string' || typeof signInMethod !== 'string') {
      return null;
    }
    const hasTokenField =
      typeof obj['idToken'] === 'string' ||
      typeof obj['accessToken'] === 'string' ||
      typeof obj['secret'] === 'string' ||
      typeof obj['nonce'] === 'string' ||
      'pendingToken' in obj;
    if (!hasTokenField) {
      return null;
    }
    const tokens: {
      idToken?: string;
      accessToken?: string;
      secret?: string;
      rawNonce?: string;
      pendingToken?: string | null;
    } = {};
    if (typeof obj['idToken'] === 'string') {
      tokens.idToken = obj['idToken'];
    }
    if (typeof obj['accessToken'] === 'string') {
      tokens.accessToken = obj['accessToken'];
    }
    if (typeof obj['secret'] === 'string') {
      tokens.secret = obj['secret'];
    }
    if (typeof obj['nonce'] === 'string') {
      tokens.rawNonce = obj['nonce'];
    }
    if (typeof obj['pendingToken'] === 'string') {
      tokens.pendingToken = obj['pendingToken'];
    }
    return new OAuthCredential(providerId, signInMethod, tokens);
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
