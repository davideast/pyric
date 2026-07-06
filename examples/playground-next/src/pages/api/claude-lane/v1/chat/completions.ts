/**
 * POST /api/claude-lane/v1/chat/completions — dev-only OpenAI-compatible
 * SSE surface over `@inbrowser/model`'s `claudeCodeModelClient` — the
 * Claude **Agent SDK** provider. It calls `query()` from
 * `@anthropic-ai/claude-agent-sdk` programmatically, authenticated
 * against the host's Claude Code subscription login. No `claude -p`
 * subprocess; no local link step.
 *
 * Thin wrapper: all request/stream logic lives in
 * `~/lib/server/claude-lane.ts` (unit-tested with a stubbed client).
 *
 * Two layers keep the Node-only SDK out of production:
 *   1. `enabled: IS_LOCAL_HOST_BUILD` — the handler 404s outside
 *      `astro dev`. (`astro preview` and any future SSR deploy refuse.)
 *   2. The deploy never ships this route anyway: `scripts/build-fn.ts`
 *      bundles only `functions/inference-api/src/index.ts` into the
 *      Cloud Function, and Hosting uploads `dist/client/` — the
 *      on-demand `dist/server/` routes are preview-only.
 *
 * The SDK module is lazy-imported by the provider itself
 * (`@inbrowser/model` loads `@anthropic-ai/claude-agent-sdk` on first
 * `chat()` call, not at build time). If the SDK peer dep is missing or
 * the host has no Claude Code login, the provider surfaces the SDK's own
 * error as an in-band SSE `error` line — no separate 503 path.
 */
import type { APIRoute } from 'astro';
import { IS_LOCAL_HOST_BUILD } from '~/lib/env/local-host';
import { claudeAgenticModelClient } from '~/lib/server/claude-agentic';
import { handleClaudeLaneRequest } from '~/lib/server/claude-lane';

export const prerender = false;

export const POST: APIRoute = ({ request }) =>
  handleClaudeLaneRequest(request, {
    enabled: Boolean(IS_LOCAL_HOST_BUILD),
    // AGENTIC client (subscription auth): mounts the playground MCP
    // workspace bridge IN-PROCESS so the delegated agent can actually
    // call the tools its prompt promises. No URL — deriving one from
    // `request.url` broke under the prod preview (origin came back as
    // `http://localhost`, portless) and the model ran toolless.
    // (`claudeCodeModelClient` is deliberately bare-model — using it here
    // produced fully fabricated builds; see lib/server/claude-agentic.ts.)
    createClient: (model) => claudeAgenticModelClient({ model }),
  });
