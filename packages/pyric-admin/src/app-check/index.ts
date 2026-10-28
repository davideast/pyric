/**
 * `pyric-admin/app-check`: the sandbox mirror of `firebase-admin/app-check`.
 *
 * `createToken` mints the same sandbox token the web mirror's `getToken`
 * returns (shared in `pyric/sandbox/internal`), so a token minted on either
 * plane verifies here. Shapes, TTL limits, error codes, and consume semantics
 * follow the `app-check-admin-` captures; the rows are in
 * packages/conformance/registry/app-check.ts (surface `app-check-admin`).
 *
 * One deliberate difference: the sandbox has no list of the project's
 * registered apps, so `createToken` accepts any app id (row
 * `app-check-admin#create-token-unknown-app`, diverged by design).
 */
import { checkAppCheckToken, mintAppCheckToken, type AppCheckTokenClaims } from 'pyric/sandbox/internal';
import { PrefixedFirebaseError } from '../app/firebase-error.js';
import { getApp, type PyricAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';

const MINUTE_MILLIS = 60 * 1000;
const MIN_TTL_MILLIS = 30 * MINUTE_MILLIS;
const MAX_TTL_MILLIS = 7 * 24 * 60 * MINUTE_MILLIS;
const DEFAULT_TTL_MILLIS = 60 * MINUTE_MILLIS;

const MESSAGES = {
  notString: 'App check token must be a non-null string.',
  options: 'VerifyAppCheckTokenOptions must be a non-null object.',
  algorithm: (alg: unknown) => `The provided App Check token has incorrect algorithm. Expected "RS256" but got "${String(alg)}".`,
  noSub: 'The provided App Check token has no "sub" (subject) claim.',
  emptySub: 'The provided App Check token has an empty string "sub" (subject) claim.',
  noMatchingKid:
    'The provided App Check token has "kid" claim which does not correspond to a known public key. Most likely the provided App Check token is expired, so get a fresh token from your client app and try again.',
  ttl: 'ttlMillis must be a duration in milliseconds between 30 minutes and 7 days (inclusive).',
  appId: '`appId` must be a non-empty string.',
  decode: 'Decoding App Check token failed. Make sure you passed the entire string JWT which represents the Firebase App Check token.',
  signature: 'The provided App Check token has invalid signature.',
  expired: 'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.',
  issuer: 'The provided App Check token has incorrect "iss" (issuer) claim.',
  createNoProject:
    'Failed to determine project ID. Initialize the SDK with service account credentials or set project ID as an app option. Alternatively, set the GOOGLE_CLOUD_PROJECT environment variable.',
  noProject:
    'Must initialize app with a cert credential or set your Firebase project ID as the GOOGLE_CLOUD_PROJECT environment variable to verify an App Check token.',
  audience: (scoped: string, aud: unknown) =>
    `The provided App Check token has incorrect "aud" (audience) claim. Expected "${scoped}" but got "${String(aud)}". Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.`,
};

const APP_CHECK_ISSUER = 'https://firebaseappcheck.googleapis.com/';

type AppCheckErrorCode = 'invalid-argument' | 'invalid-credential' | 'app-check-token-expired' | 'unknown-error';

/** firebase-admin's FirebaseAppCheckError: a PrefixedFirebaseError with prefix `app-check`. */
class FirebaseAppCheckError extends PrefixedFirebaseError {
  constructor(code: AppCheckErrorCode, message: string) {
    super('app-check', code, message);
  }
}

export interface AppCheckTokenOptions {
  ttlMillis?: number;
}

export interface AppCheckToken {
  token: string;
  ttlMillis: number;
}

export interface VerifyAppCheckTokenOptions {
  consume?: boolean;
}

export interface DecodedAppCheckToken extends AppCheckTokenClaims {
  app_id: string;
}

export interface VerifyAppCheckTokenResponse {
  appId: string;
  token: DecodedAppCheckToken;
  alreadyConsumed?: boolean;
}

/**
 * Consumed token ids, per sandbox handle, for this process. The map sits
 * behind Symbol.for, as the app registry in ../app/index.ts does, so the
 * require and import copies of this module that the register hook can load
 * share it. It is in memory: it does not survive a restart, and two processes
 * on one dev server each keep their own. Production consumes once per
 * project; moving this into the sandbox is #1297.
 */
const CONSUMED_BY_SANDBOX = Symbol.for('pyric.admin.appCheck.consumedBySandbox');
type GlobalConsumed = { [CONSUMED_BY_SANDBOX]?: WeakMap<object, Set<string>> };

function consumedFor(app: PyricAdminApp): Set<string> {
  const global = globalThis as GlobalConsumed;
  const bySandbox = (global[CONSUMED_BY_SANDBOX] ??= new WeakMap());
  const key = app.sandbox as object;
  let consumed = bySandbox.get(key);
  if (!consumed) {
    consumed = new Set();
    bySandbox.set(key, consumed);
  }
  return consumed;
}

function ttlFrom(options: AppCheckTokenOptions | undefined): number {
  const ttl = options?.ttlMillis ?? DEFAULT_TTL_MILLIS;
  const inRange = typeof ttl === 'number' && ttl >= MIN_TTL_MILLIS && ttl <= MAX_TTL_MILLIS;
  if (!inRange) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.ttl);
  return ttl;
}

