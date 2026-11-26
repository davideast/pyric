/**
 * Sandbox session cookie minting and verification for `pyric-admin/auth`
 * (`createSessionCookie` and `verifySessionCookie`), shared by the in-process
 * and remote arms.
 *
 * Uses a signing key distinct from sandbox ID tokens and issuer prefix
 * `https://session.firebase.google.com/<projectId>` so ID tokens and session
 * cookies never verify interchangeably.
 */
import {
  checkSandboxJwt,
  CUSTOM_TOKEN_AUDIENCE,
  signSandboxJwtSync,
  type AuthAccountStanding,
  type SandboxJwtCheck,
} from 'pyric/sandbox/internal';
import { isNonEmptyString, isNonNullPlainRecord } from './preflight-validation.js';
import { checkClientIdToken } from './token-decoders.js';
import type { DecodedIdToken } from './types.js';
import {
  FirebaseAuthError,
  reportModeMismatch,
  sandboxLabel,
  userNotFound,
  type IdTokenExpectation,
} from './verify-token.js';

export const SESSION_COOKIE_ISSUER_PREFIX = 'https://session.firebase.google.com/';
const SESSION_COOKIE_KID = 'pyric-sandbox';
const SESSION_COOKIE_SIGNING_KEY = 'pyric-sandbox-session-cookie-signing-key';
const SESSION_COOKIE_HEADER = { alg: 'RS256', kid: SESSION_COOKIE_KID, typ: 'JWT' } as const;

const MIN_SESSION_COOKIE_DURATION_SEC = 5 * 60;
const MAX_SESSION_COOKIE_DURATION_SEC = 14 * 24 * 60 * 60;
const MAX_SUBJECT_LENGTH = 128;
const MODE_MISMATCH = 'PYRIC_MODE_MISMATCH';

const DOCS =
  ' See https://firebase.google.com/docs/auth/admin/manage-cookies for details on how to retrieve a session cookie.';
const PROJECT_MATCH =
  ' Make sure the session cookie comes from the same Firebase project as the service account used to authenticate this SDK.';
const NOT_A_STRING =
  'First argument to verifySessionCookie() must be a Firebase session cookie string.';
const INVALID_DURATION_MESSAGE =
  'The session cookie duration must be a valid number in milliseconds between 5 minutes and 2 weeks.';
const INVALID_ID_TOKEN_MESSAGE = 'The provided ID token is not a valid Firebase ID token.';
const EXPIRED_ID_TOKEN_MESSAGE = 'The provided Firebase ID token is expired.';

const MESSAGES = {
  decode: `Decoding Firebase session cookie failed. Make sure you passed the entire string JWT which represents a session cookie.${DOCS}`,
  customToken: `verifySessionCookie() expects a session cookie, but was given a custom token.${DOCS}`,
  legacyCustomToken: `verifySessionCookie() expects a session cookie, but was given a legacy custom token.${DOCS}`,
  noKid: `Firebase session cookie has no "kid" claim.${DOCS}`,
  algorithm: (alg: unknown) =>
    `Firebase session cookie has incorrect algorithm. Expected "RS256" but got "${String(alg)}".${DOCS}`,
  audience: (projectId: string, aud: unknown) =>
    `Firebase session cookie has incorrect "aud" (audience) claim. Expected "${projectId}" but got "${String(aud)}".${PROJECT_MATCH}${DOCS}`,
  issuer: (projectId: string, iss: unknown) =>
    `Firebase session cookie has incorrect "iss" (issuer) claim. Expected "${SESSION_COOKIE_ISSUER_PREFIX}${projectId}" but got "${String(iss)}".${PROJECT_MATCH}${DOCS}`,
  noSub: `Firebase session cookie has no "sub" (subject) claim.${DOCS}`,
  emptySub: `Firebase session cookie has an empty "sub" (subject) claim.${DOCS}`,
  longSub: `Firebase session cookie has a "sub" (subject) claim longer than 128 characters.${DOCS}`,
  unknownKid:
    'Firebase session cookie has "kid" claim which does not correspond to a known public key. Most likely the session cookie is expired, so get a fresh token from your client app and try again.',
  signature: `Firebase session cookie has invalid signature.${DOCS}`,
  modeMismatch: (sandbox: string, projectId: string) =>
    `This backend runs on a pyric sandbox (${sandbox}), and the request carries a session cookie production issued for ${projectId}. ` +
    'Start this backend under @pyric/live/register for live mode, or sign in on the sandbox page.',
  expired: `Firebase session cookie has expired. Get a fresh session cookie from your client app and try again (auth/session-cookie-expired).${DOCS}`,
};

