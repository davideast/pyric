/**
 * The two tool contracts this process holds.
 *
 * The **product surface** is what `pyric mcp` advertises: one tool per Firebase
 * service, rendered from the method records under `bridge/surface/methods/`. It
 * is what an agent sees, and `DEFAULT_MCP_TOOL_NAMES` is its `tools/list`.
 *
 * The **bridge transport surface** is the tool set a browser sandbox peer can
 * execute, plus the rules and conformance tools that run in this process. The
 * service tools dispatch onto it, and a served bridge advertises it directly to
 * the page. Its names are authored in `bridge/tool-family-records/`; a tool
 * addition or removal there is a transport contract change.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { assertExactToolNames, toolFamilies } from '../tool-families.js';
import { TOOLS } from '../surface/methods/registry.js';
import {
  getInProcessToolHandlers,
  getSandboxToolMetadata,
  type InProcessToolContext,
  type ToolMetadata,
} from './tool-metadata.js';

/** The service tools `pyric mcp` advertises, in `tools/list` order. */
export const DEFAULT_MCP_TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/** The exact tools a bridge forwards to its browser sandbox peer, in order. */
export const BRIDGE_FORWARDED_TOOL_NAMES: readonly string[] = toolFamilies('forwarded').flatMap(
  (family) => family.tools,
);

/** Local rules and conformance tools that run in this process without a peer. */
export const BRIDGE_IN_PROCESS_TOOL_NAMES: readonly string[] = toolFamilies(
  'in-process',
).flatMap((family) => family.tools);

/** The whole transport surface, forwarded families first. */
export const BRIDGE_TOOL_NAMES: readonly string[] = [
  ...BRIDGE_FORWARDED_TOOL_NAMES,
  ...BRIDGE_IN_PROCESS_TOOL_NAMES,
];

export interface BridgeToolSurface {
  forwarded: ToolMetadata[];
  inProcess: ToolHandler[];
}

/**
 * Assemble the bridge transport surface and fail closed if a factory changed
 * without a corresponding contract decision.
 *
 * `context` is handed to the in-process families; a bridge passes its own
 * consumer registry and caller identity so the `auth_*` identity tools operate
 * on the live bridge. The tool names are the same either way, so the contract
 * assertions below do not depend on it.
 */
export function getBridgeToolSurface(context?: InProcessToolContext): BridgeToolSurface {
  const forwarded = getSandboxToolMetadata();
  const inProcess = getInProcessToolHandlers(context);
  assertExactToolNames(
    'forwarded sandbox tools',
    forwarded.map((tool) => tool.name),
    BRIDGE_FORWARDED_TOOL_NAMES,
  );
  assertExactToolNames(
    'in-process tools',
    inProcess.map((tool) => tool.name),
    BRIDGE_IN_PROCESS_TOOL_NAMES,
  );
  return { forwarded, inProcess };
}
