/**
 * Claude Code provider.
 *
 * The MCP server is passed as a config file rather than through the user's own
 * settings, and `--strict-mcp-config` keeps every other configured server out of
 * the run, so the surface under test is the only one the model can see.
 *
 * The config file's top-level key has been spelled both ways across releases, so
 * both are written. A server block is small and an unrecognized top-level key is
 * ignored, which costs nothing and removes a version dependency from the eval.
 */
import { join } from 'node:path';
import type { EvalRun, Invocation } from '../types.js';
import { runEnv, serverEntry } from './server-env.js';

/** The documented top-level key of the MCP config file, and its historical spelling. */
export const MCP_CONFIG_KEYS = ['mcpServers', 'servers'] as const;

export const MCP_CONFIG_FILE = 'mcp-config.json';

export function buildInvocation(run: EvalRun): Invocation {
  const entry = serverEntry(run);
  const server = {
    type: 'stdio',
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };
  const config: Record<string, unknown> = {};
  for (const key of MCP_CONFIG_KEYS) {
    config[key] = { pyric: server };
  }

  const configPath = join(run.dir, MCP_CONFIG_FILE);
  const command = [
    'claude',
    '-p',
    run.task.prompt,
    '--output-format',
    'stream-json',
    // Print mode refuses stream-json without it.
    '--verbose',
    '--model',
    run.row.model,
  ];
  const effort = run.row.effort;
  if (effort !== undefined) {
    command.push('--effort', effort);
  }
  command.push(
    '--max-turns',
    '25',
    '--permission-mode',
    'dontAsk',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__pyric__*',
  );
  // `mcp-only` withdraws the agent's built-in tools, so the only way to touch
  // the sandbox is the surface under test.
  if (run.row.condition === 'mcp-only') {
    command.push('--tools', '');
  }

  return {
    command,
    // The run's own variables ride on the CLI process, which the MCP server it
    // spawns inherits, so no path to the state directory appears in any file.
    env: runEnv(run),
    // `--mcp-config` takes a path, so the config lives in the run directory and
    // the workspace the agent is started in stays empty.
    files: { [MCP_CONFIG_FILE]: `${JSON.stringify(config, null, 2)}\n` },
    workspaceFiles: {},
  };
}

export default buildInvocation;
