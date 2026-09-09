/**
 * Antigravity provider.
 *
 * The CLI discovers MCP servers from `.agents/mcp_config.json` inside a directory
 * it has been given, and takes no path to the file itself. That makes it the one
 * provider that has to write into the workspace: the config goes there and the
 * workspace is the only directory `--add-dir` names, so the run's state, which
 * lives elsewhere, is not among the files the agent can open. The reasoning
 * effort is part of the model slug for this CLI, so no separate effort flag is
 * passed.
 */
import { join } from 'node:path';
import type { EvalRun, Invocation } from '../types.js';
import { serverEntry } from './server-env.js';

export const AGY_CONFIG_FILE = join('.agents', 'mcp_config.json');
/** Ceiling for one non-interactive print run, matched to the runner's own timeout. */
export const AGY_PRINT_TIMEOUT = '10m';

export function buildInvocation(run: EvalRun): Invocation {
  const entry = serverEntry(run);
  const config = {
    mcpServers: {
      pyric: {
        command: entry.command,
        args: entry.args,
        env: entry.env,
      },
    },
  };

  const command = [
    'agy',
    '-p',
    run.task.prompt,
    '--output-format',
    'stream-json',
    '--model',
    run.row.model,
    '--dangerously-skip-permissions',
    '--print-timeout',
    AGY_PRINT_TIMEOUT,
    '--add-dir',
    run.workspaceDir,
  ];

  return {
    command,
    env: {},
    files: {},
    workspaceFiles: { [AGY_CONFIG_FILE]: `${JSON.stringify(config, null, 2)}\n` },
  };
}

export default buildInvocation;
