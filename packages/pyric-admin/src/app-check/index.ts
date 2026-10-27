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
import { getApp, type PyricAdminApp } from '../app/index.js';
import { assertAdminAppActive } from '../app/lifecycle.js';

const MINUTE_MILLIS = 60 * 1000;
const MIN_TTL_MILLIS = 30 * MINUTE_MILLIS;
const MAX_TTL_MILLIS = 7 * 24 * 60 * MINUTE_MILLIS;
const DEFAULT_TTL_MILLIS = 60 * MINUTE_MILLIS;

const MESSAGES = {
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

class FirebaseAppCheckError extends Error {
  readonly code: string;

  constructor(code: AppCheckErrorCode, message: string) {
    super(message);
    this.name = 'FirebaseAppCheckError';
    this.code = `app-check/${code}`;
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

/** Consumed token ids, per sandbox: replay protection lives with the backend the app talks to. */
const consumedBySandbox = new WeakMap<object, Set<string>>();

function consumedFor(app: PyricAdminApp): Set<string> {
  const key = app.sandbox as object;
  let consumed = consumedBySandbox.get(key);
  if (!consumed) {
    consumed = new Set();
    consumedBySandbox.set(key, consumed);
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

  async verifyToken(appCheckToken: string, options?: VerifyAppCheckTokenOptions): Promise<VerifyAppCheckTokenResponse> {
    assertAdminAppActive(this.#app);
    const projectId = this.#projectId();
    const check = typeof appCheckToken === 'string' ? await checkAppCheckToken(appCheckToken) : ({ ok: false, reason: 'malformed' } as const);
    if (!check.ok && check.reason === 'malformed') throw new FirebaseAppCheckError('invalid-argument', MESSAGES.decode);
    // Upstream checks the content before the signature (token-verifier.js decodeAndVerify).
    verifyContent(check.claims, projectId);
    if (!check.ok) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.signature);
    const { claims } = check;
    if (claims.exp * 1000 <= Date.now()) throw new FirebaseAppCheckError('app-check-token-expired', MESSAGES.expired);
    const result: VerifyAppCheckTokenResponse = { appId: claims.sub, token: { ...claims, app_id: claims.sub } };
    if (options?.consume === true) {
      const consumed = consumedFor(this.#app);
      result.alreadyConsumed = consumed.has(claims.jti);
      consumed.add(claims.jti);
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

function verifyContent(claims: AppCheckTokenClaims, projectId: string): void {
  const scoped = `projects/${projectId}`;
  const audienceMatches = Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.includes(scoped);
  if (!audienceMatches) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.audience(scoped, claims.aud));
  const issuerMatches = typeof claims.iss === 'string' && claims.iss.startsWith(APP_CHECK_ISSUER);
  if (!issuerMatches) throw new FirebaseAppCheckError('invalid-argument', MESSAGES.issuer);
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
