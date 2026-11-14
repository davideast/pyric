/**
 * `AppCheck` service implementation and `getAppCheck` factory for `pyric-admin/app-check`.
 */
import {
  checkAppCheckToken,
  mintAppCheckToken,
  type AppCheckIdentity,
  type AppCheckTokenClaims,
} from 'pyric/sandbox/internal';
import type { PyricAdminApp } from '../app/index.js';
import { getDefaultServiceApp } from '../app/default-service-app.js';
import { explicitProjectId } from '../app/project-id.js';
import { assertAdminAppActive } from '../app/lifecycle.js';
import { FirebaseAppCheckError } from './error.js';
import { verifyFirebaseToken } from './firebase-token.js';
import type {
  AppCheckToken,
  AppCheckTokenOptions,
  VerifyAppCheckTokenOptions,
  VerifyAppCheckTokenResponse,
} from './types.js';

const MINUTE_MILLIS = 60 * 1000;
const MIN_TTL_MILLIS = 30 * MINUTE_MILLIS;
const MAX_TTL_MILLIS = 7 * 24 * 60 * MINUTE_MILLIS;
const DEFAULT_TTL_MILLIS = 60 * MINUTE_MILLIS;
const LIMITED_USE_TTL_MILLIS = 5 * MINUTE_MILLIS;

const MESSAGES = {
  notString: 'App check token must be a non-null string.',
  options: 'VerifyAppCheckTokenOptions must be a non-null object.',
  createOptions: 'AppCheckTokenOptions must be a non-null object.',
  algorithm: (alg: unknown) =>
    `The provided App Check token has incorrect algorithm. Expected "RS256" but got "${String(alg)}".`,
  noSub: 'The provided App Check token has no "sub" (subject) claim.',
  emptySub: 'The provided App Check token has an empty string "sub" (subject) claim.',
  ttlDuration: 'ttlMillis must be a duration in milliseconds.',
  ttl: 'ttlMillis must be a duration in milliseconds between 30 minutes and 7 days (inclusive).',
  limitedUse: '`limitedUse` must be a boolean value.',
  jtiString: '`jti` must be a string value.',
  jtiWithoutLimitedUse: '`jti` cannot be specified without setting `limitedUse` to `true`.',
  appId: '`appId` must be a non-empty string.',
  decode:
    'Decoding App Check token failed. Make sure you passed the entire string JWT which represents the Firebase App Check token.',
  signature: 'The provided App Check token has invalid signature.',
  expired:
    'The provided App Check token has expired. Get a fresh App Check token from your client app and try again.',
  issuer: 'The provided App Check token has incorrect "iss" (issuer) claim.',
  createNoProject:
    'Failed to determine project ID. Initialize the SDK with service account credentials or set project ID as an app option. Alternatively, set the GOOGLE_CLOUD_PROJECT environment variable.',
  noProject:
    'Must initialize app with a cert credential or set your Firebase project ID as the GOOGLE_CLOUD_PROJECT environment variable to verify an App Check token.',
  audience: (scoped: string, aud: unknown) =>
    `The provided App Check token has incorrect "aud" (audience) claim. Expected "${scoped}" but got "${String(aud)}". Make sure the App Check token comes from the same Firebase project as the service account used to authenticate this SDK.`,
};

const APP_CHECK_ISSUER = 'https://firebaseappcheck.googleapis.com/';

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

function validateCreateTokenOptions(options: AppCheckTokenOptions | undefined): void {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new FirebaseAppCheckError('invalid-argument', MESSAGES.createOptions);
  }
  if (options.ttlMillis !== undefined) {
    if (typeof options.ttlMillis !== 'number' || Number.isNaN(options.ttlMillis)) {
      throw new FirebaseAppCheckError('invalid-argument', MESSAGES.ttlDuration);
    }
    if (options.ttlMillis < MIN_TTL_MILLIS || options.ttlMillis > MAX_TTL_MILLIS) {
      throw new FirebaseAppCheckError('invalid-argument', MESSAGES.ttl);
    }
  }
}