type Claims = Readonly<Record<string, unknown>>;

type SessionCookieFailureCode = 'argument-error' | 'session-cookie-expired';

type SessionCookieVerdict =
  | { ok: true; token: DecodedIdToken }
  | { ok: false; code: SessionCookieFailureCode; message: string; pyricCode?: typeof MODE_MISMATCH };

export interface CreateSessionCookieDeps {
  readonly projectId: string;
  readonly readNowMs: () => Promise<number>;
  readonly readStanding: (uid: string) => Promise<AuthAccountStanding>;
}

function refused(message: string): SessionCookieVerdict {
  return { ok: false, code: 'argument-error', message };
}

function isLegacyCustomToken(header: Claims, claims: Claims): boolean {
  const legacyData = claims.d;
  return (
    header.alg === 'HS256' &&
    claims.v === 0 &&
    typeof legacyData === 'object' &&
    legacyData !== null &&
    'uid' in legacyData
  );
}

function missingKidMessage(header: Claims, claims: Claims): string {
  if (claims.aud === CUSTOM_TOKEN_AUDIENCE) return MESSAGES.customToken;
  if (isLegacyCustomToken(header, claims)) return MESSAGES.legacyCustomToken;
  return MESSAGES.noKid;
}

function skipsSubjectCheck(claims: Claims): boolean {
  return claims.event_type === 'beforeSendSms' || claims.event_type === 'beforeSendEmail';
}

function subjectMessage(sub: unknown): string | undefined {
  if (typeof sub !== 'string') return MESSAGES.noSub;
  if (sub === '') return MESSAGES.emptySub;
  if (sub.length > MAX_SUBJECT_LENGTH) return MESSAGES.longSub;
  return undefined;
}

function contentMessage(header: Claims, claims: Claims, projectId: string): string | undefined {
  if (header.kid === undefined) return missingKidMessage(header, claims);
  if (header.alg !== 'RS256') return MESSAGES.algorithm(header.alg);
  if (claims.aud !== projectId) return MESSAGES.audience(projectId, claims.aud);
  if (claims.iss !== `${SESSION_COOKIE_ISSUER_PREFIX}${projectId}`) {
    return MESSAGES.issuer(projectId, claims.iss);
  }
  if (skipsSubjectCheck(claims)) return undefined;
  return subjectMessage(claims.sub);
}

function isNotYetValid(nbf: unknown, nowSec: number): boolean {
  if (nbf === undefined) return false;
  return typeof nbf !== 'number' || !Number.isFinite(nbf) || !Number.isFinite(nowSec) || nbf > nowSec;
}

function expiryVerdict(exp: unknown, nowSec: number): SessionCookieVerdict | undefined {
  if (exp === undefined) return undefined;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || !Number.isFinite(nowSec)) {
    return refused(MESSAGES.signature);
  }
  if (nowSec >= exp) {
    return { ok: false, code: 'session-cookie-expired', message: MESSAGES.expired };
  }
  return undefined;
}

function isProductionSessionCookie(header: Claims, claims: Claims): boolean {
  if (header.alg !== 'RS256') return false;
  if (typeof header.kid !== 'string' || header.kid.length === 0) return false;
  if (header.kid === SESSION_COOKIE_KID) return false;
  if (typeof claims.iss !== 'string') return false;
  return (
    claims.iss.startsWith(SESSION_COOKIE_ISSUER_PREFIX) &&
    claims.iss.length > SESSION_COOKIE_ISSUER_PREFIX.length
  );
}

function unknownKeyVerdict(
  header: Claims,
  claims: Claims,
  projectId: string,
  sandbox: string,
): SessionCookieVerdict {
  if (!isProductionSessionCookie(header, claims)) {
    return refused(MESSAGES.unknownKid);
  }
  return {
    ok: false,
    code: 'argument-error',
    message: MESSAGES.modeMismatch(sandbox, projectId),
    pyricCode: MODE_MISMATCH,
  };
}

