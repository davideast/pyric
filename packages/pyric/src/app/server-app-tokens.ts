/**
 * Upstream `@firebase/app` 0.16.7 (`firebase@13.4.0`) environment, hash, and
 * JWT token helpers for `initializeServerApp`.
 */
import { parseClaimJson } from '@pyric/rules/internal';
import type { AuthState } from '../sandbox/types/auth-state.js';
import { authAccountsFor, refreshRefusal } from '../sandbox/internal/auth-accounts.js';
import { decodeBase64url } from '../sandbox/internal/base64url.js';
import {
  JWS_SHAPE,
  SANDBOX_JWT_KID,
  latin1FromBase64url,
  sandboxSignatureSync,
  utf8FromBase64url,
} from '../sandbox/internal/sandbox-jwt.js';
import type { FirebaseApp, FirebaseOptions, FirebaseServerAppSettings } from './types.js';

const ID_TOKEN_SIGNING_KEY = 'pyric-sandbox-id-token-signing-key';

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
  if (expClaim === undefined || typeof expClaim !== 'number') {
    console.error(`FirebaseServerApp ${tokenName} is invalid: expiration claim could not be parsed`);
    return;
  }
  const expMillis = expClaim * 1000;
  const diff = expMillis - Date.now();
  if (diff <= 0) {
    console.error(`FirebaseServerApp ${tokenName} is invalid: the token has expired.`);
  }
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Synchronously validates a sandbox Auth ID token (`settings.authIdToken`) and
 * extracts its `{ uid, token }` `AuthState` when valid and unrevoked.
 */
export function authStateFromServerIdToken(
  token: string,
  expectedProjectId: string | undefined,
  sandbox?: object,
): AuthState {
  if (!JWS_SHAPE.test(token)) return null;
  const segments = token.split('.');
  const headerSeg = segments[0];
  const claimsSeg = segments[1];
  const sigSeg = segments[2];
  if (headerSeg === undefined || claimsSeg === undefined || sigSeg === undefined) return null;

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

  if (Boolean(header.kid) && header.kid !== SANDBOX_JWT_KID) return null;
  const expectedSig = sandboxSignatureSync(ID_TOKEN_SIGNING_KEY, `${headerSeg}.${claimsSeg}`);
  if (sigSeg !== expectedSig) return null;

  const exp = claims.exp;
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null;

  if (typeof expectedProjectId === 'string' && expectedProjectId.length > 0) {
    if (typeof claims.aud === 'string' && claims.aud.length > 0 && claims.aud !== expectedProjectId) {
      return null;
    }
  }

  let uid = '';
  if (typeof claims.user_id === 'string' && claims.user_id.length > 0) {
    uid = claims.user_id;
  } else if (typeof claims.sub === 'string' && claims.sub.length > 0) {
    uid = claims.sub;
  }
  if (uid.length === 0) return null;

  if (sandbox !== undefined) {
    const accounts = authAccountsFor(sandbox);
    if (accounts !== undefined) {
      let authAtMs: number | undefined;
      if (typeof claims.iat === 'number') {
        authAtMs = claims.iat * 1000;
      }
      const refusal = refreshRefusal(accounts.standing(uid), authAtMs);
      if (refusal !== null) return null;
    }
  }

  return { uid, token: claims };
}
