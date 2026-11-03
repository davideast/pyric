/**
 * Base64url (RFC 4648 section 5, unpadded) in plain JavaScript.
 *
 * Sign-in mints an ID token inside realms that expose neither Node's
 * `Buffer` nor `btoa`/`atob` (the CLI's in-page auth entry runs in one), so
 * the JWT codec uses this one table-driven path on every runtime and a
 * token encodes and decodes identically everywhere.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE_TABLE: ReadonlyMap<string, number> = new Map([...ALPHABET].map((char, index) => [char, index]));

function sextet(text: string, index: number): number {
  const value = DECODE_TABLE.get(text[index]!);
  if (value === undefined) throw new SyntaxError(`Invalid base64url character at ${index}`);
  return value;
}

/** Bytes as unpadded base64url (`-`/`_` alphabet). */
export function encodeBase64url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const chunk = (bytes[index]! << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out += ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]!;
    if (remaining > 1) out += ALPHABET[(chunk >> 6) & 63]!;
    if (remaining > 2) out += ALPHABET[chunk & 63]!;
  }
  return out;
}

/**
 * Unpadded base64url back to bytes. Throws on a character outside the
 * alphabet or a length that leaves one dangling character, as `atob` does.
 */
export function decodeBase64url(text: string): Uint8Array {
  const danglingCharacter = text.length % 4 === 1;
  if (danglingCharacter) throw new SyntaxError('Invalid base64url length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let written = 0;
  for (let index = 0; index < text.length; index += 4) {
    const remaining = text.length - index;
    const chunk =
      (sextet(text, index) << 18) |
      (sextet(text, index + 1) << 12) |
      (remaining > 2 ? sextet(text, index + 2) << 6 : 0) |
      (remaining > 3 ? sextet(text, index + 3) : 0);
    out[written++] = (chunk >> 16) & 255;
    if (remaining > 2) out[written++] = (chunk >> 8) & 255;
    if (remaining > 3) out[written++] = chunk & 255;
  }
  return out;
}
