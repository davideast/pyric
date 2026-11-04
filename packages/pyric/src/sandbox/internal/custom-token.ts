/**
 * Sandbox custom tokens in production's shape (#1952), minted by pyric-admin
 * `createCustomToken` and the CLI, and read by pyric's `signInWithCustomToken`.
 *
 * firebase-admin 13.10.0 mints a custom token as an RS256 JWT with header
 * `{"alg":"RS256","typ":"JWT"}` and no `kid`, `aud` the identity toolkit
 * audience, `iss` and `sub` the service account's email, `iat`, an `exp` one
 * hour later, `uid`, and the developer claims under `claims` when there are
 * any (lib/auth/token-generator.js `createCustomToken`).
 *
 * The sandbox has no service account, so the issuer is a sandbox account
 * email under the minting app's project, which is how the exchange tells a
 * token from another project, and the signature is the shared sandbox signer
 * (`sandbox-jwt.ts`) under a key of its own, so a custom token never checks
 * as an ID token and an edited one fails. It is not a security boundary:
 * anyone with this source can mint a token that checks.
 */
import { JWS_SHAPE, latin1FromBase64url, sandboxSignatureSync, signSandboxJwtSync, utf8FromBase64url } from './sandbox-jwt.js';

/** The `aud` of every custom token (firebase-admin token-generator.js `FIREBASE_AUDIENCE`). */
export const CUSTOM_TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

/** A custom token's lifetime, as firebase-admin mints one (`ONE_HOUR_IN_SECONDS`). */
export const CUSTOM_TOKEN_LIFETIME_SEC = 60 * 60;

const CUSTOM_TOKEN_KEY = 'pyric-sandbox-custom-token-signing-key';
const CUSTOM_TOKEN_HEADER = { alg: 'RS256', typ: 'JWT' } as const;
const ISSUER_DOMAIN = '.iam.gserviceaccount.com';
const ISSUER_ACCOUNT = 'firebase-adminsdk-pyric@';

/** The sandbox service account email a project's custom tokens name as `iss` and `sub`. */
export function customTokenIssuer(projectId: string): string {
  return `${ISSUER_ACCOUNT}${projectId}${ISSUER_DOMAIN}`;
}

function issuerProject(iss: unknown): string | undefined {
  const isSandboxIssuer = typeof iss === 'string' && iss.startsWith(ISSUER_ACCOUNT) && iss.endsWith(ISSUER_DOMAIN);
  if (!isSandboxIssuer) return undefined;
  return iss.slice(ISSUER_ACCOUNT.length, iss.length - ISSUER_DOMAIN.length);
}

/** What one custom token asserts, and who mints it when. */
export interface CustomTokenRequest {
  uid: string;
  /** Developer claims; an empty or absent object leaves `claims` out, as firebase-admin does. Argument checks are the caller's. */
  claims?: Record<string, unknown>;
  /** The minting app's project. */
  projectId: string;
  /** The minting side's current time, in epoch milliseconds. */
  nowMs: number;
}

/** Signs a custom token in firebase-admin's shape with the sandbox custom token key. */
export function mintCustomToken(request: CustomTokenRequest): string {
  const iat = Math.floor(request.nowMs / 1000);
  const issuer = customTokenIssuer(request.projectId);
  const body: Record<string, unknown> = {
    aud: CUSTOM_TOKEN_AUDIENCE, iat, exp: iat + CUSTOM_TOKEN_LIFETIME_SEC, iss: issuer, sub: issuer, uid: request.uid,
  };
  const hasClaims = isJsonObject(request.claims) && Object.keys(request.claims).length > 0;
  if (hasClaims) body.claims = request.claims;
  return signSandboxJwtSync(CUSTOM_TOKEN_KEY, { ...CUSTOM_TOKEN_HEADER }, body);
}

/** A custom token the sandbox signed: its subject, claims, project and lifetime. */
export interface SandboxCustomToken {
  uid: string;
  claims?: Record<string, unknown>;
  projectId: string;
  /** Expiry, in epoch seconds. */
  exp: number;
}

/**
 * What {@link readCustomToken} found: `other` for a token that is not a JWT
 * for the custom token audience, `invalid` for one that is but whose
 * signature, issuer, `uid` or `exp` fails, and `signed` for a token the
 * sandbox minted.
 */
export type CustomTokenReading =
  | { kind: 'other' }
  | { kind: 'invalid' }
  | ({ kind: 'signed' } & SandboxCustomToken);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePayload(segments: string[]): Record<string, unknown> | undefined {
  try {
    const header: unknown = JSON.parse(latin1FromBase64url(segments[0] ?? ''));
    const payload: unknown = JSON.parse(utf8FromBase64url(segments[1] ?? ''));
    return isJsonObject(header) && isJsonObject(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function signedFields(payload: Record<string, unknown>): SandboxCustomToken | undefined {
  const { uid, claims, exp } = payload;
  const projectId = issuerProject(payload.iss);
  const hasSubject = typeof uid === 'string' && uid.length > 0;
  const hasExpiry = typeof exp === 'number';
  if (!hasSubject || !hasExpiry || projectId === undefined) return undefined;
  if (claims === undefined) return { uid, projectId, exp };
  if (!isJsonObject(claims)) return undefined;
  return { uid, claims, projectId, exp };
}

/**
 * Reads a custom token synchronously, so an exchange can run inside a
 * synchronous sign-in. Expiry and project are the caller's rules.
 */
export function readCustomToken(token: string): CustomTokenReading {
  if (!JWS_SHAPE.test(token)) return { kind: 'other' };
  const segments = token.split('.');
  const payload = decodePayload(segments);
  const isCustomToken = payload !== undefined && payload.aud === CUSTOM_TOKEN_AUDIENCE;
  if (!isCustomToken) return { kind: 'other' };
  const signature = sandboxSignatureSync(CUSTOM_TOKEN_KEY, `${segments[0]}.${segments[1]}`);
  if (segments[2] !== signature) return { kind: 'invalid' };
  const fields = signedFields(payload);
  if (fields === undefined) return { kind: 'invalid' };
  return { kind: 'signed', ...fields };
}
