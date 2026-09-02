import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_MCP_OP_KEYS, DEFAULT_MCP_TOOL_NAMES } from '../src/bridge/server/mcp-contract.js';

interface ReleaseContract {
  schema: 'pyric.cli.release-contract.v1';
  commands: string[];
  exports: string[];
  removedExports: string[];
  mcpTools: string[];
  mcpOps: string[];
}

const workspaceRoot = join(import.meta.dir, '../../..');
const packageRoot = join(workspaceRoot, 'packages/cli');
const cliEntry = join(packageRoot, 'src/cli/index.ts');
const contract = JSON.parse(
  readFileSync(join(workspaceRoot, 'scripts/fixtures/cli-release-contract.json'), 'utf8'),
) as ReleaseContract;
const manifest = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as { exports: Record<string, unknown> };

function advertisedCommands(help: string): string[] {
  const section = help.split('\nCOMMANDS\n')[1]?.split('\nCORE FLAGS')[0];
  if (section === undefined) throw new Error('pyric help has no COMMANDS section');
  return section
    .split('\n')
    .filter((line) => /^  \S/.test(line))
    .map((line) => line.trim().split(/\s{2,}|\s+(?=[A-Z])/, 1)[0]!)
    .map((cell) => cell.replace(/\s+(?:\[|<).*$/, ''));
}

describe('ratified @pyric/cli release contract', () => {
  it('pins every advertised command exactly', () => {
    const result = spawnSync('bun', [cliEntry, '--help'], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(advertisedCommands(result.stdout).sort()).toEqual([...contract.commands].sort());
  });

  it('pins every retained and intentionally removed package export exactly', () => {
    const actual = Object.keys(manifest.exports);
    expect(actual.sort()).toEqual([...contract.exports].sort());
    for (const removed of contract.removedExports) expect(actual).not.toContain(removed);
  });

  it('pins the ratified nine-tool, 30-operation MCP inventory independently of its implementation', () => {
    expect(contract.mcpTools).toHaveLength(9);
    expect(contract.mcpOps).toHaveLength(30);
    expect([...DEFAULT_MCP_TOOL_NAMES].sort()).toEqual([...contract.mcpTools].sort());
    expect([...DEFAULT_MCP_OP_KEYS].sort()).toEqual([...contract.mcpOps].sort());
  });
});
