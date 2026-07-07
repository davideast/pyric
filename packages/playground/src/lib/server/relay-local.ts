/**
 * The ASTRO endpoints' relay — the base playground relay extended with
 * the Claude lane on owner-machine builds (`IS_LOCAL_HOST_BUILD`).
 *
 * Why the Claude lane belongs on the job engine at all: the lane's
 * direct SSE route ties a multi-minute `claude` Agent SDK turn to one
 * HTTP connection — a backgrounded phone tab kills the turn dead with
 * no resume (user-hit failure, 2026-07-02). Routing it through the
 * relay gives Claude turns the same durability OpenRouter turns have:
 * the turn runs to completion server-side, events buffer in the RTDB
 * job log, and the page reattaches from its last-seen offset.
 *
 * Why a SEPARATE module from `relay.ts`: `relay.ts` is bundled into
 * the deployed Cloud Function (`scripts/build-fn.ts` inlines it), and
 * this module's imports must never reach that bundle —
 * `claude-agentic` drags in the Agent SDK + the MCP bridge, and
 * `~/lib/env/local-host` reads `import.meta.env`, which doesn't exist
 * in the plain-node function runtime. The function keeps the base
 * `relay`; only the Astro job routes import this file.
 *
 * A deployed SSR build (no local-auth flag) registers no `claude`
 * provider, so a stray `provider: 'claude'` job start fails with the
 * relay's unknown-provider error instead of spawning anything.
 */
import { createAstroRoutes } from '@inbrowser/relay';
import { IS_LOCAL_HOST_BUILD } from '~/lib/env/local-host';
import { claudeAgenticModelClient } from './claude-agentic';
import { createPlaygroundRelay } from './relay';

export const localRelay = createPlaygroundRelay(
  IS_LOCAL_HOST_BUILD
    ? { claude: ({ model }) => claudeAgenticModelClient({ model }) }
    : {},
  // Server-managed marker key: the browser sends no apiKey for the
  // Claude lane (subscription auth happens in the Agent SDK on this
  // machine); the relay requires SOME key, so it stamps this — the
  // factory above never reads it.
  IS_LOCAL_HOST_BUILD ? { claude: 'claude-subscription' } : {},
);

/** Astro APIRoute pair for /api/inference/job + /job/[id]/stream. */
export const { start: handleAstroStart, stream: handleAstroStream } =
  createAstroRoutes(localRelay);
