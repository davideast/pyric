/**
 * Sandbox Auth ID tokens in production's JWT shape (#1836): a three-segment
 * JWT, header `{"alg":"RS256","kid":"pyric-sandbox","typ":"JWT"}`, the
 * claims as UTF-8 JSON, and a sandbox tag.
 *
 * The tag is not an RSA signature and the key is not an RSA key. It is the
 * shared sandbox signer (`sandbox-jwt.ts`) under a key of its own, so an App
 * Check token never checks as an ID token, and any edit to the header,
 * payload, or tag fails {@link checkIdToken}. It is not a security boundary:
 * anyone with this source can mint a token that checks.
 */
import { checkSandboxJwt, SANDBOX_JWT_KID, signSandboxJwtSync, type SandboxJwtCheck } from './sandbox-jwt.js';

const ID_TOKEN_KEY = 'pyric-sandbox-id-token-signing-key';
const ID_TOKEN_HEADER = { alg: 'RS256', kid: SANDBOX_JWT_KID, typ: 'JWT' } as const;

/**
 * The project an ID token names when the minting side knows none, such as a
 * bare `getAuth(sandbox)`. No real project has this id, so its tokens fail an
 * admin app set up for a real project.
 */
export const SANDBOX_PROJECT_ID = 'pyric-sandbox';

export type IdTokenCheck = SandboxJwtCheck;

/** An ID token's lifetime, as production issues it (auth#68c: `exp - iat` is 3600). */
export const ID_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * How long before `exp` a token counts as expired and is minted again on
 * read: `TOKEN_REFRESH_BUFFER_MS` in `@firebase/auth` 1.13.6
 * (`StsTokenManager.isExpired`: `Date.now() > expirationTime - 30000`).
 */
export const TOKEN_REFRESH_BUFFER_MS = 30_000;

/**
 * Whether ID token claims are past their refresh point at `nowMs` on the
 * sandbox clock. Claims with no numeric `exp` are past it.
 */
export function isPastIdTokenRefreshPoint(claims: Record<string, unknown> | undefined, nowMs: number): boolean {
  const exp = claims?.exp;
  const hasExp = typeof exp === 'number';
  if (!hasExp) return true;
  return nowMs > exp * 1000 - TOKEN_REFRESH_BUFFER_MS;
}

/** Production's `iss` and `aud` for a project's ID tokens (capture `auth-request-auth-per-sign-in`). */
export function idTokenAudience(projectId: string): { iss: string; aud: string } {
  return { iss: `https://securetoken.google.com/${projectId}`, aud: projectId };
}

/**
 * Signs ID token claims with the sandbox ID token key, synchronously, so a
 * sign-in can mint inside its own transition. Callers choose every claim.
 *
 * `mint` numbers one mint among others with the same claims: two forced
 * refreshes in the same second carry the same `iat`, and production still
 * returns two different strings (capture `auth-getidtoken-force-refresh`).
 * It rides in the header as `pyric_mint`, which no claim reader sees.
 */
export function mintIdToken(claims: Record<string, unknown>, mint?: number): string {
  const header: Record<string, unknown> = { ...ID_TOKEN_HEADER };
  if (mint !== undefined) header.pyric_mint = mint;
  return signSandboxJwtSync(ID_TOKEN_KEY, header, claims);
}

/** {@link mintIdToken} without a mint number, for callers that await a token. */
export async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  return mintIdToken(claims);
}

/**
 * Decodes a sandbox ID token and checks its `kid` and tag. The decoded header
 * and claims come back whenever the token decodes; `alg`, `aud`, `iss`, `sub`
 * and expiry are the caller's rules.
 */
export async function checkIdToken(token: string): Promise<IdTokenCheck> {
  return checkSandboxJwt(token, { kid: SANDBOX_JWT_KID, key: ID_TOKEN_KEY });
}
