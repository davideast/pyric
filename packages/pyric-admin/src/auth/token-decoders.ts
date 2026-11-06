/**
 * The ID token check behind `pyric-admin/auth` `verifyIdToken`.
 *
 * The only token that verifies is the JWT pyric's Auth mints
 * (`pyric/sandbox/internal` `mintIdToken`), checked by the shared
 * {@link checkIdToken} and then by firebase-admin 13.10.0's rules, in its
 * order (lib/auth/token-verifier.js `verifyContent` and `verifySignature`,
 * lib/utils/jwt.js, and jsonwebtoken's `nbf` and `exp`). A plain string, or
 * the client token shape from before #1836, fails to decode, and a custom
 * token is refused as one, as in production (#1949, #1952).
 */
import { checkIdToken, CUSTOM_TOKEN_AUDIENCE } from 'pyric/sandbox/internal';
import type { DecodedIdToken } from './types.js';

const ID_TOKEN_ISSUER = 'https://securetoken.google.com/';
const MAX_SUBJECT_LENGTH = 128;

const DOCS = ' See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.';
const PROJECT_MATCH = ' Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK.';

const MESSAGES = {
  decode: `Decoding Firebase ID token failed. Make sure you passed the entire string JWT which represents an ID token.${DOCS}`,
  customToken: `verifyIdToken() expects an ID token, but was given a custom token.${DOCS}`,
  legacyCustomToken: `verifyIdToken() expects an ID token, but was given a legacy custom token.${DOCS}`,
  noKid: `Firebase ID token has no "kid" claim.${DOCS}`,
  algorithm: (alg: unknown) => `Firebase ID token has incorrect algorithm. Expected "RS256" but got "${String(alg)}".${DOCS}`,
  audience: (projectId: string, aud: unknown) =>
    `Firebase ID token has incorrect "aud" (audience) claim. Expected "${projectId}" but got "${String(aud)}".${PROJECT_MATCH}${DOCS}`,
  issuer: (projectId: string, iss: unknown) =>
    `Firebase ID token has incorrect "iss" (issuer) claim. Expected "${ID_TOKEN_ISSUER}${projectId}" but got "${String(iss)}".${PROJECT_MATCH}${DOCS}`,
  noSub: `Firebase ID token has no "sub" (subject) claim.${DOCS}`,
  emptySub: `Firebase ID token has an empty "sub" (subject) claim.${DOCS}`,
  longSub: `Firebase ID token has a "sub" (subject) claim longer than 128 characters.${DOCS}`,
  unknownKid:
    'Firebase ID token has "kid" claim which does not correspond to a known public key. Most likely the ID token is expired, so get a fresh token from your client app and try again.',
  signature: `Firebase ID token has invalid signature.${DOCS}`,
  expired: `Firebase ID token has expired. Get a fresh ID token from your client app and try again (auth/id-token-expired).${DOCS}`,
};

/** The two codes an ID token check fails with. */
export type IdTokenFailureCode = 'argument-error' | 'id-token-expired';

export type IdTokenVerdict =
  | { ok: true; token: DecodedIdToken }
  | { ok: false; code: IdTokenFailureCode; message: string };

type Claims = Readonly<Record<string, unknown>>;

function refused(message: string): IdTokenVerdict {
  return { ok: false, code: 'argument-error', message };
}

/** token-verifier.js: a missing `kid` names a custom token, a legacy custom token, or neither. */
function missingKidMessage(header: Claims, claims: Claims): string {
  if (claims.aud === CUSTOM_TOKEN_AUDIENCE) return MESSAGES.customToken;
  const legacyData = claims.d;
  const isLegacyCustomToken =
    header.alg === 'HS256' && claims.v === 0 && typeof legacyData === 'object' && legacyData !== null && 'uid' in legacyData;
  if (isLegacyCustomToken) return MESSAGES.legacyCustomToken;
  return MESSAGES.noKid;
}

/** Auth blocking events with no user record, whose `sub` firebase-admin leaves unchecked. */
function skipsSubjectCheck(claims: Claims): boolean {
  return claims.event_type === 'beforeSendSms' || claims.event_type === 'beforeSendEmail';
}

function subjectMessage(sub: unknown): string | undefined {
  if (typeof sub !== 'string') return MESSAGES.noSub;
  if (sub === '') return MESSAGES.emptySub;
  if (sub.length > MAX_SUBJECT_LENGTH) return MESSAGES.longSub;
  return undefined;
}

/** token-verifier.js `verifyContent`: `kid`, `alg`, `aud`, `iss`, then `sub`; the first failure wins. */
function contentMessage(header: Claims, claims: Claims, projectId: string): string | undefined {
  if (header.kid === undefined) return missingKidMessage(header, claims);
  if (header.alg !== 'RS256') return MESSAGES.algorithm(header.alg);
  if (claims.aud !== projectId) return MESSAGES.audience(projectId, claims.aud);
  if (claims.iss !== `${ID_TOKEN_ISSUER}${projectId}`) return MESSAGES.issuer(projectId, claims.iss);
  if (skipsSubjectCheck(claims)) return undefined;
  return subjectMessage(claims.sub);
}

/** jsonwebtoken's `nbf` rule, which runs before `exp`; firebase-admin reports a failure as an invalid signature. */
function isNotYetValid(nbf: unknown, nowSec: number): boolean {
  if (nbf === undefined) return false;
  return typeof nbf !== 'number' || nbf > nowSec;
}

/** jsonwebtoken's `exp` rule: an absent `exp` never expires, and a non-number is an invalid signature. */
function expiryVerdict(exp: unknown, nowSec: number): IdTokenVerdict | undefined {
  if (exp === undefined) return undefined;
  if (typeof exp !== 'number') return refused(MESSAGES.signature);
  const hasExpired = nowSec >= exp;
  if (hasExpired) return { ok: false, code: 'id-token-expired', message: MESSAGES.expired };
  return undefined;
}

/**
 * Checks an ID token for `projectId` at `nowSec`, in firebase-admin's order:
 * decoding, the content rules, the key and signature, then `nbf` and `exp`.
 */
export async function checkClientIdToken(idToken: string, projectId: string, nowSec: number): Promise<IdTokenVerdict> {
  const check = await checkIdToken(idToken);
  if (!check.ok && check.reason === 'malformed') return refused(MESSAGES.decode);
  const contentFailure = contentMessage(check.header, check.claims, projectId);
  if (contentFailure !== undefined) return refused(contentFailure);
  if (!check.ok) return refused(check.reason === 'kid' ? MESSAGES.unknownKid : MESSAGES.signature);
  if (isNotYetValid(check.claims.nbf, nowSec)) return refused(MESSAGES.signature);
  const expired = expiryVerdict(check.claims.exp, nowSec);
  if (expired !== undefined) return expired;
  const token = { ...check.claims, uid: check.claims.sub } as DecodedIdToken;
  return { ok: true, token };
}
