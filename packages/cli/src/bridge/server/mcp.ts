/**
 * MCP server assembly. Constructs an `@modelcontextprotocol/sdk` `Server`
 * that lists the folded tools and routes each call by its `op`: forwarded
 * operations dispatch into the supplied bridge, in-process operations execute
 * their handler here.
 *
 * The low-level `Server` is used rather than `McpServer` so the advertised
 * input schema is exactly the one the records compose and so validation runs
 * per operation here, returning a structured tool result instead of a
 * protocol error.
 *
 * Each call returns the bridge's `BridgeToolResult` serialised as a single
 * MCP text content block, a stable shape so skill prompts work without
 * adjustment.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { Bridge, BridgeToolResult } from './bridge.js';
import { resolveToolCall, type McpTool } from './tool-surface.js';

function toMcpResult(result: BridgeToolResult, project: string) {
  // Wrap the bridge's tool result in MCP's content envelope. Include
  // sandbox provenance + project label in a metadata block so the calling
  // agent can always tell which target the tool hit.
  const body = {
    ...result,
    _pyric: { mode: 'sandbox', project },
  };
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(body, null, 2),
      },
    ],
    isError: !result.ok,
  };
}

/**
 * Build an MCP server seeded with the supplied tool surface. Caller
 * connects the returned server to a transport (e.g.
 * StreamableHTTPServerTransport).
 */
export function buildMcpServer(bridge: Bridge, tools: readonly McpTool[]): Server {
  const server = new Server(
    { name: 'pyric', version: bridge.version },
    { capabilities: { tools: {} } },
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: 'object'; [key: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
    }
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const startedAtMs = Date.now();
    const record = (op: string, result: BridgeToolResult) =>
      bridge.recordToolEvent({
        timestamp: new Date(startedAtMs).toISOString(),
        mode: 'sandbox',
        project: bridge.project,
        tool: tool.name,
        op,
        args: rawArgs,
        result,
        durationMs: Date.now() - startedAtMs,
      });

    const call = resolveToolCall(tool, rawArgs);
    if (!call.ok) {
      record(call.op, call.result);
      return toMcpResult(call.result, bridge.project);
    }
    if (call.op.transport === 'forwarded') {
      // bridge.dispatch handles the wire round-trip and records the event.
      const result = await bridge.dispatch(tool.name, call.op.op, call.args);
      return toMcpResult(result, bridge.project);
    }
    // In-process operations are rules helpers and conformance queries that do
    // not touch real Firebase. Execute them directly and record the result.
    let result: BridgeToolResult;
    try {
      result = await call.op.execute!(call.args);
    } catch (err) {
      result = { ok: false, summary: err instanceof Error ? err.message : String(err) };
    }
    record(call.op.op, result);
    return toMcpResult(result, bridge.project);
  });

  return server;
}
