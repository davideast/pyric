/**
 * Sandbox App Check tokens, shared by the web mirror (`pyric/app-check`) and
 * the admin mirror (`pyric-admin/app-check`) so a token minted on either plane
 * verifies on the other, as production's do (capture
 * `app-check-admin-verify-token`, `debugExchanged`).
 *
 * Shape (captures `app-check-client-debug-get-token`,
 * `app-check-admin-create-token-shape`): a three-segment JWT, header `alg`
 * RS256, `typ` JWT, a `kid`; claims `aud`, `exp`, `iat`, `iss`, `jti`,
 * `provider`, `sub`; `iss` and `aud` name the project number from the app id.
 *
 * The signature is not RSA. It is a 256-byte SHA-256 expansion over the
 * signing input and a fixed sandbox key, the length of a real RS256
 * signature, so any edit to the header, payload, or signature fails
 * verification. It is not a security boundary: anyone can mint one.
 */
const ISSUER = 'https://firebaseappcheck.googleapis.com';
const SANDBOX_KID = 'pyric-sandbox';
const SANDBOX_KEY = 'pyric-sandbox-app-check-signing-key';
const SIGNATURE_BLOCKS = 8;

/**
 * The web SDK's stand-in when it has no token to send, such as after a
 * provider rejects: base64 of `{"error":"UNKNOWN_ERROR"}` (`formatDummyToken`
 * in `@firebase/app-check` 0.11.3). AI Logic refuses it.
 */
export const APP_CHECK_PLACEHOLDER_TOKEN = 'eyJlcnJvciI6IlVOS05PV05fRVJST1IifQ==';

export interface AppCheckIdentity {
  appId: string;
  projectId: string;
}

export interface AppCheckTokenClaims {
  sub: string;
  aud: string[];
  provider: string;
  iss: string;
  exp: number;
  iat: number;
  jti: string;
  [claim: string]: unknown;
}

export interface MintedAppCheckToken {
  token: string;
  expireTimeMillis: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** jws `JWS_REGEX`: base64url characters only, header and payload non-empty, signature optional. */
const JWS_SHAPE = /^[a-zA-Z0-9\-_]+?\.[a-zA-Z0-9\-_]+?\.([a-zA-Z0-9\-_]+)?$/;

/** A base64url segment as Latin-1 text, one character per byte, as jws reads a header (`toString('binary')`). */
function latin1FromBase64url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return atob(padded);
}

/**
 * A base64url segment as UTF-8, as jws reads a payload (`toString('utf8')`):
 * the inverse of {@link encodeJson}, with invalid bytes replaced by U+FFFD as
 * Buffer does. Uses `atob` and `TextDecoder` only, so it runs the same in a
 * browser or worker.
 */
function utf8FromBase64url(text: string): string {
  const binary = latin1FromBase64url(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8').decode(bytes);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function sandboxSignature(signingInput: string): Promise<string> {
  const blocks: Uint8Array[] = [];
  for (let block = 0; block < SIGNATURE_BLOCKS; block++) {
    const data = new TextEncoder().encode(`${block}.${SANDBOX_KEY}.${signingInput}`);
    blocks.push(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
  }
  const out = new Uint8Array(blocks.length * 32);
  blocks.forEach((bytes, index) => out.set(bytes, index * 32));
  return base64url(out);
}

/** The project number a Firebase app id carries: `1:<projectNumber>:<platform>:<hash>`. */
export function appCheckProjectNumber(appId: string): string {
  return appId.split(':')[1] ?? '';
}

export async function mintAppCheckToken(
  identity: AppCheckIdentity,
  ttlSeconds: number,
  nowMillis: number = Date.now(),
): Promise<MintedAppCheckToken> {
  const iat = Math.floor(nowMillis / 1000);
  const exp = iat + ttlSeconds;
  const projectNumber = appCheckProjectNumber(identity.appId);
  const claims: AppCheckTokenClaims = {
    sub: identity.appId,
    aud: [`projects/${projectNumber}`, `projects/${identity.projectId}`],
    provider: 'pyric-sandbox',
    iss: `${ISSUER}/${projectNumber}`,
    exp,
    iat,
    jti: randomId(),
  };
  const token = await signAppCheckToken({ alg: 'RS256', kid: SANDBOX_KID, typ: 'JWT' }, claims);
  return { token, expireTimeMillis: exp * 1000 };
}

/** Signs any header and claims with the sandbox key. Minting uses it; tests use it to build tokens production could not issue. */
export async function signAppCheckToken(header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  return `${signingInput}.${await sandboxSignature(signingInput)}`;
}

/** A decoded token's header and claims, unchecked: any field may be missing or of any type. */
export interface AppCheckTokenParts {
  header: Readonly<Record<string, unknown>>;
  claims: Readonly<Record<string, unknown>>;
}

export type AppCheckTokenCheck =
  | ({ ok: true } & AppCheckTokenParts)
  | ({ ok: false; reason: 'kid' | 'signature' } & AppCheckTokenParts)
  | { ok: false; reason: 'malformed' };

/**
 * Decodes a sandbox token and checks its key and signature, in
 * firebase-admin's order: a `kid` must name the sandbox key, and a token with
 * no `kid` is checked against it, as firebase-admin tries every key. The
 * decoded header and claims come back whenever the token decodes; `alg`,
 * audience, subject and expiry are the caller's rules.
 */
export async function checkAppCheckToken(token: string): Promise<AppCheckTokenCheck> {
  if (!JWS_SHAPE.test(token)) return { ok: false, reason: 'malformed' };
  const segments = token.split('.');
  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(latin1FromBase64url(segments[0]!));
    claims = JSON.parse(utf8FromBase64url(segments[1]!));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isJsonObject(header) || !isJsonObject(claims)) return { ok: false, reason: 'malformed' };
  const decoded = { header, claims };
  // jwt.js getKeyCallback: a falsy kid means "no kid", and every key is tried.
  const kidNamesNoKey = Boolean(header.kid) && header.kid !== SANDBOX_KID;
  if (kidNamesNoKey) return { ok: false, reason: 'kid', ...decoded };
  const expected = await sandboxSignature(`${segments[0]}.${segments[1]}`);
  if (segments[2] !== expected) return { ok: false, reason: 'signature', ...decoded };
  return { ok: true, ...decoded };
}
