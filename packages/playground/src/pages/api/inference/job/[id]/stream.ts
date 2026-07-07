/**
 * GET /api/inference/job/[id]/stream?from={offset} — consume a job
 * as resumable SSE.
 *
 * Thin wrapper exporting the relay's Astro APIRoute. See
 * `~/pages/api/inference/job.ts` for the matching POST endpoint and
 * `~/lib/server/relay.ts` for the shared relay singleton.
 */
import { handleAstroStream } from '~/lib/server/relay-local';

export const prerender = false;
export const GET = handleAstroStream;
