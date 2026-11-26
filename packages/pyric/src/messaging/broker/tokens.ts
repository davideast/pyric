/**
 * Registration-token minting — the captured shape class, not captured
 * values (token values are prod noise, dropped by the oracle).
 *
 * oracle: `messaging-web-token-shape` pins minted production tokens as
 * 142 chars, colon-separated, URL-safe, with the post-colon suffix
 * beginning `APA91b`. `messaging-web-token-stability` pins that a second
 * `getToken` on the same service-worker registration returns the SAME
 * token — stability is per registration, handled by the broker's
 * registration map (`token lifecycle` in broker.ts), not here.
 */

const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const FID_FIRST_CHARS = 'cdef';

/** Total minted length (oracle: messaging-web-token-shape `length: 142`). */
export const TOKEN_LENGTH = 142;
/** Captured suffix prefix: the segment after the colon begins `APA91b`. */
export const TOKEN_SUFFIX_PREFIX = 'APA91b';
/** Firebase Installation ID length (`@firebase/installations` `generateFid`). */
export const FID_LENGTH = 22;
/** Shape of a 22-char URL-safe Firebase Installation ID (`0b0111xxxx` prefix -> `[c-f]`). */
export const FID_SHAPE_RE = /^[c-f][A-Za-z0-9_-]{21}$/;
/** Instance-id segment length before the colon (shape-class choice, not a captured constant). */
const INSTANCE_SEGMENT_LENGTH = 22;

function randomUrlSafe(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    out += URL_SAFE[byte % URL_SAFE.length];
  }
  return out;
}

/**
 * Mint a fresh registration token in the captured shape class:
 * `<22 url-safe chars>:APA91b<113 url-safe chars>` -- 142 chars total,
 * exactly one colon, fully URL-safe.
 */
export function mintToken(): string {
  const instance = randomUrlSafe(INSTANCE_SEGMENT_LENGTH);
  const suffixRandom = TOKEN_LENGTH - INSTANCE_SEGMENT_LENGTH - 1 - TOKEN_SUFFIX_PREFIX.length;
  return `${instance}:${TOKEN_SUFFIX_PREFIX}${randomUrlSafe(suffixRandom)}`;
}

/**
 * Mint a Firebase Installation ID matching `@firebase/installations` `generateFid`:
 * 22 URL-safe base64 characters whose leading nibble `0111` yields `[c-f]`.
 */
export function mintFid(): string {
  const head = new Uint8Array(1);
  crypto.getRandomValues(head);
  const firstByte = head[0] ?? 0;
  const prefix = FID_FIRST_CHARS[firstByte % FID_FIRST_CHARS.length] ?? 'c';
  return `${prefix}${randomUrlSafe(FID_LENGTH - 1)}`;
}
