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
 *
 * Claims-sensitivity is locked with uid AND serial held fixed (two
 * independent fresh backends, each at its first mint) in
 * `test/auth/sandbox-token-refresh.test.ts` — "token string is
 * sensitive to claims, not just the mint serial". Every other token
 * test compares mints across a serial bump (refresh, re-sign-in),
 * which alone can't distinguish "claims changed the hash" from "serial
 * changed the hash".
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
