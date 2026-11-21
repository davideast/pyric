/**
 * Base64 encoding and validation for Storage object bytes.
 *
 * `getDownloadURL` returns a `data:` URI, so every byte an object holds has to
 * reach a base64 string on whichever runtime the caller happens to be on.
 * Node.js and Bun expose `Buffer`; browsers and workers expose `btoa`. This
 * module is the one place that picks between them, so the SDK's
 * `getDownloadURL`, `uploadString`, and the CLI's worker-mode mirror encode
 * and decode identically.
 */
import { invalidFormat } from './errors.js';

/** Encode `buffer` as standard base64 (`+`/`/` alphabet, `=`-padded). */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Decode a `base64` or `base64url` string to bytes, throwing
 * `StorageError('invalid-format')` on alphabet mismatches or malformed padding
 * identically across `Buffer` and `atob` runtimes (matching `@firebase/storage`
 * `base64Bytes_`).
 */
export function base64ToBytes(
  encoded: string,
  format: 'base64' | 'base64url' = 'base64',
): Uint8Array {
  let normalized = encoded;
  if (format === 'base64') {
    const hasMinus = encoded.includes('-');
    const hasUnder = encoded.includes('_');
    if (hasMinus || hasUnder) {
      let invalidChar = '_';
      if (hasMinus) {
        invalidChar = '-';
      }
      throw invalidFormat(
        format,
        `Invalid character '${invalidChar}' found: is it base64url encoded?`,
      );
    }
  } else {
    const hasPlus = encoded.includes('+');
    const hasSlash = encoded.includes('/');
    if (hasPlus || hasSlash) {
      let invalidChar = '/';
      if (hasPlus) {
        invalidChar = '+';
      }
      throw invalidFormat(
        format,
        `Invalid character '${invalidChar}' found: is it base64 encoded?`,
      );
    }
    normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  }

  const stripped = normalized.replace(/[\t\n\f\r ]+/g, '');
  let body = stripped;
  if (stripped.length % 4 === 0) {
    if (stripped.endsWith('==')) {
      body = stripped.slice(0, -2);
    } else if (stripped.endsWith('=')) {
      body = stripped.slice(0, -1);
    }
  }
  if (body.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(body)) {
    throw invalidFormat(format, 'Invalid character found');
  }

  let padded = body;
  const remainder = body.length % 4;
  if (remainder === 2) {
    padded = `${body}==`;
  } else if (remainder === 3) {
    padded = `${body}=`;
  }

  if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
    return Uint8Array.from(Buffer.from(padded, 'base64'));
  }
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw invalidFormat(format, 'Invalid character found');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
