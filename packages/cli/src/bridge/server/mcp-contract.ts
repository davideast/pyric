import type { ToolHandler } from '@inbrowser/agent';
import {
  getRulesToolHandlers,
  getSandboxToolMetadata,
  type ToolMetadata,
} from './tool-metadata.js';

/**
 * The exact tools a default local Pyric MCP server forwards to its sandbox.
 * A tool addition or removal is a public contract change and must update this
 * manifest deliberately.
 */
export const DEFAULT_MCP_FORWARDED_TOOL_NAMES = [
  'firestore_simulator_create',
  'firestore_simulator_execute',
  'firestore_simulator_read',
  'firestore_simulator_batch',
  'firestore_create_with_auto_id',
  'firestore_simulator_undo',
  'firestore_simulator_redo',
  'firestore_simulator_events',
  'firestore_simulator_transaction',
  'firestore_get_document',
  'firestore_list_documents',
  'firestore_create_document',
  'firestore_add_document',
  'firestore_update_document',
  'firestore_delete_document',
  'firestore_batch_write',
  'firestore_query_where',
  'sandbox_inspect',
  'rtdb_simulate_access',
  'rtdb_crawl_structure',
] as const;

/** Local rules tools that run in the MCP process without a browser peer. */
export const DEFAULT_MCP_IN_PROCESS_TOOL_NAMES = [
  'firestore_simulate_rules',
  'firestore_rules_stdlib_list',
  'firestore_rules_stdlib_get',
  'firestore_lint_rules',
  'firestore_resolve_modules',
] as const;

export const DEFAULT_MCP_TOOL_NAMES = [
  ...DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  ...DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
] as const;

export interface DefaultMcpToolSurface {
  forwarded: ToolMetadata[];
  inProcess: ToolHandler[];
}

function assertExactNames(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((name, index) => name !== expectedSorted[index])
  ) {
    throw new Error(
      `${label} drifted from the default MCP contract\n` +
        `expected: ${expected.join(', ')}\n` +
        `actual:   ${actual.join(', ')}`,
    );
  }
}

/**
 * Assemble the default MCP surface and fail closed if a factory changed
 * without a corresponding public-contract decision.
 */
export function getDefaultMcpToolSurface(): DefaultMcpToolSurface {
  const forwarded = getSandboxToolMetadata();
  const inProcess = getRulesToolHandlers();
  assertExactNames(
    'forwarded sandbox tools',
    forwarded.map((tool) => tool.name),
    DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  );
  assertExactNames(
    'in-process rules tools',
    inProcess.map((tool) => tool.name),
    DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
  );
  return { forwarded, inProcess };
}
