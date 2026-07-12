/**
 * Opaque sandbox ID-token string synthesis. Pure — no backend state.
 * Extracted verbatim from `sandbox-backend.ts`; the token cache and
 * mint bookkeeping stay on the backend core, which calls this to
 * produce the string.
 */

/**
 * Opaque token string. Hash is a tiny deterministic digest over the
 * serialized claims map + a monotonic serial — enough that two
 * different claim maps for the same uid get different tokens AND
 * back-to-back refreshes for the same uid + claims also get
 * different tokens. NOT a cryptographic primitive. The
 * `sandbox-id-token-` prefix is grepable in logs.
 */
export function sandboxTokenFor(uid: string, claims: Record<string, unknown>, serial: number): string {
  let hash = 5381;
  const json = JSON.stringify(claims) + ':' + String(serial);
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `sandbox-id-token-${uid}-${hex}`;
}
