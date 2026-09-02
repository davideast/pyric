/**
 * The deliberate gate on the public MCP surface. The map below is written by
 * hand: a tool or operation appears here only by decision, and the records
 * must match it exactly.
 */
import { describe, expect, it } from 'bun:test';
import { SANDBOX_OP_KEYS } from '../../src/bridge/client/dispatch.js';
import {
  DEFAULT_MCP_FORWARDED_OP_KEYS,
  DEFAULT_MCP_IN_PROCESS_OP_KEYS,
  DEFAULT_MCP_OP_KEYS,
  DEFAULT_MCP_TOOL_NAMES,
  DEFAULT_MCP_TOOL_OPS,
  getDefaultMcpToolSurface,
} from '../../src/bridge/server/mcp-contract.js';

const RATIFIED_TOOLS: Record<string, readonly string[]> = {
  firestore_simulator: ['create', 'execute', 'read', 'batch', 'add', 'undo', 'redo', 'events', 'transaction'],
  firestore_data: ['get', 'list', 'set', 'add', 'update', 'delete', 'batch_write', 'query'],
  sandbox: ['inspect', 'snapshot'],
  database_data: ['crawl', 'get', 'set', 'update', 'remove', 'push', 'transaction', 'query', 'seed'],
  database_rules: ['simulate'],
  firestore_rules: ['lint', 'simulate', 'resolve', 'test'],
  firestore_indexes: ['generate'],
  rules_stdlib: ['list', 'get'],
  storage_rules: ['resolve'],
  storage_data: ['upload', 'download', 'list', 'metadata', 'delete'],
  pyric: ['can_i_use', 'verify', 'verify_cases'],
};

const RATIFIED_FORWARDED_TOOLS = ['firestore_simulator', 'firestore_data', 'sandbox', 'database_data', 'database_rules', 'storage_data'];

describe('default MCP tool contract', () => {
  it('ratifies the exact public tools/list surface: eleven tools and their 45 ops, in order', () => {
    expect(DEFAULT_MCP_TOOL_NAMES).toEqual(Object.keys(RATIFIED_TOOLS));
    expect(DEFAULT_MCP_TOOL_OPS).toEqual(RATIFIED_TOOLS);
    expect(DEFAULT_MCP_OP_KEYS).toHaveLength(45);
    expect(DEFAULT_MCP_OP_KEYS).toEqual(
      Object.entries(RATIFIED_TOOLS).flatMap(([tool, ops]) => ops.map((op) => `${tool}.${op}`)),
    );
  });

  it('splits the ops by transport exactly as ratified', () => {
    const expectedForwarded = RATIFIED_FORWARDED_TOOLS.flatMap((tool) =>
      RATIFIED_TOOLS[tool]!.map((op) => `${tool}.${op}`),
    );
    expect(DEFAULT_MCP_FORWARDED_OP_KEYS).toEqual(expectedForwarded);
    expect(DEFAULT_MCP_IN_PROCESS_OP_KEYS).toEqual(
      DEFAULT_MCP_OP_KEYS.filter((key) => !expectedForwarded.includes(key)),
    );
  });

  it('matches the composed surface and the browser dispatcher exactly', () => {
    const tools = getDefaultMcpToolSurface();
    expect(tools.map((tool) => tool.name)).toEqual([...DEFAULT_MCP_TOOL_NAMES]);
    const keys = tools.flatMap((tool) => tool.ops.map((op) => `${tool.name}.${op.op}`));
    expect(keys).toEqual([...DEFAULT_MCP_OP_KEYS]);
    expect([...SANDBOX_OP_KEYS].sort()).toEqual([...DEFAULT_MCP_FORWARDED_OP_KEYS].sort());
  });

  it('opens the rules_stdlib description with the ratified sentence', () => {
    const stdlib = getDefaultMcpToolSurface().find((tool) => tool.name === 'rules_stdlib')!;
    expect(stdlib.description).toStartWith(
      'Firebase Security Rules standard library for Firestore and Cloud Storage',
    );
  });
});
