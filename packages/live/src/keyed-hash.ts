/**
 * A keyed hash for text that holds values the page never sends: a query's
 * filter values, a listener's journal key. SipHash-2-4 under a 128-bit key
 * drawn once per realm, so a hash matches another of the same text in one
 * page or process, and neither a known text and hash pair nor any number of
 * them recovers the key or lets a guessed value be checked elsewhere, which
 * a seeded FNV-1a allowed.
 *
 * Loaded in the page and in Node, with no import: the text is encoded as
 * UTF-8 here, so a realm without `TextEncoder` hashes the same bytes.
 */

const MASK_64 = 0xffffffffffffffffn;

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** 16 random bytes: the realm's `crypto.getRandomValues`, or `Math.random` where a realm has none. */
export function randomKey(): Uint8Array {
  const bytes = new Uint8Array(16);
  const crypto: unknown = Reflect.get(globalThis, 'crypto');
  const getRandomValues: unknown = isObject(crypto) ? Reflect.get(crypto, 'getRandomValues') : undefined;
  if (typeof getRandomValues === 'function') {
    Reflect.apply(getRandomValues, crypto, [bytes]);
    return bytes;
  }
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}

/** The UTF-8 bytes of `text`; a lone surrogate encodes as U+FFFD, as `TextEncoder` encodes it. */
export function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const low = isHigh ? text.charCodeAt(index + 1) : NaN;
    if (isHigh && low >= 0xdc00 && low <= 0xdfff) {
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(bytes);
}

/** The little-endian 64-bit word at `offset`, reading at most `length` bytes. */
function word(bytes: Uint8Array, offset: number, length = 8): bigint {
  let value = 0n;
  for (let index = length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]!);
  return value;
}

function rotate(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

/** SipHash-2-4 of `message` under a 16-byte `key`, as 16 lowercase hex characters. */
export function sipHash(key: Uint8Array, message: Uint8Array): string {
  const k0 = word(key, 0);
  const k1 = word(key, 8);
  const v: [bigint, bigint, bigint, bigint] = [
    k0 ^ 0x736f6d6570736575n,
    k1 ^ 0x646f72616e646f6dn,
    k0 ^ 0x6c7967656e657261n,
    k1 ^ 0x7465646279746573n,
  ];
  const round = (): void => {
    v[0] = (v[0] + v[1]) & MASK_64;
    v[1] = rotate(v[1], 13n) ^ v[0];
    v[0] = rotate(v[0], 32n);
    v[2] = (v[2] + v[3]) & MASK_64;
    v[3] = rotate(v[3], 16n) ^ v[2];
    v[0] = (v[0] + v[3]) & MASK_64;
    v[3] = rotate(v[3], 21n) ^ v[0];
    v[2] = (v[2] + v[1]) & MASK_64;
    v[1] = rotate(v[1], 17n) ^ v[2];
    v[2] = rotate(v[2], 32n);
  };
  const absorb = (m: bigint): void => {
    v[3] ^= m;
    round();
    round();
    v[0] ^= m;
  };
  const whole = message.length - (message.length % 8);
  for (let offset = 0; offset < whole; offset += 8) absorb(word(message, offset));
  const last = (BigInt(message.length & 0xff) << 56n) | word(message, whole, message.length - whole);
  absorb(last);
  v[2] ^= 0xffn;
  for (let index = 0; index < 4; index += 1) round();
  const hash = v[0] ^ v[1] ^ v[2] ^ v[3];
  return hash.toString(16).padStart(16, '0');
}

/** This realm's key: drawn once, never sent. */
const REALM_KEY = randomKey();

/** The keyed hash of `text` under this realm's key, as 16 lowercase hex characters. */
export function realmHash(text: string): string {
  return sipHash(REALM_KEY, utf8(text));
}
