/**
 * Content hashing for stored object bytes.
 *
 * Uploads do not populate `md5Hash` — the sandbox leaves the field unset, a
 * divergence the storage conformance registry records. Hosts that hold
 * metadata carrying the field still need one definition of how it is derived,
 * so the digest lives here: `js-md5` (the same implementation the rules
 * simulator's `hashing.md5` uses, so no runtime-specific crypto is required)
 * encoded base64, the encoding Firebase's `FullMetadata.md5Hash` carries.
 */

import { md5 } from 'js-md5';
import { arrayBufferToBase64 } from './base64.js';

/** Base64 MD5 digest of `bytes`, shaped like `FullMetadata.md5Hash`. */
export function md5HashOfBytes(bytes: Uint8Array): string {
  return arrayBufferToBase64(md5.arrayBuffer(bytes));
}
