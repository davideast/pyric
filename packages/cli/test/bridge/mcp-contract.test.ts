import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { initializeSandbox } from 'pyric/sandbox';
import { SANDBOX_TOOL_NAMES, buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import {
  DEFAULT_MCP_FORWARDED_TOOL_NAMES,
  DEFAULT_MCP_IN_PROCESS_TOOL_NAMES,
  DEFAULT_MCP_RESOURCE_URIS,
  DEFAULT_MCP_TOOL_NAMES,
  getDefaultMcpToolSurface,
} from '../../src/bridge/server/mcp-contract.js';
import {
  assertFlatSchema,
  MCP_RESOURCE_CONTRACTS,
  MCP_TOOL_CONTRACTS,
} from '../../src/bridge/contract/index.js';

describe('Seam 4 & 5: Typed-Service MCP Contract & Dispatch', () => {
  it('registers the exact 12 Verb-First Action-Oriented Tools with zero legacy shims', () => {
    const expectedTools = [
      'switch_auth_identity',
      'manage_auth_users',
      'inspect_auth_flow',
      'mutate_sandbox_data',
      'query_sandbox_data',
      'manage_storage_files',
      'diagnose_rule_denial',
      'verify_security_rules',
      'dry_run_experiment',
      'control_sandbox_environment',
      'invoke_cloud_function',
      'configure_ai_mock',
    ];

    expect([...DEFAULT_MCP_TOOL_NAMES].sort()).toEqual([...expectedTools].sort());
    expect(DEFAULT_MCP_TOOL_NAMES.length).toBe(12);
    expect(MCP_TOOL_CONTRACTS.length).toBe(12);
  });

  it('registers the exact 7 pyric:// MCP Resource URI Templates', () => {
    const expectedResourceUris = [
      'pyric://sandbox/status',
      'pyric://sandbox/events',
      'pyric://firestore/docs/{path}',
      'pyric://database/tree/{path}',
      'pyric://auth/users',
      'pyric://storage/objects/{bucket}',
      'pyric://stdlib/rules/{module}',
    ];

    expect([...DEFAULT_MCP_RESOURCE_URIS].sort()).toEqual([...expectedResourceUris].sort());
    expect(DEFAULT_MCP_RESOURCE_URIS.length).toBe(7);
    expect(MCP_RESOURCE_CONTRACTS.length).toBe(7);
  });

  it('enforces schema nesting depth <= 2 and rejects z.record(...) and level 3 objects', () => {
    for (const contract of MCP_TOOL_CONTRACTS) {
      expect(() => assertFlatSchema(contract.parameters, 2)).not.toThrow();
    }

    // Reject open-ended z.record(...)
    const openRecordSchema = z.object({
      metadata: z.record(z.string()),
    });
    expect(() => assertFlatSchema(openRecordSchema, 2)).toThrow(/z\.record/);

    // Reject Level 3 object
    const level3ObjectSchema = z.object({
      level1: z.object({
        level2: z.object({
          level3: z.string(),
        }),
      }),
    });
    expect(() => assertFlatSchema(level3ObjectSchema, 2)).toThrow(/maximum nesting depth 2 exceeded/);
  });

  it('matches the browser dispatcher and live in-process handlers exactly', () => {
    const surface = getDefaultMcpToolSurface();
    expect(surface.forwarded.map((tool) => tool.name).sort()).toEqual(
      [...DEFAULT_MCP_FORWARDED_TOOL_NAMES].sort()
    );
    expect([...SANDBOX_TOOL_NAMES].sort()).toEqual(
      [...DEFAULT_MCP_FORWARDED_TOOL_NAMES].sort()
    );
    expect(surface.inProcess.map((tool) => tool.name).sort()).toEqual(
      [...DEFAULT_MCP_IN_PROCESS_TOOL_NAMES].sort()
    );
  });

  it('reads all 7 pyric:// MCP resources via buildSandboxDispatcher (Dual-Plane Parity)', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);

    const urisToRead = [
      'pyric://sandbox/status',
      'pyric://sandbox/events',
      'pyric://firestore/docs/users',
      'pyric://database/tree/root',
      'pyric://auth/users',
      'pyric://storage/objects/default',
      'pyric://stdlib/rules/math',
    ];

    for (const uri of urisToRead) {
      const res = await dispatch('resources/read', { uri });
      expect(res.ok).toBe(true);
      expect(res.data).toBeDefined();
    }
  });
});
