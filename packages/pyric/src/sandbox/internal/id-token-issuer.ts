/**
 * Who issued an ID token (#2304): a pyric sandbox, production, or neither
 * that can be told.
 *
 * Sandbox and production ID tokens both carry
 * `iss: https://securetoken.google.com/<project>`, because sandbox tokens
 * match production's shape (#1503). They differ in the key: every sandbox
 * token's header names `kid: 'pyric-sandbox'` (`id-token.ts`), and a
 * production token's `kid` names one of Google's securetoken keys. So an
 * RS256 token with a securetoken issuer is a sandbox token when its `kid` is
 * the sandbox key id, and a production token for any other `kid`.
 *
 * Only the header and `iss` are read. There is no signature check and no
 * network, so the answer says who a token claims to come from, never that it
 * is valid. Decoding goes through the shared JWT codec (`sandbox-jwt.ts`),
 * which uses neither `Buffer` nor `atob`, so the answer is the same in a
 * browser, a worker and Node. A sandbox backend and a live backend both read
 * a token's issuer here.
 */
import { JWS_SHAPE, latin1FromBase64url, SANDBOX_JWT_KID, utf8FromBase64url } from './sandbox-jwt.js';

export type IdTokenIssuer = 'sandbox' | 'production' | 'unknown';

const SECURETOKEN_ISSUER_PREFIX = 'https://securetoken.google.com/';

interface IssuerFields {
  alg: unknown;
  kid: unknown;
  iss: unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSegment(decode: (text: string) => string, text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(decode(text));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readIssuerFields(token: string): IssuerFields | undefined {
  if (!JWS_SHAPE.test(token)) return undefined;
  const [headerSegment, claimsSegment] = token.split('.');
  const header = parseSegment(latin1FromBase64url, headerSegment!);
  const claims = parseSegment(utf8FromBase64url, claimsSegment!);
  if (!header || !claims) return undefined;
  return { alg: header.alg, kid: header.kid, iss: claims.iss };
}

function isSecuretokenIssuer(iss: unknown): boolean {
  if (typeof iss !== 'string') return false;
  const project = iss.slice(SECURETOKEN_ISSUER_PREFIX.length);
  return iss.startsWith(SECURETOKEN_ISSUER_PREFIX) && project.length > 0;
}

/**
 * Who issued `token`, read from its header's `alg` and `kid` and its `iss`
 * claim: `'sandbox'` for the sandbox key id, `'production'` for any other key
 * id, and `'unknown'` for anything that is not an RS256 securetoken ID token
 * with a key id, including a malformed string.
 */
export function idTokenIssuer(token: string): IdTokenIssuer {
  const fields = readIssuerFields(token);
  if (!fields) return 'unknown';
  const isIdTokenShape = fields.alg === 'RS256' && isSecuretokenIssuer(fields.iss);
  const hasKeyId = typeof fields.kid === 'string' && fields.kid.length > 0;
  if (!isIdTokenShape || !hasKeyId) return 'unknown';
  return fields.kid === SANDBOX_JWT_KID ? 'sandbox' : 'production';
}
