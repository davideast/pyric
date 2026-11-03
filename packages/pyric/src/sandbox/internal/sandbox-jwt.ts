/**
 * The JWT codec and sandbox signer shared by every sandbox token kind (App
 * Check tokens, Auth ID tokens), so each kind encodes, decodes and signs the
 * same way on every plane.
 *
 * Encoding and decoding use `atob`/`btoa` and `TextEncoder`/`TextDecoder`
 * only, never Node's `Buffer`, so a token reads the same in a browser, a
 * worker, or Node.
 *
 * The signature is not RSA. It is a 256-byte SHA-256 expansion over the
 * signing input and a fixed sandbox key, the length of a real RS256
 * signature, so any edit to the header, payload, or signature fails the
 * check. Each token kind passes its own key, so a token of one kind never
 * checks as another. It is not a security boundary: anyone can mint one.
 *
 * The digest is the rules engine's synchronous SHA-256, so an Auth ID token
 * can be minted inside a synchronous sign-in, as the token cache needs.
 */
import { sha256 } from '../../rules/simulator/hashing-builtins.js';

const SIGNATURE_BLOCKS = 8;

/** The `kid` every sandbox token kind carries; the per-kind key keeps kinds apart. */
export const SANDBOX_JWT_KID = 'pyric-sandbox';

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** jws `JWS_REGEX`: base64url characters only, header and payload non-empty, signature optional. */
export const JWS_SHAPE = /^[a-zA-Z0-9\-_]+?\.[a-zA-Z0-9\-_]+?\.([a-zA-Z0-9\-_]+)?$/;

/** A base64url segment as Latin-1 text, one character per byte, as jws reads a header (`toString('binary')`). */
export function latin1FromBase64url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return atob(padded);
}

/**
 * A base64url segment as UTF-8, as jws reads a payload (`toString('utf8')`):
 * the inverse of {@link encodeJson}, with invalid bytes replaced by U+FFFD as
 * Buffer does.
 */
export function utf8FromBase64url(text: string): string {
  const binary = latin1FromBase64url(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8').decode(bytes);
}

/** A value's JSON as UTF-8 bytes in base64url, one JWT segment. */
export function encodeJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** The sandbox signature segment for a signing input (`<header>.<payload>`) under one token kind's key, computed synchronously. */
export function sandboxSignatureSync(key: string, signingInput: string): string {
  const out = new Uint8Array(SIGNATURE_BLOCKS * 32);
  for (let block = 0; block < SIGNATURE_BLOCKS; block++) {
    out.set(sha256(new TextEncoder().encode(`${block}.${key}.${signingInput}`)), block * 32);
  }
  return base64url(out);
}

/** {@link sandboxSignatureSync} for callers that await a signature. */
export async function sandboxSignature(key: string, signingInput: string): Promise<string> {
  return sandboxSignatureSync(key, signingInput);
}

/** Signs any header and claims with one token kind's sandbox key, synchronously. */
export function signSandboxJwtSync(key: string, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const signingInput = `${encodeJson(header)}.${encodeJson(claims)}`;
  return `${signingInput}.${sandboxSignatureSync(key, signingInput)}`;
}

/** {@link signSandboxJwtSync} for callers that await a token. */
export async function signSandboxJwt(key: string, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  return signSandboxJwtSync(key, header, claims);
}

/** A decoded token's header and claims, unchecked: any field may be missing or of any type. */
export interface SandboxJwtParts {
  header: Readonly<Record<string, unknown>>;
  claims: Readonly<Record<string, unknown>>;
}

export type SandboxJwtCheck =
  | ({ ok: true } & SandboxJwtParts)
  | ({ ok: false; reason: 'kid' | 'signature' } & SandboxJwtParts)
  | { ok: false; reason: 'malformed' };

/** The key id a token kind's header names, and the key its signature uses. */
export interface SandboxSigningKey {
  kid: string;
  key: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSegments(segments: string[]): SandboxJwtParts | undefined {
  try {
    const header: unknown = JSON.parse(latin1FromBase64url(segments[0]!));
    const claims: unknown = JSON.parse(utf8FromBase64url(segments[1]!));
    if (!isJsonObject(header) || !isJsonObject(claims)) return undefined;
    return { header, claims };
  } catch {
    return undefined;
  }
}

/**
 * Decodes a sandbox token and checks its key and signature, in
 * firebase-admin's order: a `kid` must name the sandbox key, and a token with
 * no `kid` is checked against it, as firebase-admin tries every key. The
 * decoded header and claims come back whenever the token decodes; `alg`,
 * audience, subject and expiry are the caller's rules.
 */
export async function checkSandboxJwt(token: string, signing: SandboxSigningKey): Promise<SandboxJwtCheck> {
  if (!JWS_SHAPE.test(token)) return { ok: false, reason: 'malformed' };
  const segments = token.split('.');
  const decoded = decodeSegments(segments);
  if (!decoded) return { ok: false, reason: 'malformed' };
  // jwt.js getKeyCallback: a falsy kid means "no kid", and every key is tried.
  const kidNamesNoKey = Boolean(decoded.header.kid) && decoded.header.kid !== signing.kid;
  if (kidNamesNoKey) return { ok: false, reason: 'kid', ...decoded };
  const expected = await sandboxSignature(signing.key, `${segments[0]}.${segments[1]}`);
  if (segments[2] !== expected) return { ok: false, reason: 'signature', ...decoded };
  return { ok: true, ...decoded };
}
