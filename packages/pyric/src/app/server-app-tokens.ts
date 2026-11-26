/**
 * Upstream `@firebase/app` 0.16.7 (`firebase@13.4.0`) environment, hash, and
 * JWT token helpers for `initializeServerApp`.
 */
import {
  idTokenAudience,
  normalizeAuthState,
  parseClaimJson,
  rulesTokenFromIdToken,
} from '@pyric/rules/internal';
import type { AuthState } from '../sandbox/types/auth-state.js';
import { SANDBOX_CLOCK, type SandboxClock } from '../sandbox/clock.js';
import { authAccountsFor, type AuthAccountStanding } from 'pyric/sandbox/internal';
import {
  JWS_SHAPE,
  SANDBOX_JWT_KID,
  latin1FromBase64url,
  sandboxSignatureSync,
  utf8FromBase64url,
} from '../sandbox/internal/sandbox-jwt.js';
import type { FirebaseApp, FirebaseOptions, FirebaseServerAppSettings } from './types.js';

const ID_TOKEN_SIGNING_KEY = 'pyric-sandbox-id-token-signing-key';
const MAX_SUBJECT_LENGTH = 128;

function isWebWorkerRealm(): boolean {
  const scope = globalThis as {
    WorkerGlobalScope?: new (...args: never[]) => unknown;
    self?: unknown;
  };
  return (
    typeof scope.WorkerGlobalScope === 'function' &&
    typeof scope.self !== 'undefined' &&
    scope.self instanceof scope.WorkerGlobalScope
  );
}

/** True when running in a browser `Window` (not a WebWorker/ServiceWorker or Node). */
export function isBrowserWindowEnvironment(): boolean {
  const scope = globalThis as { window?: unknown };
  const hasWindow = typeof scope.window !== 'undefined';
  return hasWindow && !isWebWorkerRealm();
}

export function isFirebaseAppObject(value: unknown): value is FirebaseApp {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { options?: unknown }).options !== undefined;
}

export function isFirebaseServerAppSettingsObject(value: unknown): value is FirebaseServerAppSettings {
  if (typeof value !== 'object' || value === null) return false;
  if (isFirebaseAppObject(value)) return false;
  return (
    'authIdToken' in value ||
    'appCheckToken' in value ||
    'releaseOnDeref' in value ||
    'automaticDataCollectionEnabled' in value
  );
}

/** Reads `__FIREBASE_DEFAULTS__.config` from `globalThis` or `process.env`, matching `@firebase/util`. */
export function defaultAppOptionsFromEnvironment(): FirebaseOptions | undefined {
  const globalDefaults = (globalThis as { __FIREBASE_DEFAULTS__?: { config?: FirebaseOptions } })
    .__FIREBASE_DEFAULTS__;
  if (globalDefaults?.config !== undefined) {
    return globalDefaults.config;
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const envJson = proc?.env?.__FIREBASE_DEFAULTS__;
  if (typeof envJson === 'string' && envJson.length > 0) {
    try {
      const parsed = JSON.parse(envJson) as { config?: FirebaseOptions } | null;
      if (parsed && typeof parsed === 'object' && parsed.config !== undefined) {
        return parsed.config;
      }
    } catch (err) {
      // Match @firebase/util getDefaults(): log and return undefined on malformed env JSON.
      console.info(`Unable to get __FIREBASE_DEFAULTS__ due to: ${String(err)}`);
    }
  }
  return undefined;
}

/**
 * Deterministic 32-bit Java `String.hashCode` over `JSON.stringify(nameObj)`
 * with `releaseOnDeref` omitted, matching `@firebase/app` `initializeServerApp`.
 */
export function computeServerAppName(
  options: FirebaseOptions,
  settings: FirebaseServerAppSettings,
): string {
  const nameObj: Record<string, unknown> = {
    ...settings,
    ...options,
  };
  if (nameObj.releaseOnDeref !== undefined) {
    delete nameObj.releaseOnDeref;
  }
  const serialized = JSON.stringify(nameObj);
  let hash = 0;
  for (const ch of serialized) {
    hash = (Math.imul(31, hash) + ch.charCodeAt(0)) | 0;
  }
  return String(hash);
}

function decodeBase64FlexibleUtf8(segment: string | undefined): string | null {
  if (typeof segment !== 'string' || segment.length === 0) return null;
  const normalized = segment.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    return utf8FromBase64url(normalized);
  } catch (err) {
    // Match @firebase/util base64Decode: report decode failure and return null.
    void err;
    return null;
  }
}

/**
 * Upstream `@firebase/app` `validateTokenTTL`: logs `console.error` when the
 * JWT payload cannot be decoded, lacks `exp`, or is already expired; never throws.
 */
export function validateServerTokenTTL(
  base64Token: string,
  tokenName: 'authIdToken' | 'appCheckToken',
  nowMs: number = Date.now(),
): void {
  const parts = base64Token.split('.');
  const secondPart = decodeBase64FlexibleUtf8(parts[1]);
  if (secondPart === null) {
    console.error(`FirebaseServerApp ${tokenName} is invalid: second part could not be parsed.`);
    return;
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(secondPart);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`FirebaseServerApp ${tokenName} is invalid: second part could not be parsed.`);
      return;
    }
    payload = parsed as Record<string, unknown>;
  } catch (err) {
    // Non-JSON payload segment fails local token verification without throwing.
    void err;
    console.error(`FirebaseServerApp ${tokenName} is invalid: second part could not be parsed.`);
    return;
  }
  const expClaim = payload.exp;
  if (expClaim === undefined || typeof expClaim !== 'number' || !Number.isFinite(expClaim)) {
    console.error(`FirebaseServerApp ${tokenName} is invalid: expiration claim could not be parsed`);
    return;
  }
  const expMillis = expClaim * 1000;
  const diff = expMillis - nowMs;
  if (diff <= 0) {
    console.error(`FirebaseServerApp ${tokenName} is invalid: the token has expired.`);
  }
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function currentTimeMs(sandbox: object | undefined): number {
  if (sandbox !== undefined) {
    const carried = (sandbox as Partial<Record<typeof SANDBOX_CLOCK, SandboxClock>>)[SANDBOX_CLOCK];
    if (carried !== undefined) {
      return carried.now();
    }
  }
  return Date.now();
}

