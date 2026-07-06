/**
 * Server relay provider policy (#760 / #766).
 *
 * The SERVER relay (the Astro job routes + the deployed public
 * inference Cloud Function) may only register FIXED-ENDPOINT providers.
 * Providers whose BYOK field is a user-supplied BASE URL — `ollama` and
 * `llamaServer` — must NEVER run server-side: there the caller-controlled
 * URL is an SSRF primitive (the fetch runs with the server's network
 * reachability, e.g. the GCP metadata endpoint). Those providers stay on
 * the browser page-direct transport, where the base URL means the
 * end-user's OWN machine.
 *
 * This is the single source of truth for that policy. `relay.ts` builds
 * its providers map and asserts against it at module init;
 * `server-providers.test.ts` asserts the policy directly (no service
 * account required to import).
 */

/** Providers whose apiKey slot is a user-supplied base URL. These are an
 *  SSRF risk if run server-side and are page-direct ONLY. */
export const USER_BASE_URL_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'llamaServer']);

/** True if `key` names a provider that must never be registered in a
 *  server relay. */
export function isUserBaseUrlProvider(key: string): boolean {
  return USER_BASE_URL_PROVIDERS.has(key);
}

/**
 * Throw if any provider key is a user-base-URL (SSRF-prone) provider.
 * Called on the final server relay providers map — including any
 * `extraProviders` — so a future accidental registration fails loudly at
 * module init rather than shipping an exploitable function.
 */
export function assertNoUserBaseUrlProvider(keys: Iterable<string>): void {
  const offending = [...keys].filter(isUserBaseUrlProvider);
  if (offending.length > 0) {
    throw new Error(
      `server relay must not register user-base-URL provider(s): ${offending.join(', ')}. ` +
        `These accept a caller-supplied base URL and are an SSRF risk server-side; ` +
        `keep them page-direct only (see src/lib/server/server-providers.ts, #766).`,
    );
  }
}
