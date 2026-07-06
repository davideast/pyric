/**
 * POST /api/inference/job — start a resumable inference job.
 *
 * Thin wrapper exporting the relay's Astro APIRoute. The relay
 * singleton lives in ~/lib/server/relay; it's shared with the
 * `[id]/stream.ts` page so both endpoints route through one
 * createRelay() call.
 *
 * Served on-demand under `astro dev` / `astro preview`; in production
 * the Hosting rewrite `/api/**` routes this path to the Cloud
 * Function instead. See plans/sw-inference-backgrounding-recovery.md.
 */
import { handleAstroStart } from '~/lib/server/relay-local';

export const prerender = false;
export const POST = handleAstroStart;
