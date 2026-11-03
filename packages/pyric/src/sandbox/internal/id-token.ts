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
import { checkSandboxJwt, signSandboxJwt, type SandboxJwtCheck } from './sandbox-jwt.js';

const ID_TOKEN_KID = 'pyric-sandbox';
const ID_TOKEN_KEY = 'pyric-sandbox-id-token-signing-key';
const ID_TOKEN_HEADER = { alg: 'RS256', kid: ID_TOKEN_KID, typ: 'JWT' } as const;

export type IdTokenCheck = SandboxJwtCheck;

/** Signs ID token claims with the sandbox ID token key. Callers choose every claim. */
export async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  return signSandboxJwt(ID_TOKEN_KEY, { ...ID_TOKEN_HEADER }, claims);
}

/**
 * Decodes a sandbox ID token and checks its `kid` and tag. The decoded header
 * and claims come back whenever the token decodes; `alg`, `aud`, `iss`, `sub`
 * and expiry are the caller's rules.
 */
export async function checkIdToken(token: string): Promise<IdTokenCheck> {
  return checkSandboxJwt(token, { kid: ID_TOKEN_KID, key: ID_TOKEN_KEY });
}
