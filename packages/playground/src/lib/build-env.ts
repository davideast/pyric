/**
 * Build-time environment flags for the playground bundle.
 *
 * `IS_STATIC_PLAYGROUND_BUILD` is true only in the composed static-site build
 * (`scripts/site/build.ts` sets `PUBLIC_PLAYGROUND_STATIC=1` when it builds the
 * playground for the hosted Studio site). There is no `pyric dev` server and no
 * inference Cloud Function behind that deploy, so:
 *   - inference runs page-direct (BYOK) only — the resumable server-stream
 *     transport is disabled (a `GET /inference-endpoint.json` there hits the
 *     SPA rewrite and returns HTML, which is the "Unexpected token '<'" the
 *     server path would otherwise throw), and
 *   - the "Resumable server stream" settings toggle is hidden.
 *
 * `PUBLIC_`-prefixed so Astro/Vite exposes it to the client bundle (same
 * mechanism as `PUBLIC_INFERENCE_ACCESS_TOKEN`). Vite inlines the reference at
 * build time, so this is a compile-time constant, not a runtime lookup.
 */
export const IS_STATIC_PLAYGROUND_BUILD: boolean =
  import.meta.env.PUBLIC_PLAYGROUND_STATIC === '1' ||
  import.meta.env.PUBLIC_PLAYGROUND_STATIC === true;