function resolveRequestedTtlMillis(options: AppCheckTokenOptions | undefined): number {
  if (options?.ttlMillis !== undefined) {
    return options.ttlMillis;
  }
  if (options?.limitedUse) {
    return LIMITED_USE_TTL_MILLIS;
  }
  return DEFAULT_TTL_MILLIS;
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

  createToken(appId: string, options?: AppCheckTokenOptions): Promise<AppCheckToken> {
    assertAdminAppActive(this.#app);
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new FirebaseAppCheckError('invalid-argument', MESSAGES.appId);
    }
    validateCreateTokenOptions(options);
    return this.#createToken(appId, options);
  }

  async #createToken(appId: string, options: AppCheckTokenOptions | undefined): Promise<AppCheckToken> {
    const projectId = explicitProjectId(this.#app);
    if (!projectId) throw new FirebaseAppCheckError('unknown-error', MESSAGES.createNoProject);
    if (options?.limitedUse !== undefined && typeof options.limitedUse !== 'boolean') {
      throw new FirebaseAppCheckError('invalid-argument', MESSAGES.limitedUse);
    }
    if (options?.jti !== undefined) {
      if (typeof options.jti !== 'string') {
        throw new FirebaseAppCheckError('invalid-argument', MESSAGES.jtiString);
      }
      if (!options.limitedUse) {
        throw new FirebaseAppCheckError('invalid-argument', MESSAGES.jtiWithoutLimitedUse);
      }
    }
    const requestedTtlMillis = resolveRequestedTtlMillis(options);
    const identity: AppCheckIdentity = { appId, projectId };
    if (options?.jti !== undefined) {
      identity.jti = options.jti;
    }
    const minted = await mintAppCheckToken(identity, Math.round(requestedTtlMillis / 1000));
    return { token: minted.token, ttlMillis: Math.floor(requestedTtlMillis) };
  }

  verifyToken(appCheckToken: string, options?: VerifyAppCheckTokenOptions): Promise<VerifyAppCheckTokenResponse> {
    assertAdminAppActive(this.#app);
    const optionsAreObject = typeof options === 'object' && options !== null && !Array.isArray(options);
    if (options !== undefined && !optionsAreObject) {
      throw new FirebaseAppCheckError('invalid-argument', MESSAGES.options);
    }
    if (typeof appCheckToken !== 'string') {
      throw new FirebaseAppCheckError('invalid-argument', MESSAGES.notString);
    }
    return this.#verify(appCheckToken, options);
  }

  async #verify(
    appCheckToken: string,
    options: VerifyAppCheckTokenOptions | undefined,
  ): Promise<VerifyAppCheckTokenResponse> {
    const projectId = this.#projectId();
    const check = await checkAppCheckToken(appCheckToken);
    if (!check.ok && check.reason === 'malformed') {
      throw new FirebaseAppCheckError('invalid-argument', MESSAGES.decode);
    }
    const isFirebaseToken = !check.ok && check.reason === 'kid';
    if (isFirebaseToken) {
      const verified = await verifyFirebaseToken(appCheckToken, projectId);
      return this.#recordConsume(verified, appCheckToken, options);
    }
    verifyContent(check.header, check.claims, projectId);
    if (!check.ok) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.signature);
    verifyNotBefore(check.claims.nbf);
    verifyExpiry(check.claims.exp);
    const claims = check.claims as AppCheckTokenClaims;
    const result: VerifyAppCheckTokenResponse = {
      appId: claims.sub,
      token: { ...claims, app_id: claims.sub },
    };
    return this.#recordConsume(result, appCheckToken, options);
  }

  #recordConsume(
    result: VerifyAppCheckTokenResponse,
    appCheckToken: string,
    options: VerifyAppCheckTokenOptions | undefined,
  ): VerifyAppCheckTokenResponse {
    if (!options?.consume) return result;
    const consumed = consumedFor(this.#app);
    const jti = result.token.jti;
    let tokenId = appCheckToken;
    if (typeof jti === 'string') {
      tokenId = jti;
    }
    const alreadyConsumed = consumed.has(tokenId);
    consumed.add(tokenId);
    return { alreadyConsumed, appId: result.appId, token: result.token };
  }

  #projectId(): string {
    const projectId = explicitProjectId(this.#app);
    if (!projectId) throw new FirebaseAppCheckError('invalid-credential', MESSAGES.noProject);
    return projectId;
  }
}

function verifyContent(
  header: Readonly<Record<string, unknown>>,
  claims: Readonly<Record<string, unknown>>,
  projectId: string,
): void {
  if (header.alg !== 'RS256') {
    throw new FirebaseAppCheckError('invalid-argument', MESSAGES.algorithm(header.alg));
  }
  const scoped = `projects/${projectId}`;
  const audienceMatches =
    Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.includes(scoped);
  if (!audienceMatches) {
    throw new FirebaseAppCheckError('invalid-argument', MESSAGES.audience(scoped, claims.aud));
  }
  const issuerMatches = typeof claims.iss === 'string' && claims.iss.startsWith(APP_CHECK_ISSUER);
  if (!issuerMatches) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.issuer);
  if (typeof claims.sub !== 'string') {
    throw new FirebaseAppCheckError('invalid-argument', MESSAGES.noSub);
  }
  if (claims.sub === '') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.emptySub);
}

function verifyNotBefore(nbf: unknown): void {
  if (nbf === undefined) return;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const active = typeof nbf === 'number' && nbf <= nowSeconds;
  if (!active) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.signature);
}

function verifyExpiry(exp: unknown): void {
  if (exp === undefined) return;
  if (typeof exp !== 'number') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.signature);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds >= exp) throw new FirebaseAppCheckError('app-check-token-expired', MESSAGES.expired);
}

const instances = new WeakMap<PyricAdminApp, AppCheck>();

export function getAppCheck(app?: PyricAdminApp): AppCheck {
  const resolved = app ?? getDefaultServiceApp();
  assertAdminAppActive(resolved);
  const existing = instances.get(resolved);
  if (existing) return existing;
  const instance = new AppCheck(resolved);
  instances.set(resolved, instance);
  return instance;
}
