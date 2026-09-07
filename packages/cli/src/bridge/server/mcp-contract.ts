import type { ToolHandler } from '@inbrowser/agent';
import { assertExactToolNames, toolFamilies } from '../tool-families.js';
import {
  getInProcessToolHandlers,
  getSandboxToolMetadata,
  type InProcessToolContext,
  type ToolMetadata,
} from './tool-metadata.js';

/**
 * The exact tools a default local Pyric MCP server forwards to its sandbox,
 * in `tools/list` order. Names are authored in `bridge/tool-family-records/`;
 * a tool addition or removal is a public contract change and must update the
 * family record deliberately.
 */
export const DEFAULT_MCP_FORWARDED_TOOL_NAMES: readonly string[] = toolFamilies(
  'forwarded',
).flatMap((family) => family.tools);

/** Local rules tools that run in the MCP process without a browser peer. */
export const DEFAULT_MCP_IN_PROCESS_TOOL_NAMES: readonly string[] = toolFamilies(
  'in-process',
).flatMap((family) => family.tools);

export const DEFAULT_MCP_TOOL_NAMES: readonly string[] = [
  ...DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  ...DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
];

export interface DefaultMcpToolSurface {
  forwarded: ToolMetadata[];
  inProcess: ToolHandler[];
}

/**
 * Assemble the default MCP surface and fail closed if a factory changed
 * without a corresponding public-contract decision.
 *
 * `context` is handed to the in-process families; a bridge passes its own
 * consumer registry and caller identity so the `auth_*` identity tools
 * operate on the live bridge. The tool names are the same either way, so the
 * contract assertions below do not depend on it.
 */
export function getDefaultMcpToolSurface(context?: InProcessToolContext): DefaultMcpToolSurface {
  const forwarded = getSandboxToolMetadata();
  const inProcess = getInProcessToolHandlers(context);
  assertExactToolNames(
    'forwarded sandbox tools',
    forwarded.map((tool) => tool.name),
    DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  );
  assertExactToolNames(
    'in-process tools',
    inProcess.map((tool) => tool.name),
    DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
  );
  return { forwarded, inProcess };
}