export class AppCheck {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(app: PyricAdminApp) {
    this.#app = app;
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  async createToken(appId: string, options?: AppCheckTokenOptions): Promise<AppCheckToken> {
    assertAdminAppActive(this.#app);
    if (typeof appId !== 'string' || appId.length === 0) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.appId);
    const ttlMillis = ttlFrom(options);
    const projectId = this.#configuredProjectId();
    if (!projectId) throw new FirebaseAppCheckError('unknown-error', MESSAGES.createNoProject);
    const minted = await mintAppCheckToken({ appId, projectId }, Math.floor(ttlMillis / 1000));
    return { token: minted.token, ttlMillis };
  }

  /**
   * Checks in firebase-admin's order (app-check.js, token-verifier.js,
   * utils/jwt.js): the options and the token's type, synchronously as
   * upstream throws them; then the project, decoding, content, key,
   * signature, and last `nbf` and `exp` as jsonwebtoken reads them.
   */
  verifyToken(appCheckToken: string, options?: VerifyAppCheckTokenOptions): Promise<VerifyAppCheckTokenResponse> {
    assertAdminAppActive(this.#app);
    const optionsAreObject = typeof options === 'object' && options !== null && !Array.isArray(options);
    if (options !== undefined && !optionsAreObject) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.options);
    if (typeof appCheckToken !== 'string') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.notString);
    return this.#verify(appCheckToken, options);
  }

  async #verify(appCheckToken: string, options: VerifyAppCheckTokenOptions | undefined): Promise<VerifyAppCheckTokenResponse> {
    const projectId = this.#projectId();
    const check = await checkAppCheckToken(appCheckToken);
    if (!check.ok && check.reason === 'malformed') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.decode);
    verifyContent(check.header, check.claims, projectId);
    if (!check.ok && check.reason === 'kid') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.noMatchingKid);
    if (!check.ok) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.signature);
    verifyNotBefore(check.claims.nbf);
    verifyExpiry(check.claims.exp);
    const claims = check.claims as AppCheckTokenClaims;
    const result: VerifyAppCheckTokenResponse = { appId: claims.sub, token: { ...claims, app_id: claims.sub } };
    if (options?.consume) {
      const consumed = consumedFor(this.#app);
      const tokenId = typeof claims.jti === 'string' ? claims.jti : appCheckToken;
      result.alreadyConsumed = consumed.has(tokenId);
      consumed.add(tokenId);
    }
    return result;
  }

  /** The app's project, found where firebase-admin's findProjectId looks: the app options, then the environment. */
  #configuredProjectId(): string | undefined {
    return this.#app.options.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || undefined;
  }

  /** The project a token must be scoped to, resolved as firebase-admin resolves it. */
  #projectId(): string {
    const projectId = this.#configuredProjectId();
    if (!projectId) throw new FirebaseAppCheckError('invalid-credential', MESSAGES.noProject);
    return projectId;
  }
}

/** token-verifier.js verifyContent: algorithm, audience, issuer, then subject, first failure wins. */
function verifyContent(header: Readonly<Record<string, unknown>>, claims: Readonly<Record<string, unknown>>, projectId: string): void {
  if (header.alg !== 'RS256') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.algorithm(header.alg));
  const scoped = `projects/${projectId}`;
  const audienceMatches = Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.includes(scoped);
  if (!audienceMatches) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.audience(scoped, claims.aud));
  const issuerMatches = typeof claims.iss === 'string' && claims.iss.startsWith(APP_CHECK_ISSUER);
  if (!issuerMatches) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.issuer);
  if (typeof claims.sub !== 'string') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.noSub);
  if (claims.sub === '') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.emptySub);
}

/** jsonwebtoken's nbf rule, which runs before exp: firebase-admin reports both failures as an invalid signature. */
function verifyNotBefore(nbf: unknown): void {
  if (nbf === undefined) return;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const active = typeof nbf === 'number' && nbf <= nowSeconds;
  if (!active) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.signature);
}

/**
 * jsonwebtoken's exp rule: an absent `exp` never expires, a non-number is an
 * error that firebase-admin reports as an invalid signature, and the token is
 * expired once the current second reaches `exp`.
 */
function verifyExpiry(exp: unknown): void {
  if (exp === undefined) return;
  if (typeof exp !== 'number') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.signature);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds >= exp) throw new FirebaseAppCheckError('app-check-token-expired', MESSAGES.expired);
}

const instances = new WeakMap<PyricAdminApp, AppCheck>();

export function getAppCheck(app?: PyricAdminApp): AppCheck {
  const resolved = app ?? getApp();
  assertAdminAppActive(resolved);
  const existing = instances.get(resolved);
  if (existing) return existing;
  const instance = new AppCheck(resolved);
  instances.set(resolved, instance);
  return instance;
}
