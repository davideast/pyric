import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MCP_TOOL_NAMES } from '../../src/bridge/server/mcp-contract.js';
import { runPackedMcpSmoke } from '../../../../scripts/packed-mcp-smoke.mjs';

const workDir = mkdtempSync(join(tmpdir(), 'pyric-mcp-stdio-'));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('pyric mcp stdio contract', () => {
  it('initializes, lists the exact contract, and executes local and sandbox tools', async () => {
    const result = await runPackedMcpSmoke({
      bin: join(import.meta.dir, '..', '..', 'dist', 'cli', 'index.js'),
      workDir,
      expectedToolNames: [...DEFAULT_MCP_TOOL_NAMES],
      quiet: true,
    });

    expect([...result.toolNames].sort()).toEqual([...DEFAULT_MCP_TOOL_NAMES].sort());
    expect(result.localCall.ok).toBe(true);
    expect(result.sandboxCall.ok).toBe(true);
  }, 30_000);
});
