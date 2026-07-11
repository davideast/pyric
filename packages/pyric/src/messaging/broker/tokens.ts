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

/** Total minted length (oracle: messaging-web-token-shape `length: 142`). */
export const TOKEN_LENGTH = 142;
/** Captured suffix prefix: the segment after the colon begins `APA91b`. */
export const TOKEN_SUFFIX_PREFIX = 'APA91b';
/** Instance-id segment length before the colon (shape-class choice, not a captured constant). */
const INSTANCE_SEGMENT_LENGTH = 22;

function randomUrlSafe(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += URL_SAFE[bytes[i]! % URL_SAFE.length];
  return out;
}

/**
 * Mint a fresh registration token in the captured shape class:
 * `<22 url-safe chars>:APA91b<113 url-safe chars>` — 142 chars total,
 * exactly one colon, fully URL-safe.
 */
export function mintToken(): string {
  const instance = randomUrlSafe(INSTANCE_SEGMENT_LENGTH);
  const suffixRandom = TOKEN_LENGTH - INSTANCE_SEGMENT_LENGTH - 1 - TOKEN_SUFFIX_PREFIX.length;
  return `${instance}:${TOKEN_SUFFIX_PREFIX}${randomUrlSafe(suffixRandom)}`;
}
