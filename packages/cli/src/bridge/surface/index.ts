/**
 * Tool-surface rendering seam.
 *
 * A surface variant renders the same operation set under different tool names
 * and parameter shapes. The headless MCP server selects one by id, from
 * `pyric mcp --surface <id>` or `PYRIC_TOOL_SURFACE`, and calls this function to
 * get the tool list it serves.
 *
 * This is a stub. It ignores the id and returns the default surface, so the
 * server behaves today exactly as it did before the seam existed. The variants
 * work replaces this file with the real renderer, which maps each variant id to
 * its rendered tools and a dispatch that resolves back to the canonical
 * operation.
 */
import { getDefaultMcpToolSurface, type DefaultMcpToolSurface } from '../server/mcp-contract.js';
import type { InProcessToolContext } from '../server/tool-metadata.js';

/**
 * Render the tool surface for `surfaceId`. `context` is handed to the
 * in-process tool families so the identity tools operate on the live bridge.
 */
export function renderSurface(
  surfaceId: string | undefined,
  context?: InProcessToolContext,
): DefaultMcpToolSurface {
  void surfaceId;
  return getDefaultMcpToolSurface(context);
}