/**
 * Decodes and checks the sandbox signature of a session cookie JWT.
 */
export function checkSandboxSessionCookieJwt(sessionCookie: string): Promise<SandboxJwtCheck> {
  return checkSandboxJwt(sessionCookie, {
    kid: SESSION_COOKIE_KID,
    key: SESSION_COOKIE_SIGNING_KEY,
  });
}

async function checkClientSessionCookie(
  sessionCookie: string,
  projectId: string,
  nowSec: number,
  sandbox: string,
): Promise<SessionCookieVerdict> {
  const check = await checkSandboxSessionCookieJwt(sessionCookie);
  if (!check.ok && check.reason === 'malformed') return refused(MESSAGES.decode);
  const contentFailure = contentMessage(check.header, check.claims, projectId);
  if (contentFailure !== undefined) return refused(contentFailure);
  if (!check.ok && check.reason === 'kid') {
    return unknownKeyVerdict(check.header, check.claims, projectId, sandbox);
  }
  if (!check.ok) return refused(MESSAGES.signature);
  if (isNotYetValid(check.claims.nbf, nowSec)) return refused(MESSAGES.signature);
  const expired = expiryVerdict(check.claims.exp, nowSec);
  if (expired !== undefined) return expired;
  const token = { ...check.claims, uid: check.claims.sub } as DecodedIdToken;
  return { ok: true, token };
}

/**
 * Throws `auth/argument-error` synchronously when `sessionCookie` is not a
 * string, matching `firebase-admin`'s `FirebaseTokenVerifier.verifyJWT`.
 */
export function assertSessionCookieArgument(sessionCookie: unknown): void {
  if (typeof sessionCookie !== 'string') {
    throw new FirebaseAuthError('argument-error', NOT_A_STRING);
  }
}

/**
 * Verifies a sandbox session cookie JWT for `expected.projectId` at `expected.nowMs`.
 */
export function verifySandboxSessionCookie(
  sessionCookie: string,
  expected: IdTokenExpectation,
): Promise<DecodedIdToken> {
  assertSessionCookieArgument(sessionCookie);
  if (typeof expected.projectId !== 'string' || expected.projectId.length === 0) {
    return Promise.reject(
      new FirebaseAuthError(
        'internal-error',
        'verifySandboxSessionCookie expected a non-empty projectId.',
      ),
    );
  }
  if (typeof expected.nowMs !== 'number' || !Number.isFinite(expected.nowMs)) {
    return Promise.reject(
      new FirebaseAuthError(
        'internal-error',
        'verifySandboxSessionCookie expected a finite epoch timestamp in milliseconds.',
      ),
    );
  }
  const nowSec = Math.floor(expected.nowMs / 1000);
  return checkClientSessionCookie(sessionCookie, expected.projectId, nowSec, sandboxLabel()).then(
    (verdict) => {
      if (verdict.ok) return verdict.token;
      reportModeMismatch(verdict);
      throw new FirebaseAuthError(verdict.code, verdict.message, verdict.pyricCode);
    },
  );
}

/**
 * Runs `firebase-admin`'s exact `createSessionCookie` client preflight order:
 * 1. `sessionCookieOptions` non-null object with numeric non-NaN `expiresIn`
 * 2. `idToken` non-empty string
 * 3. `Math.floor(expiresIn / 1000)` within `[300, 1_209_600]` seconds
 */
function parseCreateSessionCookiePreflight(
  idToken: unknown,
  sessionCookieOptions: unknown,
): { idToken: string; validDurationSec: number } {
  if (
    !isNonNullPlainRecord(sessionCookieOptions) ||
    typeof sessionCookieOptions.expiresIn !== 'number' ||
    Number.isNaN(sessionCookieOptions.expiresIn)
  ) {
    throw new FirebaseAuthError('invalid-session-cookie-duration', INVALID_DURATION_MESSAGE);
  }
  if (!isNonEmptyString(idToken)) {
    throw new FirebaseAuthError('invalid-id-token', INVALID_ID_TOKEN_MESSAGE);
  }
  const validDurationSec = Math.floor(sessionCookieOptions.expiresIn / 1000);
  const durationInBounds =
    Number.isFinite(validDurationSec) &&
    validDurationSec >= MIN_SESSION_COOKIE_DURATION_SEC &&
    validDurationSec <= MAX_SESSION_COOKIE_DURATION_SEC;
  if (!durationInBounds) {
    throw new FirebaseAuthError('invalid-session-cookie-duration', INVALID_DURATION_MESSAGE);
  }
  return { idToken, validDurationSec };
}

