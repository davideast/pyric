/**
 * IS_LOCAL_HOST_BUILD — "this build runs on the OWNER's machine".
 *
 * True under `astro dev`, and in a PRODUCTION build compiled with
 * `PUBLIC_ENABLE_LOCAL_AUTH=1` — the flag the local Tailscale preview
 * is built with (see plans + the launchd agent). Introduced for the
 * local-credential auth path, but the semantic is broader than auth:
 * any capability that requires the server process to be the owner's
 * machine gates on this instead of bare `import.meta.env.DEV`, so the
 * phone-over-tailnet prod preview keeps owner-machine features.
 *
 * A DEPLOYED build never sets the flag, so all of these stay off
 * there. `PUBLIC_*` env vars are inlined into both client and server
 * bundles, so this constant is safe to import from either side.
 */
export const IS_LOCAL_HOST_BUILD: boolean =
  Boolean(import.meta.env.DEV) ||
  (import.meta.env as Record<string, unknown>).PUBLIC_ENABLE_LOCAL_AUTH === '1';
