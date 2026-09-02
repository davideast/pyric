import { assertExactOpKeys, opKey, toolOps, toolRecords } from '../tool-records.js';
import { composeMcpTools, type McpTool } from './tool-surface.js';

/**
 * The exact tools a default local Pyric MCP server lists, in `tools/list`
 * order. Names and operations are authored in `bridge/tool-records/`; a tool
 * or operation addition or removal is a public contract change and must
 * update the record deliberately.
 */
export const DEFAULT_MCP_TOOL_NAMES: readonly string[] = toolRecords().map((record) => record.name);

/** Operations per tool, in record order. */
export const DEFAULT_MCP_TOOL_OPS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  toolRecords().map((record) => [record.name, Object.keys(record.ops)]),
);

/** Every `tool.op` key, in `tools/list` order then op order. */
export const DEFAULT_MCP_OP_KEYS: readonly string[] = toolOps().map((op) => opKey(op.tool, op.op));

/** Operations the bridge forwards to the browser sandbox peer. */
export const DEFAULT_MCP_FORWARDED_OP_KEYS: readonly string[] = toolOps('forwarded').map((op) =>
  opKey(op.tool, op.op),
);

/** Operations that run in the MCP process without a browser peer. */
export const DEFAULT_MCP_IN_PROCESS_OP_KEYS: readonly string[] = toolOps('in-process').map((op) =>
  opKey(op.tool, op.op),
);

/**
 * Assemble the default MCP surface and fail closed if the composed
 * operations differ from the records in either transport.
 */
export function getDefaultMcpToolSurface(): McpTool[] {
  const tools = composeMcpTools();
  const keys = (transport?: 'forwarded' | 'in-process') =>
    tools.flatMap((tool) =>
      tool.ops
        .filter((op) => !transport || op.transport === transport)
        .map((op) => opKey(tool.name, op.op)),
    );
  assertExactOpKeys('MCP tool operations', keys(), DEFAULT_MCP_OP_KEYS);
  assertExactOpKeys('forwarded sandbox operations', keys('forwarded'), DEFAULT_MCP_FORWARDED_OP_KEYS);
  assertExactOpKeys('in-process operations', keys('in-process'), DEFAULT_MCP_IN_PROCESS_OP_KEYS);
  return tools;
}