function assertStandingEligibleForSessionCookie(
  rawClaims: Claims,
  standing: AuthAccountStanding,
): void {
  if (standing.kind === 'deleted' || standing.kind === 'unrecorded') {
    throw userNotFound();
  }
  if (standing.kind === 'disabled') {
    throw new FirebaseAuthError('user-disabled', 'The user record is disabled.');
  }
  if (standing.tokensValidAfterMs === null) {
    return;
  }
  const authTimeSec = rawClaims.auth_time;
  const isRevoked =
    typeof authTimeSec !== 'number' ||
    !Number.isFinite(authTimeSec) ||
    authTimeSec * 1000 < standing.tokensValidAfterMs;
  if (isRevoked) {
    throw new FirebaseAuthError('id-token-expired', EXPIRED_ID_TOKEN_MESSAGE);
  }
}

function buildSessionCookieClaims(
  rawClaims: Claims,
  sub: string,
  projectId: string,
  nowSec: number,
  validDurationSec: number,
): Record<string, unknown> {
  const cookieClaims: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawClaims)) {
    if (key === 'nbf') continue;
    cookieClaims[key] = value;
  }
  let userId = sub;
  if (typeof rawClaims.user_id === 'string' && rawClaims.user_id.length > 0) {
    userId = rawClaims.user_id;
  }
  let authTime = nowSec;
  if (typeof rawClaims.auth_time === 'number' && Number.isFinite(rawClaims.auth_time)) {
    authTime = rawClaims.auth_time;
  }
  cookieClaims.iss = `${SESSION_COOKIE_ISSUER_PREFIX}${projectId}`;
  cookieClaims.aud = projectId;
  cookieClaims.sub = sub;
  cookieClaims.user_id = userId;
  cookieClaims.auth_time = authTime;
  cookieClaims.iat = nowSec;
  cookieClaims.exp = nowSec + validDurationSec;
  return cookieClaims;
}

/**
 * Exchanges a valid, unexpired, non-revoked sandbox ID token for a signed
 * sandbox session cookie JWT.
 */
export async function createSandboxSessionCookie(
  idToken: unknown,
  sessionCookieOptions: unknown,
  deps: CreateSessionCookieDeps,
): Promise<string> {
  const parsed = parseCreateSessionCookiePreflight(idToken, sessionCookieOptions);
  if (typeof deps.projectId !== 'string' || deps.projectId.length === 0) {
    throw new FirebaseAuthError(
      'internal-error',
      'createSandboxSessionCookie expected a non-empty projectId.',
    );
  }
  const nowMs = await deps.readNowMs();
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new FirebaseAuthError(
      'internal-error',
      'createSandboxSessionCookie expected a finite epoch timestamp in milliseconds.',
    );
  }
  const nowSec = Math.floor(nowMs / 1000);
  const verdict = await checkClientIdToken(parsed.idToken, deps.projectId, nowSec, sandboxLabel());
  if (!verdict.ok) {
    if (verdict.code === 'id-token-expired') {
      throw new FirebaseAuthError('id-token-expired', EXPIRED_ID_TOKEN_MESSAGE);
    }
    if (verdict.pyricCode !== undefined) {
      reportModeMismatch(verdict);
      throw new FirebaseAuthError('invalid-id-token', verdict.message, verdict.pyricCode);
    }
    throw new FirebaseAuthError('invalid-id-token', INVALID_ID_TOKEN_MESSAGE);
  }
  const standing = await deps.readStanding(verdict.token.sub);
  assertStandingEligibleForSessionCookie(verdict.rawClaims, standing);
  const cookieClaims = buildSessionCookieClaims(
    verdict.rawClaims,
    verdict.token.sub,
    deps.projectId,
    nowSec,
    parsed.validDurationSec,
  );
  return signSandboxJwtSync(SESSION_COOKIE_SIGNING_KEY, { ...SESSION_COOKIE_HEADER }, cookieClaims);
}
