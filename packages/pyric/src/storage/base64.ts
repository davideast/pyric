/**
 * Base64 encoding for object bytes.
 *
 * `getDownloadURL` returns a `data:` URI, so every byte an object holds has to
 * reach a base64 string on whichever runtime the caller happens to be on.
 * Node.js and Bun expose `Buffer`; browsers and workers expose `btoa`. This
 * module is the one place that picks between them, so the SDK's
 * `getDownloadURL` and the CLI's worker-mode mirror encode identically.
 */

/** Encode `buffer` as standard base64 (`+`/`/` alphabet, `=`-padded). */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decode standard base64 back to the bytes {@link arrayBufferToBase64} encoded. */
export function base64ToBytes(encoded: string): Uint8Array {
  if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
    return Uint8Array.from(Buffer.from(encoded, 'base64'));
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
