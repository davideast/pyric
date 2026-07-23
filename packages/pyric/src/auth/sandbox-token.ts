/**
 * Opaque sandbox ID-token string synthesis. Pure — no backend state.
 * Extracted verbatim from `sandbox-backend.ts`; the token cache and
 * mint bookkeeping stay on the backend core, which calls this to
 * produce the string.
 */

/**
 * Deterministic sandbox token string embedding serialized claims.
 * Includes a monotonic serial so back-to-back refreshes for the same uid + claims
 * get distinct token strings. Embedding claims after the colon allows stateless
 * verifiers (such as `pyric-admin/auth`) to decode the token without a network roundtrip.
 * NOT a cryptographic primitive. The `sandbox-id-token-` prefix is grepable in logs.
 *
 * Claims-sensitivity is locked with uid AND serial held fixed (two
 * independent fresh backends, each at its first mint) in
 * `test/auth/sandbox-token-refresh.test.ts` — "token string is
 * sensitive to claims, not just the mint serial". Every other token
 * test compares mints across a serial bump (refresh, re-sign-in).
 */
export function sandboxTokenFor(uid: string, claims: Record<string, unknown>, serial: number): string {
  const json = JSON.stringify(claims);
  return `sandbox-id-token-${uid}-${String(serial)}:${json}`;
}

