/**
 * Modular token decoders for `pyric-admin/auth` verification.
 * Each decoder strategy isolates prefix detection and claim decoding
 * for one recognized token format.
 */
import type { DecodedIdToken } from './types.js';

/**
 * Token format minted by `createCustomToken` and parsed by
 * `verifyIdToken`. Exported as a constant so tests can lock the shape.
 *
 * Layout: `pyric-sandbox-custom:${uid}:${jsonClaims}`
 *
 * - The prefix lets `verifyIdToken` reject foreign tokens with a clear
 *   "not a sandbox token" error rather than NaN'ing out.
 * - `uid` is colon-free per the auto-uid format above.
 * - `jsonClaims` is the JSON-stringified developer claims (or `{}` when
 *   none were provided). Round-trips losslessly through `JSON.parse`.
 *
 * NOT a JWT. NOT signed. Do not use this token format to talk to any
 * real Firebase service — it only round-trips through this same
 * sandbox backend.
 */
export const SANDBOX_TOKEN_PREFIX = 'pyric-sandbox-custom';

export interface TokenDecoder {
  readonly name: string;
  readonly prefix: string;
  decode(token: string, nowSec: number): DecodedIdToken;
}

function resolveStringClaim(claims: Record<string, unknown>, key: string, fallback: string): string {
  const val = claims[key];
  const hasStringValue = typeof val === 'string';
  return hasStringValue ? val : fallback;
}

function resolveNumberClaim(claims: Record<string, unknown>, key: string, fallback: number): number {
  const val = claims[key];
  const hasNumberValue = typeof val === 'number';
  return hasNumberValue ? val : fallback;
}

function resolveUid(idToken: string, firstColon: number, claims: Record<string, unknown>): string {
  const rawSub = claims['sub'];
  const hasExplicitSubjectClaim = typeof rawSub === 'string';
  if (hasExplicitSubjectClaim) {
    return rawSub;
  }
  const prefixSegment = idToken.slice('sandbox-id-token-'.length, firstColon);
  const lastHyphen = prefixSegment.lastIndexOf('-');
  const hasHyphenatedSerialSuffix = lastHyphen > 0;
  if (hasHyphenatedSerialSuffix) {
    return prefixSegment.slice(0, lastHyphen);
  }
  return prefixSegment;
}

function resolveFirebaseClaim(
  claims: Record<string, unknown>,
): { identities: Record<string, unknown>; sign_in_provider: string } {
  const rawFirebase = claims['firebase'];
  const isMissingFirebaseClaim = !rawFirebase || typeof rawFirebase !== 'object';
  if (isMissingFirebaseClaim) {
    return { identities: {}, sign_in_provider: 'custom' };
  }
  const fb = rawFirebase as Record<string, unknown>;
  const signInProvider = resolveStringClaim(fb, 'sign_in_provider', 'custom');
  const rawIdentities = fb['identities'];
  const isMissingIdentitiesMap = !rawIdentities || typeof rawIdentities !== 'object';
  if (isMissingIdentitiesMap) {
    return { identities: {}, sign_in_provider: signInProvider };
  }
  return { identities: rawIdentities as Record<string, unknown>, sign_in_provider: signInProvider };
}

const customTokenDecoder: TokenDecoder = {
  name: 'custom-token',
  prefix: `${SANDBOX_TOKEN_PREFIX}:`,
  decode(idToken: string, nowSec: number): DecodedIdToken {
    const firstColon = idToken.indexOf(':');
    const secondColon = idToken.indexOf(':', firstColon + 1);
    const isMissingClaimsSegment = secondColon < 0;
    if (isMissingClaimsSegment) {
      throw new Error(
        `pyric-admin/auth: verifyIdToken received a malformed sandbox token (missing claims segment): ${idToken}`,
      );
    }
    const uid = idToken.slice(firstColon + 1, secondColon);
    const jsonClaims = idToken.slice(secondColon + 1);
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(jsonClaims) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `pyric-admin/auth: verifyIdToken failed to parse sandbox token claims as JSON: ${(e as Error).message}`,
      );
    }
    return {
      aud: 'pyric-sandbox',
      auth_time: nowSec,
      exp: nowSec + 3600,
      firebase: {
        identities: {},
        sign_in_provider: 'custom',
      },
      iat: nowSec,
      iss: 'pyric-sandbox',
      sub: uid,
      uid,
      ...claims,
    };
  },
};

const clientIdTokenDecoder: TokenDecoder = {
  name: 'client-id-token',
  prefix: 'sandbox-id-token-',
  decode(idToken: string, nowSec: number): DecodedIdToken {
    const firstColon = idToken.indexOf(':');
    const isMissingClaimsSegment = firstColon < 0;
    if (isMissingClaimsSegment) {
      throw new Error(
        `pyric-admin/auth: verifyIdToken received a malformed client ID token (missing claims segment after colon): ${idToken}`,
      );
    }
    const jsonClaims = idToken.slice(firstColon + 1);
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(jsonClaims) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `pyric-admin/auth: verifyIdToken failed to parse client ID token claims as JSON: ${(e as Error).message}`,
      );
    }
    const uid = resolveUid(idToken, firstColon, claims);
    const aud = resolveStringClaim(claims, 'aud', 'pyric-sandbox');
    const iss = resolveStringClaim(claims, 'iss', 'https://sandbox.pyric.dev');
    const exp = resolveNumberClaim(claims, 'exp', nowSec + 3600);
    const iat = resolveNumberClaim(claims, 'iat', nowSec);
    const authTime = resolveNumberClaim(claims, 'auth_time', nowSec);
    const firebase = resolveFirebaseClaim(claims);

    return {
      ...claims,
      aud,
      auth_time: authTime,
      exp,
      firebase,
      iat,
      iss,
      sub: uid,
      uid,
    };
  },
};

export const TOKEN_DECODERS: TokenDecoder[] = [customTokenDecoder, clientIdTokenDecoder];
