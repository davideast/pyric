import type { ToolHandler } from '@inbrowser/agent';
import { assertExactToolNames, toolFamilies } from '../tool-families.js';
import { MCP_RESOURCE_CONTRACTS } from '../contract/index.js';
import {
  getInProcessToolHandlers,
  getSandboxToolMetadata,
  type InProcessToolContext,
  type ToolMetadata,
} from './tool-metadata.js';

export const DEFAULT_MCP_FORWARDED_TOOL_NAMES: readonly string[] = toolFamilies(
  'forwarded'
).flatMap((family) => family.tools);

export const DEFAULT_MCP_IN_PROCESS_TOOL_NAMES: readonly string[] = toolFamilies(
  'in-process'
).flatMap((family) => family.tools);

export const DEFAULT_MCP_TOOL_NAMES: readonly string[] = [
  ...DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  ...DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
];

export const DEFAULT_MCP_RESOURCE_URIS: readonly string[] = MCP_RESOURCE_CONTRACTS.map(
  (r) => r.uriTemplate
);

export interface DefaultMcpToolSurface {
  forwarded: ToolMetadata[];
  inProcess: ToolHandler[];
}

export function getDefaultMcpToolSurface(context?: InProcessToolContext): DefaultMcpToolSurface {
  const forwarded = getSandboxToolMetadata();
  const inProcess = getInProcessToolHandlers(context);
  assertExactToolNames(
    'forwarded sandbox tools',
    forwarded.map((tool) => tool.name),
    DEFAULT_MCP_FORWARDED_TOOL_NAMES
  );
  assertExactToolNames(
    'in-process tools',
    inProcess.map((tool) => tool.name),
    DEFAULT_MCP_IN_PROCESS_TOOL_NAMES
  );
  return { forwarded, inProcess };
}
