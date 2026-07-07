import { describe, expect, test } from 'bun:test';
import { mcpMountViolation } from './claude-agentic';
import { mcpAllowedTools } from './claude-mcp';

const allTools = mcpAllowedTools();

describe('mcpMountViolation', () => {
  test('satisfied when connected with every tool', () => {
    expect(
      mcpMountViolation({
        mcp_servers: [{ name: 'playground', status: 'connected' }],
        tools: [...allTools, 'SomethingElse'],
      }),
    ).toBeNull();
  });

  test('violated when the server is missing entirely', () => {
    expect(mcpMountViolation({ mcp_servers: [], tools: allTools })).toContain('missing');
  });

  test('violated on failed status, surfacing the SDK error detail', () => {
    const v = mcpMountViolation({
      mcp_servers: [{ name: 'playground', status: 'failed', error: 'ECONNREFUSED' }],
      tools: [],
    });
    expect(v).toContain("status 'failed'");
    expect(v).toContain('ECONNREFUSED');
  });

  test('violated when connected but tools were deferred/absent', () => {
    const v = mcpMountViolation({
      mcp_servers: [{ name: 'playground', status: 'connected' }],
      tools: allTools.slice(0, 3),
    });
    expect(v).toContain('missing from session');
    expect(v).toContain(allTools[3]!);
  });

  test('violated on an init with no fields at all', () => {
    expect(mcpMountViolation({})).not.toBeNull();
  });
});
