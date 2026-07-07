/**
 * /api/claude-mcp — the playground workspace as an MCP server, for the
 * Claude lane's `claude -p --mcp-config` subprocess.
 *
 *   GET   health/info JSON `{ ok, server, version, tools }` — doubles
 *         as the lane's preflight probe (and the loopback-family
 *         resolver target, see the completions route).
 *   POST  MCP over streamable HTTP (stateless, JSON responses).
 *
 * Dev-only, same double gate as the claude-lane route: 404 outside
 * `astro dev`, and the deploy pipeline never ships `src/pages/api`
 * routes anyway (the Cloud Function is bundled separately; Hosting
 * uploads `dist/client/`).
 */
import type { APIRoute } from 'astro';
import { IS_LOCAL_HOST_BUILD } from '~/lib/env/local-host';
import { handleMcpPost, mcpHealth } from '~/lib/server/claude-mcp';

export const prerender = false;

function disabled(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          'The playground MCP bridge only runs on the local dev server (it hosts workspace tools for `claude -p`).',
        type: 'invalid_request_error',
        code: 'bridge_disabled',
      },
    }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );
}

export const GET: APIRoute = () => {
  if (!IS_LOCAL_HOST_BUILD) return disabled();
  return new Response(JSON.stringify(mcpHealth()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = ({ request }) => {
  if (!IS_LOCAL_HOST_BUILD) return Promise.resolve(disabled());
  return handleMcpPost(request);
};
