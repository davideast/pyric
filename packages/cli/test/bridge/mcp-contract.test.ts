import { describe, expect, it } from 'bun:test';
import { SANDBOX_TOOL_NAMES } from '../../src/bridge/client/dispatch.js';
import {
  DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
  DEFAULT_MCP_TOOL_NAMES,
  getDefaultMcpToolSurface,
} from '../../src/bridge/server/mcp-contract.js';

describe('default MCP tool contract', () => {
  it('ratifies the exact public tools/list surface', () => {
    expect(DEFAULT_MCP_TOOL_NAMES).toEqual([
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
      'firestore_simulate_rules',
      'firestore_rules_stdlib_list',
      'firestore_rules_stdlib_get',
      'firestore_lint_rules',
      'firestore_resolve_modules',
      'rules_stdlib_list',
      'rules_stdlib_get',
      'rules_resolve_modules',
      'pyric_can_i_use',
    ]);
  });

  it('matches the browser dispatcher and live in-process handlers exactly', () => {
    const surface = getDefaultMcpToolSurface();
    expect(surface.forwarded.map((tool) => tool.name).sort()).toEqual(
      [...DEFAULT_MCP_FORWARDED_TOOL_NAMES].sort(),
    );
    expect([...SANDBOX_TOOL_NAMES].sort()).toEqual(
      [...DEFAULT_MCP_FORWARDED_TOOL_NAMES].sort(),
    );
    expect(surface.inProcess.map((tool) => tool.name).sort()).toEqual(
      [...DEFAULT_MCP_IN_PROCESS_TOOL_NAMES].sort(),
    );
  });
});
