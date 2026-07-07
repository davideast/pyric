/**
 * /api/claude-mcp/workspace — snapshot transfer between the BROWSER
 * workspace (OPFS VFS, source of truth between turns) and the SERVER
 * workspace `claude -p` operates on through the MCP bridge.
 *
 *   PUT  { files: [{ path, content }] }  — seed/replace the server
 *        workspace before a tools turn (browser → server).
 *   GET  → same shape — read the result after the turn (server →
 *        browser; the client applies it as a diff, deletions included).
 *
 * Dev-only; see /api/claude-mcp for the gating story. Single-user by
 * construction (one dev server, one browser session) — no locking.
 */
import type { APIRoute } from 'astro';
import { IS_LOCAL_HOST_BUILD } from '~/lib/env/local-host';
import {
  replaceServerWorkspace,
  snapshotServerWorkspace,
  type WorkspaceSnapshot,
} from '~/lib/server/claude-mcp';

export const prerender = false;

function jsonError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: 'invalid_request_error', code } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

export const GET: APIRoute = async () => {
  if (!IS_LOCAL_HOST_BUILD) return jsonError(404, 'bridge_disabled', 'Dev server only.');
  const snapshot = await snapshotServerWorkspace();
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PUT: APIRoute = async ({ request }) => {
  if (!IS_LOCAL_HOST_BUILD) return jsonError(404, 'bridge_disabled', 'Dev server only.');
  let body: WorkspaceSnapshot;
  try {
    body = (await request.json()) as WorkspaceSnapshot;
  } catch {
    return jsonError(400, 'invalid_json', 'Body must be JSON: { files: [{ path, content }] }.');
  }
  if (!Array.isArray(body?.files)) {
    return jsonError(400, 'invalid_snapshot', 'Body must carry a `files` array.');
  }
  await replaceServerWorkspace(body);
  return new Response(JSON.stringify({ ok: true, count: body.files.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