function hasValidServerIdTokenHeader(header: Record<string, unknown>): boolean {
  if (header.alg !== 'RS256') return false;
  if (typeof header.kid !== 'string' || header.kid.length === 0) return false;
  return header.kid === SANDBOX_JWT_KID;
}

function hasValidAudienceAndIssuer(
  claims: Record<string, unknown>,
  expectedProjectId: string | undefined,
): boolean {
  const aud = claims.aud;
  if (typeof aud !== 'string' || aud.length === 0) return false;
  const hasExpectedProject = typeof expectedProjectId === 'string' && expectedProjectId.length > 0;
  if (hasExpectedProject && aud !== expectedProjectId) return false;
  let targetProjectId = aud;
  if (hasExpectedProject) {
    targetProjectId = expectedProjectId;
  }
  const expectedIssuer = idTokenAudience(targetProjectId).iss;
  return claims.iss === expectedIssuer;
}

function hasValidServerIdTokenTiming(claims: Record<string, unknown>, nowMs: number): boolean {
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  if (exp * 1000 <= nowMs) return false;
  const nowSec = Math.floor(nowMs / 1000);
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > nowSec) {
      return false;
    }
  }
  if (claims.auth_time !== undefined) {
    if (typeof claims.auth_time !== 'number' || !Number.isFinite(claims.auth_time)) {
      return false;
    }
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
      return false;
    }
  }
  return true;
}

function extractVerifiedSubjectUid(claims: Record<string, unknown>): string | null {
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUBJECT_LENGTH) {
    return null;
  }
  if (claims.user_id !== undefined) {
    if (typeof claims.user_id !== 'string' || claims.user_id !== sub) {
      return null;
    }
  }
  return sub;
}

function isAccountStandingValidForToken(
  standing: AuthAccountStanding,
  claims: Record<string, unknown>,
): boolean {
  if (standing.kind === 'deleted' || standing.kind === 'unrecorded') return false;
  if (standing.kind === 'disabled') return false;
  const validAfterMs = standing.tokensValidAfterMs;
  if (validAfterMs === null) return true;
  const authTime = claims.auth_time;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) return false;
  return Math.floor(authTime) * 1000 >= validAfterMs;
}

function extractVerifiedTenant(
  claims: Record<string, unknown>,
): { ok: true; tenant: string | undefined } | { ok: false } {
  const firebaseClaim = claims.firebase;
  if (firebaseClaim === undefined) {
    return { ok: true, tenant: undefined };
  }
  if (!isPlainJsonRecord(firebaseClaim)) {
    return { ok: false };
  }
  const rawTenant = firebaseClaim.tenant;
  if (rawTenant === undefined || rawTenant === null) {
    return { ok: true, tenant: undefined };
  }
  if (typeof rawTenant === 'string' && rawTenant.length > 0) {
    return { ok: true, tenant: rawTenant };
  }
  return { ok: false };
}

/**
 * Synchronously validates a sandbox Auth ID token (`settings.authIdToken`) and
 * extracts its normalized `{ uid, token, tenant? }` `AuthState` when valid and unrevoked.
 */
export function authStateFromServerIdToken(
  token: string,
  expectedProjectId: string | undefined,
  sandbox?: object,
): AuthState {
  if (typeof token !== 'string' || !JWS_SHAPE.test(token)) return null;
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const headerSeg = segments[0];
  const claimsSeg = segments[1];
  const sigSeg = segments[2];
  if (!headerSeg || !claimsSeg || !sigSeg) return null;

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    const rawHeader: unknown = JSON.parse(latin1FromBase64url(headerSeg));
    const rawClaims: unknown = parseClaimJson(utf8FromBase64url(claimsSeg));
    if (!isPlainJsonRecord(rawHeader) || !isPlainJsonRecord(rawClaims)) return null;
    header = rawHeader;
    claims = rawClaims;
  } catch (err) {
    // Malformed JWT segments cannot resume a server-app Auth session.
    void err;
    return null;
  }

  if (!hasValidServerIdTokenHeader(header)) return null;
  const expectedSig = sandboxSignatureSync(ID_TOKEN_SIGNING_KEY, `${headerSeg}.${claimsSeg}`);
  if (sigSeg !== expectedSig) return null;

  if (!hasValidAudienceAndIssuer(claims, expectedProjectId)) return null;
  if (!hasValidServerIdTokenTiming(claims, currentTimeMs(sandbox))) return null;

  const uid = extractVerifiedSubjectUid(claims);
  if (uid === null) return null;

  const tenantResult = extractVerifiedTenant(claims);
  if (!tenantResult.ok) return null;

  if (sandbox !== undefined) {
    const accounts = authAccountsFor(sandbox);
    if (accounts !== undefined) {
      if (!isAccountStandingValidForToken(accounts.standing(uid), claims)) {
        return null;
      }
    }
  }

  const rulesToken = rulesTokenFromIdToken(claims);
  const authState: NonNullable<AuthState> = { uid, token: rulesToken };
  if (tenantResult.tenant !== undefined) {
    authState.tenant = tenantResult.tenant;
  }
  return normalizeAuthState(authState);
}
