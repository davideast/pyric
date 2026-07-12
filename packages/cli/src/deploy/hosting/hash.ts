/**
 * SHA-256 → lowercase hex via `globalThis.crypto.subtle`. Built into
 * Node 20+ and every browser, so no Node/browser split is needed.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS 5.7+ models `Uint8Array<TBuffer>` as a generic; WebCrypto's
  // `BufferSource` requires `ArrayBuffer` specifically. The runtime
  // is identical — cast at the boundary.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}
