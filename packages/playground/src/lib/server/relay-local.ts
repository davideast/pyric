/** The Astro endpoints' same-origin relay for durable Playground inference. */
import { createAstroRoutes } from '@inbrowser/relay';
import { createPlaygroundRelay } from './relay';

export const localRelay = createPlaygroundRelay();

/** Astro APIRoute pair for /api/inference/job + /job/[id]/stream. */
export const { start: handleAstroStart, stream: handleAstroStream } =
  createAstroRoutes(localRelay);
